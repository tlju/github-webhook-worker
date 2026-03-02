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

      if (url.pathname === "/status") {
        const ok = await isAuthenticated(request, kv);
        if (!ok) return json({ error: "Unauthorized" }, 401);
  
        const status = await kv.get("LAST_WORKFLOW");
        return json({ status: status ? JSON.parse(status) : null });
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

  return html(`
<!doctype html>
<html>
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Docker 控制台</title>
<style>
  body{font-family:system-ui;background:#f4f6fb;padding:20px}
  .card{background:#fff;padding:24px;border-radius:12px;max-width:750px;margin:auto;box-shadow:0 10px 30px rgba(0,0,0,.05)}
  textarea{width:100%;height:120px;border:1px solid #ddd;border-radius:8px;padding:12px;font-family:monospace;box-sizing:border-box}
  button{padding:10px 20px;border:none;border-radius:8px;background:#5562ff;color:white;cursor:pointer;font-weight:bold}
  button:disabled{background:#ccc}
  pre{background:#1e1e1e;color:#d4d4d4;padding:15px;border-radius:8px;font-size:13px;overflow-x:auto}
  .status-header{display:flex;justify-content:space-between;align-items:center}
  .dot{height:10px;width:10px;background-color:#bbb;border-radius:50%;display:inline-block;margin-right:5px}
  .dot.active{background-color:#52c41a;box-shadow:0 0 8px #52c41a}
  .update-time{font-size:12px;color:#888}
</style>
</head>
<body>
<div class="card">
  <h2>Docker 镜像更新</h2>

  <textarea id="content" placeholder="输入新的镜像标签或配置..."></textarea>
  <div style="margin-top:10px">
    <button id="submitBtn" onclick="submitUpdate()">提交更新</button>
    <a href="/logout" style="float:right;color:#666;text-decoration:none;font-size:14px;margin-top:10px">退出登录</a>
  </div>

  <div class="status-header">
    <h3>最近 Workflow 状态 <span id="syncDot" class="dot"></span></h3>
    <span id="lastSync" class="update-time">等待同步...</span>
  </div>
  <pre id="workflowStatus">${lastWorkflow || "暂无记录"}</pre>

  <h3>提交结果</h3>
  <pre id="result">尚未提交</pre>
</div>

<script>
// --- 提交逻辑 ---
async function submitUpdate(){
  const btn = document.getElementById("submitBtn");
  const content = document.getElementById("content").value.trim();
  if(!content){ alert("请输入内容"); return; }

  btn.disabled = true;
  btn.textContent = "提交中...";

  try {
    const res = await fetch("/update",{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({content})
    });
    const data = await res.json();
    document.getElementById("result").textContent = JSON.stringify(data,null,2);
    if(res.ok) alert("提交成功！任务排队中...");
  } catch(e) {
    alert("提交失败: " + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "提交更新";
  }
}

// --- 自动刷新逻辑 ---
async function refreshWorkflowStatus() {
  const dot = document.getElementById("syncDot");
  const timeLabel = document.getElementById("lastSync");
  const statusBox = document.getElementById("workflowStatus");

  try {
    const res = await fetch("/status");
    if (!res.ok) throw new Error("Unauthorized");
    
    const data = await res.json();
    if (data.status) {
      statusBox.textContent = JSON.stringify(data.status, null, 2);
      
      // 根据结论调整边框颜色 (成功:绿, 失败:红, 运行中:蓝)
      const conclusion = data.status.conclusion;
      const status = data.status.status;
      
      if (status !== "completed") {
        statusBox.style.borderLeft = "4px solid #1890ff"; // 运行中
      } else {
        statusBox.style.borderLeft = conclusion === "success" ? "4px solid #52c41a" : "4px solid #ff4d4f";
      }
    }

    // 闪烁一下指示灯表示数据已同步
    dot.classList.add("active");
    timeLabel.textContent = "最后同步: " + new Date().toLocaleTimeString();
    setTimeout(() => dot.classList.remove("active"), 500);

  } catch (e) {
    console.error("同步失败:", e);
    timeLabel.textContent = "同步失败，请检查登录状态";
  }
}

// 每 5 秒刷新一次
setInterval(refreshWorkflowStatus, 5000);
// 页面加载完成后立即刷新一次
window.onload = refreshWorkflowStatus;
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
  <h2>控制台登录</h2>
  <form method="POST" action="/login">
    <input name="username" placeholder="用户名" required style="width:100%;padding:12px;margin-bottom:15px;border:1px solid #ddd;border-radius:6px;box-sizing:border-box"><br>
    <input type="password" name="password" placeholder="密码" required style="width:100%;padding:12px;margin-bottom:15px;border:1px solid #ddd;border-radius:6px;box-sizing:border-box"><br>
    <button type="submit" style="width:100%;padding:12px;background:#5562ff;color:#fff;border:none;border-radius:6px;font-weight:bold;cursor:pointer">登录</button>
  </form>
  ${msg ? `<p style="color:#ff4d4f;font-size:14px">${msg}</p>` : ""}
</div>
</body>
</html>
`);
}

//////////////////////////////////////////////////////
// GitHub API 更新操作
//////////////////////////////////////////////////////

async function handleUpdate(request, kv) {
  const body = await request.json();
  const config = {
    owner: await kv.get("GITHUB_OWNER"),
    repo: await kv.get("GITHUB_REPO"),
    path: await kv.get("FILE_PATH"),
    branch: await kv.get("BRANCH") || "main",
    token: await kv.get("GH_TOKEN")
  };

  if (!config.owner || !config.repo || !config.path || !config.token) {
    return json({ error: "KV 缺少必要配置项" }, 500);
  }

  const getUrl = `https://api.github.com/repos/${config.owner}/${config.repo}/contents/${config.path}?ref=${config.branch}`;
  const fileData = await safeGitHubRequest(getUrl, config.token);

  const putUrl = `https://api.github.com/repos/${config.owner}/${config.repo}/contents/${config.path}`;
  const updateResult = await safeGitHubRequest(putUrl, config.token, {
    method: "PUT",
    body: JSON.stringify({
      message: "Update via Worker UI",
      content: base64Encode(body.content),
      sha: fileData.sha,
      branch: config.branch
    })
  });

  return json({ ok: true, sha: updateResult.commit.sha });
}

//////////////////////////////////////////////////////
// Webhook 处理
//////////////////////////////////////////////////////

async function handleWebhook(request, kv) {
  if (request.method !== "POST") return new Response("OK");
  const rawBody = await request.text();
  const payload = JSON.parse(rawBody);

  if (payload.workflow_run) {
    const info = {
      name: payload.workflow_run.name,
      status: payload.workflow_run.status,
      conclusion: payload.workflow_run.conclusion,
      time: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
    };
    await kv.put("LAST_WORKFLOW", JSON.stringify(info, null, 2));
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
      "Authorization": `Bearer ${token}`,
      "Accept": "application/vnd.github+json",
      "User-Agent": "Cloudflare-Worker-Docker-Updater",
      ...(options.headers || {})
    }
  });

  const text = await response.text();
  const data = JSON.parse(text);
  if (!response.ok) throw new Error(data.message || "GitHub API Error");
  return data;
}

function base64Encode(str) {
  const bytes = new TextEncoder().encode(str);
  const binString = String.fromCharCode(...bytes);
  return btoa(binString);
}

async function signValue(value, secret) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
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
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
  const hex = "sha256=" + Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");
  return hex === signature;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}

function html(content) {
  return new Response(content, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}
