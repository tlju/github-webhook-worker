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
      // 处理页面请求
      if (url.pathname === "/") {
        return handlePage(kv);
      }

      // 处理业务路由 (GitHub 更新)
      if (url.pathname === "/update") {
        return await handleUpdate(request, kv);
      }

      // 处理业务路由 (Webhook)
      if (url.pathname === "/webhook") {
        return await handleWebhook(request, kv);
      }

      // 获取工作流状态
      if (url.pathname === "/status") {
        return await handleStatus(request, kv);
      }

      return jsonResponse({ error: "Not Found" }, 404);
    } catch (err) {
      console.error("Error in fetch:", err);
      return jsonResponse({ error: err.message || "Internal Error" }, 500);
    }
  },
};

/**
 * 处理页面请求
 */
async function handlePage(kv) {
  const registry = await kv.get("ALIYUN_REGISTRY");
  const namespace = await kv.get("TARGET_NAMESPACE") || "tlju-docker-images";

  const html = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Docker Pull Command Generator</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
      max-width: 800px;
      margin: 0 auto;
      padding: 20px;
      background-color: #f5f5f5;
    }
    .container {
      background: white;
      border-radius: 10px;
      padding: 30px;
      box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
    }
    h1 {
      color: #333;
      text-align: center;
      margin-bottom: 30px;
    }
    .input-group {
      display: flex;
      margin-bottom: 20px;
    }
    input[type="text"] {
      flex: 1;
      padding: 12px 15px;
      border: 1px solid #ddd;
      border-radius: 4px 0 0 4px;
      font-size: 16px;
    }
    button {
      background-color: #007bff;
      color: white;
      border: none;
      padding: 12px 20px;
      cursor: pointer;
      border-radius: 0 4px 4px 0;
      font-size: 16px;
    }
    button:hover {
      background-color: #0056b3;
    }
    .status {
      margin-top: 20px;
      padding: 15px;
      border-radius: 4px;
      background-color: #f8f9fa;
      border-left: 4px solid #007bff;
    }
    .status.completed {
      border-left-color: #28a745;
    }
    .status.in-progress {
      border-left-color: #ffc107;
    }
    .status.pending {
      border-left-color: #6c757d;
    }
    .command {
      margin-top: 15px;
      padding: 15px;
      background-color: #e9ecef;
      border-radius: 4px;
      font-family: monospace;
      word-break: break-all;
    }
    .copy-btn {
      margin-top: 10px;
      background-color: #28a745;
      color: white;
      border: none;
      padding: 8px 15px;
      cursor: pointer;
      border-radius: 4px;
      font-size: 14px;
    }
    .copy-btn:hover {
      background-color: #218838;
    }
    .hidden {
      display: none;
    }
    .loading {
      text-align: center;
      padding: 20px;
    }
    .spinner {
      border: 4px solid rgba(0, 0, 0, 0.1);
      border-radius: 50%;
      border-top: 4px solid #007bff;
      width: 30px;
      height: 30px;
      animation: spin 1s linear infinite;
      margin: 0 auto;
    }
    @keyframes spin {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>Docker Pull Command Generator</h1>
    <div class="input-group">
      <input type="text" id="tagInput" placeholder="输入镜像标签，例如：latest, v1.0.0">
      <button id="updateBtn">确定</button>
    </div>
    <div id="statusSection" class="hidden">
      <h3>工作流状态</h3>
      <div id="statusInfo" class="status">
        <div class="loading">
          <div class="spinner"></div>
          <p>正在等待工作流完成...</p>
        </div>
      </div>
    </div>
  </div>

  <script>
    const tagInput = document.getElementById('tagInput');
    const updateBtn = document.getElementById('updateBtn');
    const statusSection = document.getElementById('statusSection');
    const statusInfo = document.getElementById('statusInfo');

    // 按Enter键触发更新
    tagInput.addEventListener('keypress', function(e) {
      if (e.key === 'Enter') {
        triggerUpdate();
      }
    });

    // 点击按钮触发更新
    updateBtn.addEventListener('click', triggerUpdate);

    // 触发更新函数
    async function triggerUpdate() {
      const tag = tagInput.value.trim();
      if (!tag) {
        alert('请输入镜像标签');
        return;
      }

      try {
        // 显示加载状态
        statusSection.classList.remove('hidden');
        statusInfo.innerHTML = '<div class="loading"><div class="spinner"></div><p>正在触发更新...</p></div>';

        // 调用更新API
        const response = await fetch('/update', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            content: tag
          })
        });

        if (!response.ok) {
          const error = await response.json();
          throw new Error(error.error || '更新失败');
        }

        // 开始轮询状态
        pollStatus(tag);
      } catch (error) {
        statusInfo.innerHTML = '<div style="color: red;">错误: ' + error.message + '</div>';
      }
    }

    // 轮询工作流状态
    async function pollStatus(tag) {
      statusInfo.innerHTML = '<div class="loading"><div class="spinner"></div><p>正在等待工作流完成...</p></div>';

      const interval = setInterval(async () => {
        try {
          const response = await fetch('/status');
          
          if (!response.ok) {
            clearInterval(interval);
            statusInfo.innerHTML = '<div style="color: red;">获取状态失败</div>';
            return;
          }

          const data = await response.json();
          
          if (data.workflow_status === 'completed') {
            clearInterval(interval);
            showCompletionStatus(data, tag);
          } else if (data.workflow_status === 'in_progress') {
            statusInfo.innerHTML = '<div class="status in-progress"><strong>状态:</strong> 工作流进行中<br><strong>时间:</strong> ' + new Date().toLocaleString() + '</div>';
          } else if (data.workflow_status === 'pending' || data.workflow_status === 'queued') {
            statusInfo.innerHTML = '<div class="status pending"><strong>状态:</strong> 等待中<br><strong>时间:</strong> ' + new Date().toLocaleString() + '</div>';
          } else if (data.workflow_status === 'not_found') {
            statusInfo.innerHTML = '<div class="status pending"><strong>状态:</strong> 等待工作流开始<br><strong>时间:</strong> ' + new Date().toLocaleString() + '</div>';
          } else {
            statusInfo.innerHTML = '<div class="status"><strong>状态:</strong> ' + data.workflow_status + '<br><strong>时间:</strong> ' + new Date().toLocaleString() + '</div>';
          }
        } catch (error) {
          clearInterval(interval);
          statusInfo.innerHTML = '<div style="color: red;">轮询出错: ' + error.message + '</div>';
        }
      }, 5000); // 每5秒轮询一次
    }

    // 显示完成状态和命令
    function showCompletionStatus(data, tag) {
      const command = 'docker pull ' + data.registry + '/' + data.namespace + '/' + data.image_name + ':' + tag;
      
      statusInfo.className = 'status completed';
      statusInfo.innerHTML = `
        <div>
          <strong>状态:</strong> 工作流已完成<br>
          <strong>结果:</strong> ${data.conclusion}<br>
          <strong>时间:</strong> ${new Date().toLocaleString()}<br>
          <div class="command">${command}</div>
          <button class="copy-btn" onclick="copyCommand('${command}')">复制命令</button>
        </div>
      `;
    }

    // 复制命令到剪贴板
    window.copyCommand = function(command) {
      navigator.clipboard.writeText(command).then(function() {
        alert('命令已复制到剪贴板');
      }).catch(function(err) {
        console.error('复制失败:', err);
        // 降级方案
        const textArea = document.createElement('textarea');
        textArea.value = command;
        document.body.appendChild(textArea);
        textArea.select();
        document.execCommand('copy');
        document.body.removeChild(textArea);
        alert('命令已复制到剪贴板');
      });
    };
  </script>
