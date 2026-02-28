export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const kv = env.DOCKER_KV;

    if (!kv) {
      return new Response("KV not bound", { status: 500 });
    }

    try {
      if (url.pathname === "/login") {
        return handleLogin(request, kv);
      }

      if (url.pathname === "/logout") {
        return handleLogout();
      }

      if (url.pathname === "/ui") {
        const ok = await isAuthenticated(request, kv);
        if (!ok) return loginPage();
        return uiPage(kv);
      }

      if (url.pathname === "/update") {
        const ok = await isAuthenticated(request, kv);
        if (!ok) return json({ error: "Unauthorized" }, 401);
        return handleUpdate(request, kv);
      }

      if (url.pathname === "/webhook") {
        return handleWebhook(request, kv);
      }

      return new Response("Not Found", { status: 404 });

    } catch (err) {
      return json({ error: err.message }, 500);
    }
  }
};

//////////////////////////////////////////////////////
// 登录逻辑
//////////////////////////////////////////////////////

async function handleLogin(request, kv) {
  if (request.method !== "POST") {
    return loginPage();
  }

  const form = await request.formData();
  const username = form.get("username");
  const password = form.get("password");

  const [kvUser, kvPass, secret] = await Promise.all([
    kv.get("UI_USERNAME"),
    kv.get("UI_PASSWORD"),
    kv.get("SESSION_SECRET")
  ]);

  if (username === kvUser && password === kvPass) {
    const token = await signValue(username, secret);

    return new Response(null, {
      status: 302,
      headers: {
        "Location": "/ui",
        "Set-Cookie": `session=${token}; HttpOnly; Path=/; SameSite=Strict`
      }
    });
  }

  return loginPage("用户名或密码错误");
}

function handleLogout() {
  return new Response(null, {
    status: 302,
    headers: {
      "Location": "/ui",
      "Set-Cookie": "session=deleted; Path=/; Max-Age=0"
    }
  });
}

async function isAuthenticated(request, kv) {
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(/session=([^;]+)/);
  if (!match) return false;

  const token = match[1];
  const secret = await kv.get("SESSION_SECRET");
  return verifyValue(token, secret);
}

//////////////////////////////////////////////////////
// UI 页面
//////////////////////////////////////////////////////

async function uiPage(kv) {
  const lastWorkflow = await kv.get("LAST_WORKFLOW");

  return html(`
<!doctype html>
<html>
<head>
<meta charset="utf-8"/>
<title>Docker 控制台</title>
<style>
body{font-family:system-ui;background:#f4f6fb;padding:30px}
.card{background:#fff;padding:20px;border-radius:12px;max-width:750px;margin:auto;box-shadow:0 10px 30px rgba(0,0,0,.05)}
textarea{width:100%;height:120px;border:1px solid #ddd;border-radius:8px;padding:8px;font-family:monospace}
button{padding:8px 16px;border:none;border-radius:8px;background:#5562ff;color:white;cursor:pointer}
pre{background:#f2f2f7;padding:12px;border-radius:8px}
.status{margin-top:10px}
</style>
</head>
<body>
<div class="card">
<h2>Docker 镜像更新</h2>

<textarea id="content" placeholder="例如：&#10;python:3.11-slim"></textarea>
<br><br>
<button onclick="submitUpdate()">提交</button>
<a href="/logout" style="float:right">退出登录</a>

<h3>最近 Workflow 状态</h3>
<pre class="status">${lastWorkflow || "暂无记录"}</pre>

<h3>提交结果</h3>
<pre id="result">尚未提交</pre>
</div>

<script>
async function submitUpdate(){
  const content = document.getElementById("content").value.trim();
  if(!content){ alert("请输入内容"); return; }

  const res = await fetch("/update",{
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({content})
  });

  const data = await res.json();
  document.getElementById("result").textContent =
    JSON.stringify(data,null,2);
}
</script>
</body>
</html>
`);
}

function loginPage(msg="") {
  return html(`
<html>
<body style="font-family:system-ui;background:#f4f6fb;padding:40px">
<div style="background:#fff;padding:30px;border-radius:12px;max-width:400px;margin:auto">
<h2>登录</h2>
<form method="POST" action="/login">
<input name="username" placeholder="用户名" required style="width:100%;padding:8px;margin-bottom:10px"><br>
<input type="password" name="password" placeholder="密码" required style="width:100%;padding:8px;margin-bottom:10px"><br>
<button type="submit">登录</button>
</form>
<p style="color:red">${msg}</p>
</div>
</body>
</html>
`);
}

//////////////////////////////////////////////////////
// GitHub 更新
//////////////////////////////////////////////////////

async function handleUpdate(request, kv) {
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const body = await request.json();
  if (!body.content) {
    return json({ error: "Missing content" }, 400);
  }

  const [owner, repo, filePath, branch, token] = await Promise.all([
    kv.get("GITHUB_OWNER"),
    kv.get("GITHUB_REPO"),
    kv.get("FILE_PATH"),
    kv.get("BRANCH"),
    kv.get("GH_TOKEN")
  ]);

  const ref = branch || "main";

  const getUrl =
    `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}?ref=${ref}`;

  const fileData = await safeGitHubRequest(getUrl, token);

  const putUrl =
    `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`;

  const updateResult = await safeGitHubRequest(putUrl, token, {
    method: "PUT",
    body: JSON.stringify({
      message: "auto update via worker",
      content: base64Encode(body.content),
      sha: fileData.sha,
      branch: ref
    })
  });

  return json({ ok: true, commit: updateResult.commit.sha });
}

//////////////////////////////////////////////////////
// Webhook + 持久化
//////////////////////////////////////////////////////

async function handleWebhook(request, kv) {
  if (request.method !== "POST") {
    return new Response("OK");
  }

  const secret = await kv.get("WEBHOOK_SECRET");
  const signature = request.headers.get("x-hub-signature-256");
  const rawBody = await request.text();

  if (!(await verifySignature(rawBody, signature, secret))) {
    return json({ error: "Invalid signature" }, 401);
  }

  const payload = JSON.parse(rawBody);

  if (payload.workflow_run) {
    const info = JSON.stringify({
      name: payload.workflow_run.name,
      status: payload.workflow_run.status,
      conclusion: payload.workflow_run.conclusion,
      time: new Date().toISOString()
    }, null, 2);

    await kv.put("LAST_WORKFLOW", info);
  }

  return json({ ok: true });
}

//////////////////////////////////////////////////////
// 工具函数
//////////////////////////////////////////////////////

async function safeGitHubRequest(url, token, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(JSON.stringify(data));
  }

  return data;
}

async function signValue(value, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(value)
  );

  return value + "." + btoa(String.fromCharCode(...new Uint8Array(sig)));
}

async function verifyValue(token, secret) {
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const valid = await signValue(parts[0], secret);
  return valid === token;
}

async function verifySignature(body, signature, secret) {
  if (!signature || !secret) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(body)
  );

  const hex = "sha256=" +
    Array.from(new Uint8Array(sig))
      .map(b => b.toString(16).padStart(2, "0"))
      .join("");

  return hex === signature;
}

function base64Encode(str) {
  return btoa(unescape(encodeURIComponent(str)));
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function html(content) {
  return new Response(content, {
    headers: { "Content-Type": "text/html; charset=utf-8" }
  });
}
