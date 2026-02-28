export default {
  /**
   * Worker 入口函数
   * @param {Request} request 
   * @param {object} env 环境变量，包含 KV 绑定 DOCKER_KV
   */
  async fetch(request, env) {
    const url = new URL(request.url);

    // 检查 KV 绑定是否正确
    const kv = env.DOCKER_KV;
    if (!kv) {
      return jsonResponse({ 
        error: "KV 绑定失败", 
        detail: "请检查 Cloudflare 控制台是否将 Variable name 设置为 DOCKER_KV" 
      }, 500);
    }

    try {
      // 1️⃣ 处理 Docker Registry 路由 (触发重试机制)
      if (url.pathname.startsWith("/v2/")) {
        return await handleRegistry(request);
      }

      // 2️⃣ 处理业务路由 (从 KV 读取配置)
      if (url.pathname === "/update") {
        return await handleUpdate(request, kv);
      }

      if (url.pathname === "/webhook") {
        return await handleWebhook(request, kv);
      }

      return jsonResponse({ error: "Not Found" }, 404);
    } catch (err) {
      return jsonResponse({ error: err.message || "Internal Error" }, 500);
    }
  },
};

/**
 * Docker Registry 模拟逻辑
 * 目的：让 Docker 客户端产生重试行为
 */
async function handleRegistry(request) {
  const url = new URL(request.url);
  const registryHeaders = {
    "Content-Type": "application/json",
    "Docker-Distribution-API-Version": "registry/2.0",
    "Access-Control-Allow-Origin": "*",
  };

  const path = url.pathname;

  // 1. 核心改进：更标准的版本探测响应
  if (path === "/v2" || path === "/v2/") {
    return new Response(JSON.stringify({}), { 
      status: 200, 
      headers: {
        ...registryHeaders,
        // 关键点：有些 Docker 版本要求这个头来确定认证方式
        "Www-Authenticate": "Bearer realm=\"https://auth.docker.io/token\",service=\"registry.docker.io\"",
        "Cache-Control": "no-cache"
      } 
    });
  }

  // 2. 针对所有镜像拉取路径，触发 429 重试
  // 确保处理 HEAD 请求，Docker 经常先发 HEAD
  const errorPayload = {
    errors: [{ 
      code: "TOOMANYREQUESTS", 
      message: "Simulated retry by Cloudflare Worker",
      detail: { "retry_after": 5 }
    }],
  };

  return new Response(
    request.method === "HEAD" ? null : JSON.stringify(errorPayload), 
    {
      status: 429,
      headers: {
        ...registryHeaders,
        "Retry-After": "5", 
      },
    }
  );
}

/**
 * 更新 GitHub 文件
 * 逻辑：从 KV 获取所有机密信息并执行 API 请求
 */
async function handleUpdate(request, kv) {
  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const body = await safeParseRequestJSON(request);
  if (!body.content) {
    return jsonResponse({ error: "Missing content" }, 400);
  }

  // 🚀 从 KV 中并行读取所有配置 (优化延迟)
  const [owner, repo, filePath, branch, token] = await Promise.all([
    kv.get("GITHUB_OWNER"),
    kv.get("GITHUB_REPO"),
    kv.get("FILE_PATH"),
    kv.get("BRANCH"),
    kv.get("GH_TOKEN"),
  ]);

  if (!owner || !repo || !token) {
    throw new Error("KV 配置缺失，请检查 GITHUB_OWNER, GITHUB_REPO, GH_TOKEN 是否已填入 KV");
  }

  // 1. 获取当前文件 SHA (GitHub API 要求)
  const fileData = await safeGitHubRequest(
    `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}?ref=${branch || 'main'}`,
    token
  );

  if (!fileData.sha) {
    throw new Error("无法获取文件 SHA，请检查文件路径和权限");
  }

  // 2. 更新文件内容
  const updateResult = await safeGitHubRequest(
    `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`,
    token,
    {
      method: "PUT",
      body: JSON.stringify({
        message: `auto update ${filePath} via Cloudflare Worker`,
        content: base64Encode(body.content),
        sha: fileData.sha,
        branch: branch || "main",
      }),
    }
  );

  return jsonResponse({
    message: "Update successfully triggered",
    sha: updateResult.commit?.sha
  });
}

/**
 * Webhook 接口
 * 逻辑：使用 KV 中的 secret 校验签名
 */
async function handleWebhook(request, kv) {
  if (request.method !== "POST") return new Response("OK");

  const secret = await kv.get("WEBHOOK_SECRET");
  const signature = request.headers.get("x-hub-signature-256");
  const rawBody = await request.text();

  const isValid = await verifySignature(rawBody, signature, secret);
  if (!isValid) {
    return jsonResponse({ error: "Invalid signature" }, 401);
  }

  const payload = JSON.parse(rawBody);
  // 仅演示：如果是工作流完成事件
  if (payload.action === "completed" && payload.workflow_run) {
    return jsonResponse({
      workflow: payload.workflow_run.name,
      status: payload.workflow_run.status,
      conclusion: payload.workflow_run.conclusion
    });
  }

  return jsonResponse({ message: "Event received and verified" });
}

//////////////////////////////////////////////////////
// 工具函数 (现代化实现)
//////////////////////////////////////////////////////

async function safeGitHubRequest(url, token, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "Cloudflare-Worker-Docker-Pusher",
      ...(options.headers || {}),
    },
  });

  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = {}; }

  if (!response.ok) {
    throw new Error(`GitHub API Error (${response.status}): ${JSON.stringify(data)}`);
  }
  return data;
}

async function safeParseRequestJSON(request) {
  try {
    const text = await request.text();
    return JSON.parse(text);
  } catch {
    throw new Error("Invalid JSON in request body");
  }
}

async function verifySignature(body, signature, secret) {
  if (!signature || !secret) return false;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false, ["sign"]
  );
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  const hash = Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  return `sha256=${hash}` === signature;
}

/**
 * 现代化的 Base64 编码，支持 UTF-8 字符
 */
function base64Encode(str) {
  const bytes = new TextEncoder().encode(str);
  const binString = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
  return btoa(binString);
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
