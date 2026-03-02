export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const kv = env.DOCKER_KV;

    if (!kv) {
      return new Response("KV 未绑定 DOCKER_KV", { status: 500 });
    }

    try {
      if (url.pathname === "/login") return handleLogin(request, kv);
      if (url.pathname === "/logout") return handleLogout();

      if (url.pathname === "/status") {
        const ok = await isAuthenticated(request, kv);
        if (!ok) return json({ error: "Unauthorized" }, 401);
        const status = await kv.get("LAST_WORKFLOW");
        return json({ status: status ? JSON.parse(status) : null });
      }

      if (url.pathname === "/ui") {
        const ok = await isAuthenticated(request, kv);
        if (!ok) return loginPage();
        return uiPage();
      }

      if (url.pathname === "/update") {
        const ok = await isAuthenticated(request, kv);
        if (!ok) return json({ error: "Unauthorized" }, 401);
        return handleUpdate(request, kv);
      }

      if (url.pathname === "/webhook") {
        return handleWebhook(request, kv);
      }

      if (url.pathname === "/") {
        return Response.redirect(`${url.origin}/ui`, 302);
      }

      return new Response("Not Found", { status: 404 });

    } catch (err) {
      return json({ error: err.message, stack: err.stack }, 500);
    }
  }
};

//////////////////////////////////////////////////////
// UI 页面
//////////////////////////////////////////////////////

function uiPage() {
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
textarea{width:100%;height:120px;border:1px solid #ddd;border-radius:8px;padding:12px;font-family:monospace}
button{padding:10px 20px;border:none;border-radius:8px;background:#5562ff;color:white;cursor:pointer;font-weight:bold}
pre{background:#1e1e1e;color:#d4d4d4;padding:15px;border-radius:8px;font-size:13px;overflow-x:auto}
.dot{height:10px;width:10px;background-color:#bbb;border-radius:50%;display:inline-block;margin-right:5px}
.dot.active{background-color:#52c41a;box-shadow:0 0 8px #52c41a}
</style>
</head>
<body>
<div class="card">
<h2>Docker 镜像更新</h2>

<textarea id="content" placeholder="输入镜像版本号，例如 3.12"></textarea>

<div style="margin-top:10px">
<button id="submitBtn" onclick="submitUpdate()">提交更新</button>
<a href="/logout" style="float:right;color:#666;text-decoration:none;font-size:14px;margin-top:10px">退出登录</a>
</div>

<h3>Workflow 状态 <span id="syncDot" class="dot"></span></h3>
<pre id="workflowStatus">尚未提交</pre>

<h3 id="pullTitle" style="display:none">拉取命令</h3>
<pre id="pullCmd" style="display:none"></pre>

</div>

<script>
let polling = null;
let currentVersion = "";

async function submitUpdate(){
  const btn = document.getElementById("submitBtn");
  const content = document.getElementById("content").value.trim();
  if(!content){ alert("请输入镜像版本号"); return; }

  currentVersion = content;

  btn.disabled = true;
  btn.textContent = "提交中...";

  await fetch("/update",{
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({content})
  });

  btn.textContent = "处理中...";
  startPolling();
}

function startPolling(){
  if(polling) clearInterval(polling);
  polling = setInterval(refreshWorkflowStatus, 4000);
  refreshWorkflowStatus();
}

async function refreshWorkflowStatus(){
  const dot = document.getElementById("syncDot");
  const statusBox = document.getElementById("workflowStatus");

  try{
    const res = await fetch("/status");
    const data = await res.json();
    if(!data.status) return;

    statusBox.textContent = JSON.stringify(data.status, null, 2);
    dot.classList.add("active");
    setTimeout(()=>dot.classList.remove("active"),500);

    if(data.status.status === "completed"){
      clearInterval(polling);

      if(data.status.conclusion === "success"){
        showPullCommand();
      }else{
        alert("Workflow 执行失败");
      }
    }

  }catch(e){
    console.error(e);
  }
}

async function showPullCommand(){
  const res = await fetch("/status");
  const data = await res.json();
  if(!data.status || !data.status.pull_command) return;

  document.getElementById("pullTitle").style.display = "block";
  const box = document.getElementById("pullCmd");
  box.style.display = "block";
  box.textContent = data.status.pull_command;
}
</script>
</body>
</html>
`);
}

//////////////////////////////////////////////////////
// 更新逻辑
//////////////////////////////////////////////////////

async function handleUpdate(request, kv) {
  const body = await request.json();
  const version = body.content;

  await kv.put("CURRENT_VERSION", version);

  return json({ ok: true });
}

//////////////////////////////////////////////////////
// Webhook 处理
//////////////////////////////////////////////////////

async function handleWebhook(request, kv) {
  if (request.method !== "POST") return new Response("OK");

  const payload = await request.json();

  if (payload.workflow_run) {

    const registry = await kv.get("ALIYUN_REGISTRY");
    const version = await kv.get("CURRENT_VERSION");

    let pullCmd = null;

    if (payload.workflow_run.conclusion === "success") {
      pullCmd = `docker pull ${registry}/python:${version}`;
    }

    const info = {
      name: payload.workflow_run.name,
      status: payload.workflow_run.status,
      conclusion: payload.workflow_run.conclusion,
      pull_command: pullCmd,
      time: new Date().toLocaleString("zh-CN",{timeZone:"Asia/Shanghai"})
    };

    await kv.put("LAST_WORKFLOW", JSON.stringify(info));
  }

  return json({ ok: true });
}

//////////////////////////////////////////////////////
// 鉴权与工具函数
//////////////////////////////////////////////////////

async function handleLogin(request, kv) {
  if (request.method !== "POST") return loginPage();
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
  return verifyValue(token, secret);
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

function loginPage(msg=""){
  return html("<h2>请登录</h2>");
}

function json(obj,status=200){
  return new Response(JSON.stringify(obj),{status,headers:{"Content-Type":"application/json"}});
}

function html(content){
  return new Response(content,{headers:{"Content-Type":"text/html; charset=utf-8"}});
}