</body>
</html>`;

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html',
    },
  });
}

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
  const githubEvent = request.headers.get("X-GitHub-Event");
  const rawBody = await request.text();

  if (!(await verifySignature(rawBody, signature, secret))) return jsonResponse({ error: "Invalid signature" }, 401);

  const payload = JSON.parse(rawBody);
  
  // 存储最新的工作流信息
  if (githubEvent === "workflow_run" && payload.workflow_run) {
    const workflowInfo = {
      status: payload.workflow_run.status,
      conclusion: payload.workflow_run.conclusion,
      event: githubEvent,
      action: payload.action,
      updated_at: payload.workflow_run.updated_at,
      workflow_name: payload.workflow_run.name,
    };
    
    await kv.put("LATEST_WORKFLOW_INFO", JSON.stringify(workflowInfo));
  }

  if (payload.action === "completed" && payload.workflow_run) {
    return jsonResponse({
      workflow: payload.workflow_run.name, 
      status: payload.workflow_run.status, 
      conclusion: payload.workflow_run.conclusion
    });
  }
  return jsonResponse({ message: "Event received and verified" });
}

//////////////////////////////////////////////////////
// 获取工作流状态接口
//////////////////////////////////////////////////////
async function handleStatus(request, kv) {
  const registry = await kv.get("ALIYUN_REGISTRY");
  const namespace = await kv.get("TARGET_NAMESPACE") || "tlju-docker-images";
  const image_name = await kv.get("IMAGE_NAME") || "python";
  
  const workflowInfoStr = await kv.get("LATEST_WORKFLOW_INFO");
  
  if (!workflowInfoStr) {
    return jsonResponse({
      workflow_status: "not_found",
      registry,
      namespace,
      image_name,
      message: "尚未收到工作流事件"
    });
  }
  
  const workflowInfo = JSON.parse(workflowInfoStr);
  
  return jsonResponse({
    workflow_status: workflowInfo.status,
    conclusion: workflowInfo.conclusion,
    registry,
    namespace,
    image_name,
    workflow_name: workflowInfo.workflow_name,
    updated_at: workflowInfo.updated_at,
    message: `工作流状态: ${workflowInfo.status}`
  });
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
