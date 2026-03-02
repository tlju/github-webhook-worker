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
</style>
</head>
<body>
<div class="card">
<h2>Docker 镜像更新</h2>

<textarea id="content" placeholder="输入镜像版本号，例如 3.12"></textarea>
<br><br>
<button id="submitBtn" onclick="submitUpdate()">提交更新</button>
<a href="/logout" style="float:right">退出登录</a>

<h3>Workflow 状态</h3>
<pre id="workflowStatus">尚未提交</pre>

<h3 id="pullTitle" style="display:none">拉取命令</h3>
<pre id="pullCmd" style="display:none"></pre>

</div>

<script>
let polling = null;
let submitTime = 0;
let targetWorkflowId = null;
let timeoutTimer = null;

async function submitUpdate(){
  const btn = document.getElementById("submitBtn");
  const content = document.getElementById("content").value.trim();
  if(!content){ alert("请输入镜像版本号"); return; }

  submitTime = Date.now();
  targetWorkflowId = null;

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

  // 10分钟超时
  timeoutTimer = setTimeout(()=>{
    clearInterval(polling);
    alert("超时：Workflow 超过 10 分钟未完成");
  }, 10 * 60 * 1000);

  polling = setInterval(refreshWorkflowStatus, 4000);
  refreshWorkflowStatus();
}

async function refreshWorkflowStatus(){
  const res = await fetch("/status");
  const data = await res.json();
  if(!data.status) return;

  const wf = data.status;

  // 忽略旧数据
  if(!wf.timestamp || wf.timestamp < submitTime) return;

  // 第一次捕获 workflow id
  if(!targetWorkflowId){
    targetWorkflowId = wf.id;
  }

  // 只处理匹配的 workflow
  if(wf.id !== targetWorkflowId) return;

  document.getElementById("workflowStatus").textContent =
    JSON.stringify(wf, null, 2);

  if(wf.status === "completed"){
    clearInterval(polling);
    clearTimeout(timeoutTimer);

    if(wf.conclusion === "success"){
      showPullCommand(wf.pull_command);
    }else{
      alert("Workflow 执行失败");
    }
  }
}

function showPullCommand(cmd){
  if(!cmd) return;
  document.getElementById("pullTitle").style.display = "block";
  const box = document.getElementById("pullCmd");
  box.style.display = "block";
  box.textContent = cmd;
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
  await kv.put("CURRENT_VERSION", body.content);
  return json({ ok: true });
}

//////////////////////////////////////////////////////
// Webhook 处理（保存 workflow id）
//////////////////////////////////////////////////////

async function handleWebhook(request, kv) {
  if (request.method !== "POST") return new Response("OK");

  const payload = await request.json();
  if (!payload.workflow_run) return json({ ok: true });

  const registry = await kv.get("ALIYUN_REGISTRY");
  const version = await kv.get("CURRENT_VERSION");

  let pullCmd = null;

  if (payload.workflow_run.conclusion === "success") {
    pullCmd = `docker pull ${registry}/python:${version}`;
  }

  const info = {
    id: payload.workflow_run.id,   // 🔥 精确匹配核心
    name: payload.workflow_run.name,
    status: payload.workflow_run.status,
    conclusion: payload.workflow_run.conclusion,
    pull_command: pullCmd,
    timestamp: Date.now()
  };

  await kv.put("LAST_WORKFLOW", JSON.stringify(info));
  return json({ ok: true });
}

//////////////////////////////////////////////////////
// 省略鉴权工具函数（保持你原来的即可）
//////////////////////////////////////////////////////

function json(obj,status=200){
  return new Response(JSON.stringify(obj),{status,headers:{"Content-Type":"application/json"}});
}

function html(content){
  return new Response(content,{headers:{"Content-Type":"text/html; charset=utf-8"}});
}
