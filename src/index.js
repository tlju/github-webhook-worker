export default {
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
      // 处理业务路由 (GitHub 更新)
      if (url.pathname === "/update") {
        return await handleUpdate(request, kv);
      }

      // 处理业务路由 (Webhook)
      if (url.pathname === "/webhook") {
        return await handleWebhook(request, kv);
      }

      return jsonResponse({ error: "Not Found" }, 404);
    } catch (err) {
      console.error("Error in fetch:", err);
      return jsonResponse({ error: err.message || "Internal Error" }, 500);
    }
  },
};

//////////////////////////////////////////////////////
// 更新 GitHub 文件接口
//////////////////////////////////////////////////////
async function handleUpdate(request, kv) {
  if (request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
  const body = await safeParseRequestJSON(request);
  if (!body.content) return jsonResponse({ error: "Missing content" }, 400);

  const [owner, repo, filePath, branch, token] = await Promise.all([
    kv.get("GITHUB_OWNER"), kv.get("GITHUB_REPO"), kv.get("FILE_PATH"),
    kv.get("BRANCH"), kv.get("GH_TOKEN"),
  ]);

  if (!owner || !repo || !token) throw new Error("KV 缺失 GitHub 配置");

  const fileData = await safeGitHubRequest(
    `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}?ref=${branch || 'main'}`, token
  );

  const updateResult = await safeGitHubRequest(
    `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`, token, {
      method: "PUT",
      body: JSON.stringify({
        message: `auto update ${filePath} via Cloudflare Worker`,
        content: base64Encode(body.content),
        sha: fileData.sha, branch: branch || "main",
      }),
    }
  );
  return jsonResponse({ message: "Update successfully triggered", sha: updateResult.commit?.sha });
}

//////////////////////////////////////////////////////
// Webhook 接收接口
//////////////////////////////////////////////////////
async function handleWebhook(request, kv) {
  if (request.method !== "POST") return new Response("OK");
  const secret = await kv.get("WEBHOOK_SECRET");
  const signature = request.headers.get("x-hub-signature-256");
  const rawBody = await request.text();

  if (!(await verifySignature(rawBody, signature, secret))) return jsonResponse({ error: "Invalid signature" }, 401);

  const payload = JSON.parse(rawBody);
  if (payload.action === "completed" && payload.workflow_run) {
    return jsonResponse({
      workflow: payload.workflow_run.name, status: payload.workflow_run.status, conclusion: payload.workflow_run.conclusion
    });
  }
  return jsonResponse({ message: "Event received and verified" });
}

//////////////////////////////////////////////////////
// 工具函数
//////////////////////////////////////////////////////
async function safeGitHubRequest(url, token, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json",
      "Content-Type": "application/json", "User-Agent": "Cloudflare-Worker-Docker-Pusher",
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let data; try { data = JSON.parse(text); } catch { data = {}; }
  if (!response.ok) throw new Error(`GitHub API Error (${response.status}): ${JSON.stringify(data)}`);
  return data;
}

async function safeParseRequestJSON(request) {
  try { return JSON.parse(await request.text()); } catch { throw new Error("Invalid JSON body"); }
}

async function verifySignature(body, signature, secret) {
  if (!signature || !secret) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return `sha256=${Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('')}` === signature;
}

function base64Encode(str) {
  return btoa(Array.from(new TextEncoder().encode(str), byte => String.fromCharCode(byte)).join(""));
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}
