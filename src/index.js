/**
 * Cloudflare Worker script for handling Docker registry proxy and image building.
 * This worker intercepts Docker pull requests, triggers GitHub workflows to build
 * and push images to Aliyun registry if not available, and proxies requests once ready.
 * 
 * Configuration is stored in KV namespace DOCKER_KV, including:
 * - GITHUB_OWNER: GitHub repository owner
 * - GITHUB_REPO: GitHub repository name
 * - FILE_PATH: Path to the file in repo that triggers the workflow (e.g., image tag file)
 * - BRANCH: Branch to update (default: main)
 * - GH_TOKEN: GitHub personal access token
 * - ALIYUN_REGISTRY: Aliyun registry URL (default: registry.cn-hangzhou.aliyuncs.com/tlju-docker-images)
 * 
 * Workflow:
 * 1. Docker client pulls from this worker's domain (e.g., tlju.qzz.io).
 * 2. For manifest requests, check if image is ready in KV status.
 * 3. If not, trigger GitHub file update to start workflow.
 * 4. Workflow pushes image to Aliyun.
 * 5. Webhook updates KV status on completion.
 * 6. Proxy requests to Aliyun registry once ready.
 * 
 * Error handling: Returns 503 for building, 500 for failed or errors.
 */
export default {
  /**
   * Main fetch handler for incoming requests.
   * @param {Request} request - The incoming request object.
   * @param {Object} env - Environment variables, including KV bindings.
   * @returns {Promise<Response>} The response to the request.
   */
  async fetch(request, env) {
    const url = new URL(request.url);
    const kv = env.DOCKER_KV;
    if (!kv) {
      return new Response("KV 绑定错误：请确保在 Cloudflare 设置中绑定了名为 DOCKER_KV 的命名空间", { status: 500 });
    }
    try {
      if (url.pathname.startsWith("/v2/")) {
        return await handleRegistry(request, kv, url);
      }
      if (url.pathname === "/webhook") {
        return handleWebhook(request, kv);
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
// GitHub API 更新操作
//////////////////////////////////////////////////////
/**
 * Handles updating a file in GitHub to trigger a workflow.
 * Updates the specified file with new content (image tag), which triggers a GitHub Action.
 * Sets KV status to 'building' and polls for the triggered workflow run ID.
 * @param {Object} body - Request body with 'content' property (e.g., 'python:latest').
 * @param {KVNamespace} kv - The KV namespace for storage.
 * @returns {Promise<Object>} Result with ok and commit sha.
 * @throws {Error} If configuration is missing or no workflow is triggered.
 */
async function handleUpdate(body, kv) {
  const config = {
    owner: await kv.get("GITHUB_OWNER"),
    repo: await kv.get("GITHUB_REPO"),
    path: await kv.get("FILE_PATH"),
    branch: await kv.get("BRANCH") || "main",
    token: await kv.get("GH_TOKEN")
  };
  if (!config.owner || !config.repo || !config.path || !config.token) {
    throw new Error("KV 缺少必要配置项");
  }
  const getUrl = `https://api.github.com/repos/${config.owner}/${config.repo}/contents/${config.path}?ref=${config.branch}`;
  const fileData = await safeGitHubRequest(getUrl, config.token);
  const putUrl = `https://api.github.com/repos/${config.owner}/${config.repo}/contents/${config.path}`;
  const updateResult = await safeGitHubRequest(putUrl, config.token, {
    method: "PUT",
    body: JSON.stringify({
      message: "Update via Registry",
      content: base64Encode(body.content),
      sha: fileData.sha,
      branch: config.branch
    })
  });
  await kv.delete("LAST_WORKFLOW");
  // Set building status
  const status_key = `IMAGE_STATUS_${body.content.replace(/[:/]/g, '_')}`;
  await kv.put(status_key, 'building');
  // Find the triggered workflow run
  let run = null;
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const runs = await safeGitHubRequest(`https://api.github.com/repos/${config.owner}/${config.repo}/actions/runs?head_sha=${updateResult.commit.sha}&per_page=1`, config.token);
    if (runs.workflow_runs && runs.workflow_runs.length > 0) {
      run = runs.workflow_runs[0];
      break;
    }
  }
  if (!run) {
    await kv.put(status_key, 'failed');
    throw new Error('No workflow triggered');
  }
  const run_id = run.id;
  await kv.put(`IMAGE_FOR_WORKFLOW_${run_id}`, body.content);
  return { ok: true, sha: updateResult.commit.sha };
}
//////////////////////////////////////////////////////
// Webhook 处理
//////////////////////////////////////////////////////
/**
 * Handles GitHub webhook events for workflow runs.
 * Updates KV with workflow status and sets image status based on conclusion.
 * @param {Request} request - The incoming webhook request.
 * @param {KVNamespace} kv - The KV namespace for storage.
 * @returns {Promise<Response>} JSON response indicating success.
 */
async function handleWebhook(request, kv) {
  if (request.method !== "POST") return new Response("OK");
  const payload = await request.json();
  if (payload.workflow_run) {
    const info = {
      id: payload.workflow_run.id,
      name: payload.workflow_run.name,
      status: payload.workflow_run.status,
      conclusion: payload.workflow_run.conclusion,
      head_branch: payload.workflow_run.head_branch,
      updated_at: payload.workflow_run.updated_at,
      time: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
    };
    await kv.put("LAST_WORKFLOW", JSON.stringify(info));
    if (payload.workflow_run.status === "completed") {
      const run_id = payload.workflow_run.id;
      const image = await kv.get(`IMAGE_FOR_WORKFLOW_${run_id}`);
      if (image) {
        const status_key = `IMAGE_STATUS_${image.replace(/[:/]/g, '_')}`;
        if (payload.workflow_run.conclusion === "success") {
          await kv.put(status_key, 'ready');
        } else {
          await kv.put(status_key, 'failed');
        }
        // Optional: await kv.delete(`IMAGE_FOR_WORKFLOW_${run_id}`);
      }
    }
  }
  return json({ ok: true });
}
//////////////////////////////////////////////////////
// Registry Proxy 处理
//////////////////////////////////////////////////////
/**
 * Handles Docker registry API requests (/v2/*).
 * Proxies to Aliyun registry if image is ready, or triggers build if not.
 * For manifest requests, checks/sets status and responds accordingly.
 * @param {Request} request - The incoming request.
 * @param {KVNamespace} kv - The KV namespace.
 * @param {URL} url - Parsed URL object.
 * @returns {Promise<Response>} Proxied response or status code.
 */
async function handleRegistry(request, kv, url) {
  const pathname = url.pathname;
  if (pathname === "/v2/" || pathname === "/v2") {
    return new Response("", {
      status: 200,
      headers: { "Docker-Distribution-Api-Version": "registry/2.0" }
    });
  }
  const aliyunRegistry = await kv.get("ALIYUN_REGISTRY") || "registry.cn-hangzhou.aliyuncs.com/tlju-docker-images";
  const aliyun_base = `https://${aliyunRegistry}`;
  // Rewrite for official images: /v2/library/python/... -> /v2/python/...
  let proxy_path = pathname.replace("/v2/library/", "/v2/");
  const proxy_url = `${aliyun_base}${proxy_path}${url.search}`;
  // Parse for manifest requests to trigger build if needed
  const parts = pathname.split("/");
  if (parts.length >= 4 && parts[parts.length - 2] === "manifests") {
    const ref = parts[parts.length - 1];
    if (ref.startsWith("sha256:")) {
      // Don't trigger for digest, just proxy
      return await fetch(proxy_url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        redirect: "follow"
      });
    }
    const image_name = parts.slice(2, parts.length - 2).join("/");
    const tag = ref || "latest";
    const content = image_name.replace(/^library\//, "") + ":" + tag;
    const status_key = `IMAGE_STATUS_${content.replace(/[:/]/g, "_")}`;
    const status = await kv.get(status_key);
    if (status === "ready") {
      // Proxy
      return await fetch(proxy_url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        redirect: "follow"
      });
    } else if (status === "building") {
      return new Response("Image is building, please retry later.", {
        status: 503,
        headers: { "Retry-After": "30" }
      });
    } else if (status === "failed") {
      return new Response("Image build failed.", { status: 500 });
    } else {
      // Trigger build
      try {
        await handleUpdate({ content }, kv);
      } catch (err) {
        return new Response("Failed to start build: " + err.message, { status: 500 });
      }
      return new Response("Starting build, please retry later.", {
        status: 503,
        headers: { "Retry-After": "30" }
      });
    }
  }
  // For other requests (e.g., blobs, tags/list), just proxy
  return await fetch(proxy_url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    redirect: "follow"
  });
}
//////////////////////////////////////////////////////
// 工具函数
//////////////////////////////////////////////////////
/**
 * Safely makes a request to GitHub API.
 * @param {string} url - GitHub API URL.
 * @param {string} token - GitHub token.
 * @param {Object} [options={}] - Fetch options.
 * @returns {Promise<Object>} Parsed JSON response.
 * @throws {Error} If response is not OK or invalid JSON.
 */
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
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error("Invalid JSON from GitHub: " + text);
  }
  if (!response.ok) throw new Error(data.message || "GitHub API Error");
  return data;
}

/**
 * Encodes a string to base64.
 * @param {string} str - String to encode.
 * @returns {string} Base64 encoded string.
 */
function base64Encode(str) {
  const bytes = new TextEncoder().encode(str);
  const binString = String.fromCharCode(...bytes);
  return btoa(binString);
}

/**
 * Creates a JSON response.
 * @param {Object} obj - Object to stringify.
 * @param {number} [status=200] - HTTP status code.
 * @returns {Response} JSON response object.
 */
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}
