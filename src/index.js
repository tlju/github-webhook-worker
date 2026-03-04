/**
 * Cloudflare Worker 脚本 - Docker 无感镜像代理 + 自动构建
 * 
 * 功能：
 * - 拦截 docker pull tlju.qzz.io/python（或通过 registry-mirrors 的 python）
 * - 第一次拉取时自动触发 GitHub Workflow 构建并推送到阿里云
 * - 构建完成后自动代理到阿里云，实现真正“无感” pull
 * - 支持 /v2/python/... 和 /v2/library/python/... 两种路径
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const kv = env.DOCKER_KV;
    if (!kv) {
      return new Response("KV 绑定错误：请确保绑定了名为 DOCKER_KV 的命名空间", { status: 500 });
    }

    try {
      // ==================== Docker Registry 代理核心 ====================
      if (url.pathname.startsWith("/v2/")) {
        return await handleRegistry(request, kv, url);
      }

      // ==================== GitHub Webhook ====================
      if (url.pathname === "/webhook") {
        return handleWebhook(request, kv);
      }

      return new Response("Not Found", { status: 404 });
    } catch (err) {
      console.error("Worker 错误:", err);
      return new Response(JSON.stringify({
        errors: [{ code: "UNKNOWN", message: "Worker 内部错误: " + err.message }]
      }), { 
        status: 500, 
        headers: { "Content-Type": "application/json" } 
      });
    }
  }
};

// ====================== Registry 代理处理 ======================
async function handleRegistry(request, kv, url) {
  const pathname = url.pathname;

  // Docker Registry v2 Ping
  if (pathname === "/v2/" || pathname === "/v2") {
    return new Response("", {
      status: 200,
      headers: { "Docker-Distribution-Api-Version": "registry/2.0" }
    });
  }

  const aliyunRegistry = await kv.get("ALIYUN_REGISTRY") || "registry.cn-hangzhou.aliyuncs.com/tlju-docker-images";
  const aliyun_base = `https://${aliyunRegistry}`;

  // 官方镜像路径重写：/v2/library/python/... → /v2/python/...
  let proxy_path = pathname.replace("/v2/library/", "/v2/");
  const proxy_url = `${aliyun_base}${proxy_path}${url.search}`;

  // 只在请求 manifest 时判断是否需要触发构建
  const parts = pathname.split("/");
  if (parts.length >= 4 && parts[parts.length - 2] === "manifests") {
    const ref = parts[parts.length - 1];
    if (ref.startsWith("sha256:")) {
      // 摘要请求直接代理
      return await proxyToAliyun(request, proxy_url);
    }

    const image_name = parts.slice(2, parts.length - 2).join("/");
    const tag = ref || "latest";
    const content = image_name.replace(/^library\//, "") + ":" + tag;   // python:latest
    const status_key = `IMAGE_STATUS_${content.replace(/[:/]/g, "_")}`;

    const status = await kv.get(status_key);

    if (status === "ready") {
      return await proxyToAliyun(request, proxy_url);
    } else if (status === "building") {
      return dockerError(503, "TOO_MANY_REQUESTS", "镜像正在构建中，请稍后重试", "30");
    } else if (status === "failed") {
      return dockerError(404, "MANIFEST_UNKNOWN", "镜像构建失败", null);
    } else {
      // 首次请求：触发构建
      try {
        await handleUpdate({ content }, kv);
        await kv.put(status_key, "building");   // 立即标记为构建中，防止重复触发
      } catch (err) {
        console.error("触发构建失败:", err);
        return dockerError(500, "UNKNOWN", "启动构建失败: " + err.message, null);
      }
      return dockerError(503, "TOO_MANY_REQUESTS", "正在启动镜像构建，请 30 秒后重试", "30");
    }
  }

  // 其他请求（blobs、tags 等）直接代理
  return await proxyToAliyun(request, proxy_url);
}

async function proxyToAliyun(request, proxy_url) {
  return await fetch(proxy_url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    redirect: "follow"
  });
}

// ====================== 触发 GitHub 更新 ======================
async function handleUpdate(body, kv) {
  const config = {
    owner: await kv.get("GITHUB_OWNER"),
    repo: await kv.get("GITHUB_REPO"),
    path: await kv.get("FILE_PATH"),
    branch: await kv.get("BRANCH") || "main",
    token: await kv.get("GH_TOKEN")
  };

  if (!config.owner || !config.repo || !config.path || !config.token) {
    throw new Error("KV 缺少必要配置项 (GITHUB_OWNER, GITHUB_REPO, FILE_PATH, GH_TOKEN)");
  }

  // 获取当前文件 SHA
  const getUrl = `https://api.github.com/repos/${config.owner}/${config.repo}/contents/${config.path}?ref=${config.branch}`;
  const fileData = await safeGitHubRequest(getUrl, config.token);

  // 更新文件内容（触发 Workflow）
  const putUrl = `https://api.github.com/repos/${config.owner}/${config.repo}/contents/${config.path}`;
  const updateResult = await safeGitHubRequest(putUrl, config.token, {
    method: "PUT",
    body: JSON.stringify({
      message: "Update via Registry Proxy",
      content: base64Encode(body.content),
      sha: fileData.sha,
      branch: config.branch
    })
  });

  await kv.delete("LAST_WORKFLOW");

  // 查找触发的 workflow run（最多等待约 30 秒）
  let run = null;
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const runs = await safeGitHubRequest(
      `https://api.github.com/repos/${config.owner}/${config.repo}/actions/runs?head_sha=${updateResult.commit.sha}&per_page=1`,
      config.token
    );
    if (runs.workflow_runs && runs.workflow_runs.length > 0) {
      run = runs.workflow_runs[0];
      break;
    }
  }

  if (!run) {
    throw new Error("未检测到 Workflow 被触发");
  }

  await kv.put(`IMAGE_FOR_WORKFLOW_${run.id}`, body.content);
  return { ok: true };
}

// ====================== Webhook 处理 ======================
async function handleWebhook(request, kv) {
  if (request.method !== "POST") return new Response("OK");

  const payload = await request.json();
  if (payload.workflow_run) {
    const info = {
      id: payload.workflow_run.id,
      status: payload.workflow_run.status,
      conclusion: payload.workflow_run.conclusion,
      time: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
    };
    await kv.put("LAST_WORKFLOW", JSON.stringify(info));

    if (payload.workflow_run.status === "completed") {
      const run_id = payload.workflow_run.id;
      const image = await kv.get(`IMAGE_FOR_WORKFLOW_${run_id}`);
      if (image) {
        const status_key = `IMAGE_STATUS_${image.replace(/[:/]/g, "_")}`;
        await kv.put(status_key, payload.workflow_run.conclusion === "success" ? "ready" : "failed");
      }
    }
  }
  return new Response(JSON.stringify({ ok: true }), { status: 200 });
}

// ====================== 工具函数 ======================
async function safeGitHubRequest(url, token, options = {}) {
  const resp = await fetch(url, {
    ...options,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Accept": "application/vnd.github+json",
      "User-Agent": "Cloudflare-Docker-Proxy"
    }
  });
  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); } catch (e) { throw new Error("GitHub 返回非 JSON"); }
  if (!resp.ok) throw new Error(data.message || "GitHub API 错误");
  return data;
}

function base64Encode(str) {
  const bytes = new TextEncoder().encode(str);
  return btoa(String.fromCharCode(...bytes));
}

function dockerError(status, code, message, retryAfter = null) {
  const body = JSON.stringify({
    errors: [{ code, message }]
  });
  const headers = {
    "Content-Type": "application/json",
    "Docker-Distribution-Api-Version": "registry/2.0"
  };
  if (retryAfter) headers["Retry-After"] = retryAfter;
  return new Response(body, { status, headers });
}
