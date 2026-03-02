export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const kv = env.DOCKER_KV;

    if (!kv) {
      return new Response("KV 绑定错误：请确保在 Cloudflare 设置中绑定了名为 DOCKER_KV 的命名空间", { status: 500 });
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

      // 根目录自动跳转到 /ui
      if (url.pathname === "/") {
        return Response.redirect(`${url.origin}/ui`, 302);
      }

      return new Response("Not Found", { status: 404 });

    } catch (err) {
      // 捕获所有未处理异常，防止 1101 错误
      return json({ 
        error: "Worker 内部错误", 
        message: err.message,
        stack: err.stack 
      }, 500);
    }
  }
};

//////////////////////////////////////////////////////
// 登录与鉴权逻辑
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

  if (!kvUser || !kvPass || !secret) {
    return loginPage("系统未初始化：请在 KV 中设置 UI_USERNAME, UI_PASSWORD 和 SESSION_SECRET");
  }

  if (username === kvUser && password === kvPass) {
    const token = await signValue(username, secret);

    return new Response(null, {
      status: 302,
      headers: {
        "Location": "/ui",
        "Set-Cookie": `session=${token}; HttpOnly; Path=/; SameSite=Strict; Secure`
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
  if (!secret) return false;
  
  return verifyValue(token, secret);
}

//////////////////////////////////////////////////////
// UI 页面 (HTML)
//////////////////////////////////////////////////////

async function uiPage(kv) {
  const lastWorkflow = await kv.get("LAST_WORKFLOW");
  const filePath = await kv.get("FILE_PATH") || "未设置";

  return html(`
<!doctype html>
<html>
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Docker 控制台</title>
<style>
  body{font-family:system-ui,-apple-system,sans-serif;background:#f4f6fb;padding:20px;color:#333}
  .card{background:#fff;padding:24px;border-radius:12px;max-width:800px;margin:auto;box-shadow:0 4px 20px rgba(0,0,0,.08)}
  h2{margin-top:0;color:#1a1a1a}
  textarea{width:100%;height:180px;border:1px solid #ddd;border-radius:8px;padding:12px;font-family:monospace;box-sizing:border-box;font-size:14px;background:#fafafa}
  textarea:focus{outline:2px solid #5562ff;border-color:transparent}
  .actions{margin-top:15px;display:flex;justify-content:space-between;align-items:center}
  button{padding:10px 24px;border:none;border-radius:8px;background:#5562ff;color:white;cursor:pointer;font-weight:600;transition:background 0.2s}
  button:hover{background:#3e49df}
  button:disabled{background:#ccc;cursor:not-allowed}
  pre{background:#1e1e1e;color:#d4d4d4;padding:15px;border-radius:8px;overflow-x:auto;font-size:13px}
  .label{font-weight:bold;margin-bottom:8px;display:block}
  .status-tag{padding:4px 8px;border-radius:4px;font-size:12px;background:#eee}
</style>
</head>
<body>
<div class="card">
  <h2>Docker 镜像更新 <span class="status-tag">${filePath}</span></h2>
  
  <label class="label">输入新的配置内容 (如 python:3.11-slim):</label>
  <textarea id="content" placeholder="输入内容会直接覆盖文件..."></textarea>
  
  <div class="actions">
    <button id="submitBtn" onclick="submitUpdate()">提交到 GitHub</button>
    <a href="/logout" style="color:#666;text-decoration:none;font-size:14px">退出登录</a>
  </div>

  <h3>最近 Workflow 状态</h3>
  <pre id="workflowStatus">${lastWorkflow || "暂无记录"}</pre>

  <h3>操作日志</h3>
  <pre id="result">等待提交...</pre>
</div>

<script>
async function submitUpdate(){
  const btn = document.getElementById("submitBtn");
  const content = document.getElementById("content").value.trim();
  const resBox = document.getElementById("result");

  if(!content){ alert("请输入内容"); return; }
  
  btn.disabled = true;
  btn.textContent = "提交中...";
  resBox.textContent = "正在发起请求...";

  try {
    const res = await fetch("/update",{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({content})
    });

    const data = await res.json();
    resBox.textContent = JSON.stringify(data, null, 2);
    
    if(res.ok) {
      alert("更新成功！请等待 GitHub Workflow 执行。");
      document.getElementById("content").value = "";
    } else {
      resBox.style.color = "#ff4d4f";
    }
  } catch(e) {
    resBox.textContent = "网络错误: " + e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = "提交到 GitHub";
  }
}
</script>
</body>
</html>
`);
}

function loginPage(msg="") {
  return html(`
<html>
<body style="font-family:system-ui;background:#f4f6fb;display:flex;height:90vh;align-items:center;justify-content:center">
<div style="background:#fff;padding:40px;border-radius:12px;width:100%;max-width:350px;box-shadow:0 10px 25px rgba(0,0,0,.05)">
  <h2 style="margin-top:0">控制台登录</h2>
  <form method="POST" action="/login">
    <input name="username" placeholder="用户名" required style="width:100%;padding:12px;margin-bottom:15px;border:1px solid #ddd;border-radius:6px;box-sizing:border-box"><br>
    <input type="password" name="password" placeholder="密码" required style="width:100%;padding:12px;margin-bottom:15px;border:1px solid #ddd;border-radius:6px;box-sizing:border-box"><br>
    <button type="submit" style="width:100%;padding:12px;background:#5562ff;color:#fff;border:none;border-radius:6px;font-weight:bold;cursor:pointer">登录</button>
  </form>
  ${msg ? `<p style="color:#ff4d4f;background:#fff1f0;padding:10px;border-radius:4px;font-size:14px">${msg}</p>` : ""}
</div>
</body>
</html>
`);
}

//////////////////////////////////////////////////////
// GitHub API 更新操作
//////////////////////////////////////////////////////

async function handleUpdate(request, kv) {
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const body = await request.json();
  if (!body.content) {
    return json({ error: "Missing content" }, 400);
  }

  // 从 KV 获取配置
  const config = {
    owner: await kv.get("GITHUB_OWNER"),
    repo: await kv.get("GITHUB_REPO"),
    path: await kv.get("FILE_PATH"),
    branch: await kv.get("BRANCH") || "main",
    token: await kv.get("GH_TOKEN")
  };

  // 检查必填项
  if (!config.owner || !config.repo || !config.path || !config.token) {
    return json({ error: "KV 缺少必要配置项 (OWNER/REPO/PATH/TOKEN)" }, 500);
  }

  // 1. 获取文件当前 SHA (更新 GitHub 文件必须提供旧文件的 SHA)
  const getUrl = `https://api.github.com/repos/${config.owner}/${config.repo}/contents/${config.path}?ref=${config.branch}`;
  
  let fileData;
  try {
    fileData = await safeGitHubRequest(getUrl, config.token);
  } catch (e) {
    return json({ error: "获取 GitHub 文件信息失败", details: e.message }, 500);
  }

  // 2. 提交 PUT 请求更新文件
  const putUrl = `https://api.github.com/repos/${config.owner}/${config.repo}/contents/${config.path}`;
  
  try {
    const updateResult = await safeGitHubRequest(putUrl, config.token, {
      method: "PUT",
      body: JSON.stringify({
        message: "Update via Cloudflare Worker UI",
        content: base64Encode(body.content),
        sha: fileData.sha,
        branch: config.branch
      })
    });
    return json({ ok: true, sha: updateResult.commit.sha });
  } catch (e) {
    return json({ error: "提交更新到 GitHub 失败", details: e.message }, 500);
  }
}

//////////////////////////////////////////////////////
// Webhook 处理
//////////////////////////////////////////////////////

async function handleWebhook(request, kv) {
  if (request.method !== "POST") return new Response("OK");

  const secret = await kv.get("WEBHOOK_SECRET");
  const signature = request.headers.get("x-hub-signature-256");
  const rawBody = await request.text();

  if (secret && !(await verifySignature(rawBody, signature, secret))) {
    return json({ error: "Invalid signature" }, 401);
  }

  const payload = JSON.parse(rawBody);

  // 记录 Workflow Run 状态
  if (payload.workflow_run) {
    const info = {
      name: payload.workflow_run.name,
      status: payload.workflow_run.status,
      conclusion: payload.workflow_run.conclusion,
      url: payload.workflow_run.html_url,
      updated_at: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
    };
    await kv.put("LAST_WORKFLOW
