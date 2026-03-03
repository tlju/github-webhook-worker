export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const kv = env.DOCKER_KV;

    if (!kv) {
      return new Response("KV not bound", { status: 500 });
    }

    if (url.pathname === "/login") {
      return handleLogin(request);
    }

    if (url.pathname === "/logout") {
      return handleLogout();
    }

    if (!isAuthenticated(request)) {
      return new Response("Unauthorized", { status: 401 });
    }

    if (url.pathname === "/submit" && request.method === "POST") {
      return handleSubmit(request, kv);
    }

    return new Response(renderPage(), {
      headers: { "Content-Type": "text/html;charset=UTF-8" }
    });
  }
};

////////////////////////////////////////////////////////
// 登录认证
////////////////////////////////////////////////////////

function isAuthenticated(request) {
  const cookie = request.headers.get("Cookie") || "";
  return cookie.includes("auth=1");
}

async function handleLogin(request) {
  return new Response("ok", {
    headers: {
      "Set-Cookie": "auth=1; Path=/; HttpOnly",
    }
  });
}

function handleLogout() {
  return new Response("logout", {
    headers: {
      "Set-Cookie": "auth=0; Path=/; Max-Age=0"
    }
  });
}

////////////////////////////////////////////////////////
// 提交 & 触发 workflow
////////////////////////////////////////////////////////

async function handleSubmit(request, kv) {
  const body = await request.json();
  const version = body.version;

  const token = await kv.get("GITHUB_TOKEN");
  const owner = await kv.get("GITHUB_OWNER");
  const repo = await kv.get("GITHUB_REPO");
  const registry = await kv.get("ALIYUN_REGISTRY");

  if (!token || !owner || !repo || !registry) {
    return json({ error: "Missing KV config" }, 500);
  }

  const filename = "images.txt";

  // 1️⃣ 获取当前文件 sha
  const fileRes = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/contents/${filename}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const fileData = await fileRes.json();

  // 2️⃣ 更新文件
  const content = btoa(`python:${version}\n`);

  await fetch(
    `https://api.github.com/repos/${owner}/${repo}/contents/${filename}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        message: `update python:${version}`,
        content,
        sha: fileData.sha
      })
    }
  );

  // 3️⃣ 等待 workflow_run 出现
  const workflowId = await waitForWorkflowRun(token, owner, repo);

  if (!workflowId) {
    return json({ error: "Workflow not triggered" }, 500);
  }

  // 4️⃣ 精确匹配 workflow_run.id 轮询
  const result = await pollWorkflow(token, owner, repo, workflowId, 600);

  if (result === "success") {
    const cmd = `docker pull ${registry}/python:${version}`;
    return json({
      status: "success",
      command: cmd
    });
  }

  return json({
    status: "failure"
  });
}

////////////////////////////////////////////////////////
// 等待最新 workflow_run
////////////////////////////////////////////////////////

async function waitForWorkflowRun(token, owner, repo) {
  const startTime = Date.now();
  const timeout = 60000;

  while (Date.now() - startTime < timeout) {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/actions/runs?per_page=1`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    const data = await res.json();

    if (data.workflow_runs.length > 0) {
      const run = data.workflow_runs[0];
      return run.id;
    }

    await sleep(3000);
  }

  return null;
}

////////////////////////////////////////////////////////
// 精确匹配 workflow_run.id 轮询
////////////////////////////////////////////////////////

async function pollWorkflow(token, owner, repo, runId, timeoutSeconds) {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutSeconds * 1000) {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/actions/runs/${runId}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    const data = await res.json();

    if (data.status === "completed") {
      if (data.conclusion === "success") {
        return "success";
      }
      if (data.conclusion === "failure") {
        return "failure";
      }
    }

    await sleep(5000);
  }

  return "timeout";
}

////////////////////////////////////////////////////////
// 页面
////////////////////////////////////////////////////////

function renderPage() {
  return `
  <html>
  <body>
    <h2>Docker 镜像更新</h2>
    <input id="version" placeholder="输入版本号"/>
    <button onclick="submit()">提交更新</button>
    <pre id="result"></pre>

    <script>
      async function submit(){
        const version = document.getElementById('version').value;

        const res = await fetch('/submit',{
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body:JSON.stringify({version})
        });

        const data = await res.json();
        document.getElementById('result').innerText =
          JSON.stringify(data,null,2);
      }
    </script>
  </body>
  </html>
  `;
}

////////////////////////////////////////////////////////
// 工具函数
////////////////////////////////////////////////////////

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}
