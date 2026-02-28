export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      // 1. 处理 Docker Registry 镜像加速路由 (优先级最高)
      if (url.pathname.startsWith("/v2/")) {
        return await handleRegistry(request);
      }

      // 2. 处理原有业务路由
      if (url.pathname === "/update") {
        return await handleUpdate(request, env);
      }

      if (url.pathname === "/webhook") {
        return await handleWebhook(request, env);
      }

      return jsonResponse({ error: "Not Found" }, 404);
    } catch (err) {
      return jsonResponse(
        { error: err.message || "Internal Error" },
        500
      );
    }
  },
};

//////////////////////////////////////////////////////
// Docker Registry 模拟逻辑 (触发重试)
//////////////////////////////////////////////////////
async function handleRegistry(request) {
  const url = new URL(request.url);
  const registryHeaders = {
    "Content-Type": "application/json",
    "Docker-Distribution-API-Version": "registry/2.0",
  };

  // 响应版本检查 (GET /v2/)，必须返回 200 才能引导 Docker 继续请求
  if (url.pathname === "/v2/" || url.pathname === "/v2") {
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: registryHeaders,
    });
  }

  // 对所有具体的镜像拉取请求 (Manifest/Blobs) 返回 429 触发重试
  const errorPayload = {
    errors: [
      {
        code: "UNAVAILABLE",
        message: "Resource temporarily unavailable, triggering retry mechanism",
        detail: "Simulated by Cloudflare Worker",
      },
    ],
  };

  return new Response(JSON.stringify(errorPayload), {
    status: 429, 
    headers: {
      ...registryHeaders,
      "Retry-After": "5", // 告知 Docker 5秒后重试
    },
  });
}

//////////////////////////////////////////////////////
// 更新文件接口 (已改进：动态 Message)
//////////////////////////////////////////////////////
async function handleUpdate(request, env) {
  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const body = await safeParseRequestJSON(request);
  if (!body.content) {
    return jsonResponse({ error: "Missing content" }, 400);
  }

  // 1️⃣ 获取当前文件 SHA
  const fileData = await safeGitHubRequest(
    `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${env.FILE_PATH}?ref=${env.BRANCH}`,
    env
  );

  if (!fileData.sha) {
    throw new Error("File not found or no permission");
  }

  // 2️⃣ 更新文件 (改进点：使用动态文件名作为提交信息)
  const updateResult = await safeGitHubRequest(
    `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${env.FILE_PATH}`,
    env,
    {
      method: "PUT",
      body: JSON.stringify({
        message: `auto update ${env.FILE_PATH} via worker`,
        content: base64Encode(body.content),
        sha: fileData.sha,
        branch: env.BRANCH,
      }),
    }
  );

  return jsonResponse({
    message: "Update triggered",
    commit: updateResult.commit?.sha,
  });
}

//////////////////////////////////////////////////////
// Webhook 接收接口
//////////////////////////////////////////////////////
async function handleWebhook(request, env) {
  if (request.method !== "POST") {
    return new Response("OK");
  }

  const signature = request.headers.get("x-hub-signature-256");
  const rawBody = await request.text();

  const valid = await verifySignature(
    rawBody,
    signature,
    env.KV.get('WEBHOOK_SECRET')
  );

  if (!valid) {
    return jsonResponse({ error: "Invalid signature" }, 401);
  }

  const payload = JSON.parse(rawBody);

  if (payload.action === "completed" && payload.workflow_run) {
    const run = payload.workflow_run;
    return jsonResponse({
      workflow: run.name,
      status: run.status,
      conclusion: run.conclusion,
      commit: run.head_sha,
    });
  }

  return jsonResponse({ message: "Ignored event" });
}

//////////////////////////////////////////////////////
// 工具函数封装
//////////////////////////////////////////////////////

async function safeGitHubRequest(url, env, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${env.KV.get('GH_TOKEN')}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "cloudflare-worker",
      ...(options.headers || {}),
    },
  });

  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`GitHub 返回非 JSON 响应:\n${text}`);
  }

  if (!response.ok) {
    throw new Error(`GitHub API 错误 ${response.status}:\n${JSON.stringify(data, null, 2)}`);
  }

  return data;
}

async function safeParseRequestJSON(request) {
  const text = await request.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Invalid JSON body");
  }
}

async function verifySignature(body, signature, secret) {
  if (!signature) return false;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  const hash = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `sha256=${hash}` === signature;
}

/**
 * 🚀 改进点：现代化的 Base64 编码 (替代 unescape)
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
