export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // 获取 KV 绑定
    const kv = env.DOCKER_KV;

    if (!kv) {
      return jsonResponse({ 
        error: "KV 绑定 'DOCKER_KV' 未找到", 
        detail: "请检查 Worker 控制台的 Settings -> Variables -> KV Namespace Bindings，确保 Variable name 为 DOCKER_KV" 
      }, 500);
    }

    try {
      // 1. Docker Registry 路由 (触发 Docker pull 重试)
      if (url.pathname.startsWith("/v2/")) {
        return await handleRegistry(request);
      }

      // 2. 更新 GitHub 文件接口
      if (url.pathname === "/update") {
        return await handleUpdate(request, kv);
      }

      // 3. Webhook 接收接口
      if (url.pathname === "/webhook") {
        return await handleWebhook(request, kv);
      }

      return jsonResponse({ error: "Not Found" }, 404);
    } catch (err) {
      return jsonResponse({ error: err.message || "Internal Error" }, 500);
    }
  },
};

//////////////////////////////////////////////////////
// Docker Registry 模拟逻辑 (触发 429 重试)
//////////////////////////////////////////////////////
async function handleRegistry(request) {
  const url = new URL(request.url);
  const registryHeaders = {
    "Content-Type": "application/json",
    "Docker-Distribution-API-Version": "registry/2.0",
  };

  // 响应版本检查 (GET /v2/)，必须返回 200 以引导 Docker 继续请求
  if (url.pathname === "/v2/" || url.pathname === "/v2") {
    return new Response(JSON.stringify({}), { status: 200, headers: registryHeaders });
  }

  // 响应具体拉取请求，返回 429 触发重试逻辑
  const errorPayload = {
    errors: [{
      code: "UNAVAILABLE",
      message: "Server busy, retrying in 5s...",
      detail: "Triggered by Cloudflare Worker"
    }]
  };

  return new Response(JSON.stringify(errorPayload), {
    status: 429,
    headers: {
      ...registryHeaders,
      "Retry-After": "5" // 告诉 Docker 5 秒后重试
    },
  });
}

//////////////////////////////////////////////////////
// 更新文件接口 (从 KV 获取配置)
//////////////////////////////////////////////////////
async function handleUpdate(request, kv) {
  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const body = await safeParseRequestJSON(request);
  if (!body.content) {
    return jsonResponse({ error: "Missing content" }, 400);
  }

  // 🚀 并发从 KV 获取所有配置，大幅提升响应速度
  const [owner, repo, filePath, branch, token] = await Promise.all([
    kv.get("GITHUB_OWNER"),
    kv.get("GITHUB_REPO"),
    kv.get("FILE_PATH"),
    kv.get("BRANCH"),
    kv.get("GH_TOKEN"),
  ]);

  if (!owner || !repo || !token) {
    throw new Error("KV 配置缺失，请检查 GITHUB_OWNER, GITHUB_REPO, GH_TOKEN 是否在 KV 中");
  }

  // 1️⃣ 获取目标文件当前的 SHA (GitHub API 要求)
  const fileData = await safeGitHubRequest(
    `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}?ref=${branch}`,
    token
  );

  if (!fileData.sha) {
    throw new Error("无法获取文件 SHA，请确认文件路径及 Token 权限是否正确");
  }

  // 2️⃣ 提交更新
  const updateResult = await safeGitHubRequest(
    `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`,
    token,
    {
      method: "PUT",
      body: JSON.stringify({
        message: `auto update ${filePath} via Cloudflare Worker`,
        content: base64Encode(body.content),
        sha: fileData.sha,
        branch: branch,
      }),
    }
  );

  return jsonResponse({
    message: "Update success",
    commit: updateResult.commit?.sha
  });
}

//////////////////////////////////////////////////////
// Webhook 接收接口
//////////////////////////////////////////////////////
async function handleWebhook(request, kv) {
  if (request.method !== "POST") return new Response("OK");

  const secret = await kv.get("WEBHOOK_SECRET");
  const signature = request.headers.get("x-hub-signature-256");
  const rawBody = await request.text();

  if (!(await verifySignature(rawBody, signature, secret))) {
    return jsonResponse({ error: "Invalid signature" }, 401);
  }

  const payload = JSON.parse(rawBody);
  if (payload.action === "completed" && payload.workflow_run) {
    return jsonResponse({
      workflow: payload.workflow_run.name,
      status: payload.workflow_run.status,
      conclusion: payload.workflow_run.conclusion,
      commit: payload.workflow_run.head_sha
    });
  }

  return jsonResponse({ message: "Ignored event" });
}

//////////////////////////////////////////////////////
// 工具函数封装
//////////////////////////////////////////////////////

async function safeGitHubRequest(url, token, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "cf-worker-registry-pusher",
      ...(options.headers || {}),
    },
  });

  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`GitHub 非 JSON 响应: ${text}`);
  }

  if (!response.ok) {
    throw new Error(`GitHub API Error ${response.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

async function safeParseRequestJSON(request) {
  const text = await request.text();
  try { return JSON.parse(text); } 
  catch { throw new Error("Invalid JSON body"); }
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
  const hash = Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
  return `sha256=${hash}` === signature;
}

/**
 * 现代化的 Base64 编码，安全支持 UTF-8 (中文)
 */
function base64Encode(str) {
  const bytes = new TextEncoder().encode(str);
  const binString = Array.from(bytes, byte => String.fromCharCode(byte)).join("");
  return btoa(binString);
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
