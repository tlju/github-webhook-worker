export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const kv = env.DOCKER_KV;
    if (!kv) {
      return jsonResponse({
        error: "KV 绑定失败",
        detail: "请检查 Cloudflare 控制台是否将 Variable name 设置为 DOCKER_KV"
      }, 500);
    }

    try {
      // UI 页面
      if (url.pathname === "/ui" && request.method === "GET") {
        return htmlResponse(uiHtml());
      }

      // 更新 GitHub 文件接口
      if (url.pathname === "/update") {
        return await handleUpdate(request, kv);
      }

      // Webhook 接收接口
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

  // 可选安全：检查简单的 UPDATE_SECRET
  const expectedSecret = await kv.get("UPDATE_SECRET");
  if (expectedSecret) {
    const provided = (request.headers.get("x-update-secret") || "").trim();
    if (!provided || provided !== expectedSecret) {
      return jsonResponse({ error: "Unauthorized (missing or wrong update secret)" }, 401);
    }
  }

  const body = await safeParseRequestJSON(request);
  if (!body.content) return jsonResponse({ error: "Missing content" }, 400);

  // 简单输入过滤（限制大小，避免被滥用）
  if (typeof body.content !== "string" || body.content.length > 20000) {
    return jsonResponse({ error: "content must be a string and <= 20000 chars" }, 400);
  }

  const [owner, repo, filePath, branch, token] = await Promise.all([
    kv.get("GITHUB_OWNER"), kv.get("GITHUB_REPO"), kv.get("FILE_PATH"),
    kv.get("BRANCH"), kv.get("GH_TOKEN"),
  ]);

  if (!owner || !repo || !token || !filePath) {
    return jsonResponse({ error: "KV 缺失 GitHub 配置 (GITHUB_OWNER/GITHUB_REPO/FILE_PATH/GH_TOKEN)" }, 500);
  }

  // 获取现有文件信息（拿到 sha）
  const getUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(filePath)}${branch ? `?ref=${branch}` : ''}`;
  const fileData = await safeGitHubRequest(getUrl, token).catch(err => {
    // 如果文件不存在 (404)，允许创建新文件（sha 为空）
    if (err.message && err.message.includes("(404)")) return {};
    throw err;
  });

  const putUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(filePath)}`;

  const putBody = {
    message: body.message || `auto update ${filePath} via Cloudflare Worker`,
    content: base64Encode(body.content),
    branch: branch || "main",
  };
  if (fileData.sha) putBody.sha = fileData.sha;

  const updateResult = await safeGitHubRequest(
    putUrl, token, {
      method: "PUT",
      body: JSON.stringify(putBody),
    }
  );

  return jsonResponse({ message: "Update successfully triggered", sha: updateResult?.commit?.sha || null, raw: updateResult });
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

  let payload;
  try { payload = JSON.parse(rawBody); } catch { payload = {}; }
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
  try {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
    const hex = `sha256=${Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('')}`;
    return hex === signature;
  } catch (e) {
    console.error("verifySignature error:", e);
    return false;
  }
}

function base64Encode(str) {
  // 兼容 unicode 的 base64 编码
  try {
    return btoa(unescape(encodeURIComponent(str)));
  } catch (e) {
    // fallback: byte-wise conversion
    return btoa(Array.from(new TextEncoder().encode(str), byte => String.fromCharCode(byte)).join(''));
  }
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}

function htmlResponse(html) {
  return new Response(html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

function uiHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Docker 内容提交 - UI</title>
<style>
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,"Helvetica Neue",Arial;padding:24px;background:#f7f7fb}
  .card{background:#fff;border-radius:12px;padding:18px;max-width:720px;margin:0 auto;box-shadow:0 6px 20px rgba(0,0,0,.06)}
  textarea{width:100%;min-height:140px;padding:10px;border:1px solid #e3e6ef;border-radius:8px;font-family:monospace}
  input,button{padding:8px 12px;border-radius:8px;border:1px solid #d6d9ef}
  .row{display:flex;gap:8px;margin-top:10px}
  .hint{color:#666;font-size:13px;margin-top:8px}
  pre{background:#f3f4f8;padding:12px;border-radius:8px;overflow:auto}
</style>
</head>
<body>
  <div class="card">
    <h2>提交要下载的 Docker 内容</h2>
    <p class="hint">在下面输入要写入文件（例如每行一个镜像：<code>python:3.11-slim</code>）。提交后 Worker 将调用 GitHub API 更新你配置的 <code>FILE_PATH</code>。</p>

    <label>内容（每行一个镜像）</label>
    <textarea id="content" placeholder="例如：\npython:3.11-slim\nmyrepo/myimage:latest"></textarea>

    <label style="display:block;margin-top:8px">提交说明（可选）</label>
    <input id="message" placeholder="commit message (可选)" style="width:100%;box-sizing:border-box" />

    <div class="row">
      <button id="send">确定提交</button>
      <button id="clear">清空</button>
      <div style="flex:1"></div>
    </div>

    <p class="hint">页面会在同域直接调用 <code>/update</code>（同源请求）。如果你在 KV 中启用了 <code>UPDATE_SECRET</code>，请在 HTTP 头 <code>x-update-secret</code> 中传入该值（本页面不会自动注入该 header）。</p>

    <h3>结果</h3>
    <pre id="result">尚未提交。</pre>
  </div>

<script>
  const sendBtn = document.getElementById('send');
  const clearBtn = document.getElementById('clear');
  const resultPre = document.getElementById('result');

  sendBtn.onclick = async () => {
    const content = document.getElementById('content').value.trim();
    const message = document.getElementById('message').value.trim();
    if (!content) {
      resultPre.textContent = "请先输入内容。";
      return;
    }
    resultPre.textContent = "提交中...";

    try {
      const resp = await fetch('/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' /* 如果你启用了 UPDATE_SECRET，请自行使用浏览器 devtools 或代理添加 x-update-secret 头 */ },
        body: JSON.stringify({ content, message })
      });
      const data = await resp.json();
      if (!resp.ok) {
        resultPre.textContent = '错误: ' + (data.error || JSON.stringify(data));
      } else {
        resultPre.textContent = '成功: ' + JSON.stringify(data, null, 2);
      }
    } catch (e) {
      resultPre.textContent = '提交失败: ' + e.message;
    }
  };

  clearBtn.onclick = () => { document.getElementById('content').value = ''; document.getElementById('message').value = ''; resultPre.textContent = '已清空。'; };
</script>
</body>
</html>`;
}
