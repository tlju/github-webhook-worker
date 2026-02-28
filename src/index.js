export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // 注意：如果你的绑定名包含横杠，需使用 env["docker-image-pusher"] 这种写法
    const kv = env["docker-image-pusher"];

    if (!kv) {
      return jsonResponse({ error: "KV binding 'docker-image-pusher' not found." }, 500);
    }

    try {
      // 1. Docker Registry 路由 (无需 KV 配置即可运行，仅作重试触发)
      if (url.pathname.startsWith("/v2/")) {
        return await handleRegistry(request);
      }

      // 2. 业务路由
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

//////////////////////////////////////////////////////
// Docker Registry 逻辑 (触发 429 重试)
//////////////////////////////////////////////////////
async function handleRegistry(request) {
  const url = new URL(request.url);
  const registryHeaders = {
    "Content-Type": "application/json",
    "Docker-Distribution-API-Version": "registry/2.0",
  };

  if (url.pathname === "/v2/" || url.pathname === "/v2") {
    return new Response(JSON.stringify({}), { status: 200, headers: registryHeaders });
  }

  // 返回 429 强制 Docker 客户端重试
  return new Response(
    JSON.stringify({
      errors: [{ code: "UNAVAILABLE", message: "Triggering Docker Retry" }]
    }),
    {
      status: 429,
      headers: { ...registryHeaders, "Retry-After": "5" },
    }
  );
}

//////////////////////////////////////////////////////
// 更新文件接口 (使用 Promise.all 并发读取 KV)
//////////////////////////////////////////////////////
async function handleUpdate(request, kv) {
  if (request.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const body = await safeParseRequestJSON(request);
  if (!body.content) {
    return jsonResponse({ error: "Missing content" }, 400);
  }

  // 🚀 并发读取所有配置，减少等待时间
  const [owner, repo, filePath, branch, token] = await Promise.all([
    kv.get("GITHUB_OWNER"),
    kv.get("GITHUB_REPO"),
    kv.get("FILE_PATH"),
    kv.get("BRANCH"),
    kv.get("GH_TOKEN"),
  ]);

  if (!owner || !repo || !token) {
    throw new Error("Missing KV config: GITHUB_OWNER, GITHUB_REPO, or GH_TOKEN");
  }

  // 1️⃣ 获取文件当前 SHA
  const fileData = await safeGitHubRequest(
    `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}?ref=${branch}`,
    token
  );

  // 2️⃣ 提交更新
  const updateResult = await safeGitHubRequest(
    `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`,
    token,
    {
      method: "PUT",
      body: JSON.stringify({
        message: `auto update ${filePath} via worker`,
        content: base64Encode(body.content),
        sha: fileData.sha,
        branch: branch,
      }),
    }
  );

  return jsonResponse({ message: "Update success", commit: updateResult.commit?.sha });
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
    });
  }

  return jsonResponse({ message: "Ignored" });
}

//////////////////////////////////////////////////////
// 工具函数 (现代化与安全封装)
//////////////////////////////////////////////////////

async function safeGitHubRequest(url, token, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "cf-worker-pusher",
      ...(options.headers || {}),
    },
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`GitHub Error ${response.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

async function safeParseRequestJSON(request) {
  try { return await request.json(); } 
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
