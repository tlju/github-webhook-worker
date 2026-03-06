/**
 * Cloudflare Worker - Docker 注册表代理 + 自动构建
 * 域名：tlju.qzz.io
 * 配置全部存放在 KV 命名空间 DOCKER_KV 中：
 * - ALIYUN_REGISTRY（默认 registry.cn-hangzhou.aliyuncs.com/tlju-docker-images）
 * - ALIYUN_USERNAME（阿里云 ACR 用户名，用于认证）
 * - ALIYUN_PASSWORD（阿里云 ACR 密码，用于认证）
 * - GITHUB_OWNER / GITHUB_REPO / FILE_PATH / BRANCH / GH_TOKEN
 *
 * 使用方法：
 * 1. 把 https://tlju.qzz.io 加入 /etc/docker/daemon.json 的 registry-mirrors
 * 2. docker pull redis / python / nginx …… 全部自动触发构建并拉取
 * 
 * 新增：支持私有 ACR 仓库认证，使用 Docker Registry token 认证流程（处理 401 challenge，获取 Bearer token）
 * 优化：对于 manifests tag 请求，先尝试代理，如果 200 则 set ready 并返回；如果 404 则检查状态/触发构建，返回 503 让 Docker 重试
 * 新流程：当镜像不存在时，从官方 Docker Hub 获取 manifest 返回给客户端（让 Docker 开始 pull layers），layers 请求返回 503 重试，直到构建完成
 */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const kv = env.DOCKER_KV;
    if (!kv) {
      return new Response("KV 绑定错误：请确保绑定名为 DOCKER_KV 的命名空间", { status: 500 });
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
      return json({ error: "Worker 内部错误", message: err.message, stack: err.stack }, 500);
    }
  }
};

/** ====================== GitHub 文件更新（触发 Workflow） ====================== */
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

  // 获取当前文件 SHA
  const getUrl = `https://api.github.com/repos/${config.owner}/${config.repo}/contents/${config.path}?ref=${config.branch}`;
  const fileData = await safeGitHubRequest(getUrl, config.token);

  // 更新文件内容（触发 GitHub Action）
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

  // 标记为正在构建
  const status_key = `IMAGE_STATUS_${body.content.replace(/[:/]/g, '_')}`;
  await kv.put(status_key, 'building');

  // 轮询找到刚触发的 workflow run ID（最多等 30 秒）
  let run = null;
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const runs = await safeGitHubRequest(
      `https://api.github.com/repos/${config.owner}/${config.repo}/actions/runs?head_sha=${updateResult.commit.sha}&per_page=1`,
      config.token
    );
    if (runs.workflow_runs?.length > 0) {
      run = runs.workflow_runs[0];
      break;
    }
  }
  if (!run) {
    await kv.put(status_key, 'failed');
    throw new Error('未找到触发的 Workflow');
  }

  await kv.put(`IMAGE_FOR_WORKFLOW_${run.id}`, body.content);
  return { ok: true, sha: updateResult.commit.sha };
}

/** ====================== GitHub Webhook ====================== */
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
        await kv.put(status_key, payload.workflow_run.conclusion === "success" ? 'ready' : 'failed');
      }
    }
  }
  return json({ ok: true });
}

/** ====================== 核心：Registry 代理 + 自动触发构建 ====================== */
async function handleRegistry(request, kv, url) {
  const pathname = url.pathname;

  // Docker v2 协议 ping
  if (pathname === "/v2/" || pathname === "/v2") {
    return new Response("", {
      status: 200,
      headers: { "Docker-Distribution-Api-Version": "registry/2.0" }
    });
  }

  // ====================== 阿里云路径修正 ======================
  const aliyunRegistry = await kv.get("ALIYUN_REGISTRY") || "registry.cn-hangzhou.aliyuncs.com/tlju-docker-images";
  const [registryHost, ...repoParts] = aliyunRegistry.split('/');
  const repoPrefix = repoParts.join('/');                    // tlju-docker-images
  const aliyun_base = `https://${registryHost}`;

  // 强制加上命名空间前缀
  let proxy_path = pathname.replace(/^\/v2\/(library\/)?/, `/v2/${repoPrefix}/`);

  const proxy_url = `${aliyun_base}${proxy_path}${url.search}`;

  // 从 KV 获取认证信息
  const username = await kv.get("ALIYUN_USERNAME");
  const password = await kv.get("ALIYUN_PASSWORD");
  if (!username || !password) {
    return new Response("KV 缺少 ALIYUN_USERNAME 或 ALIYUN_PASSWORD", { status: 500 });
  }

  // ====================== 处理清单请求（manifests） ======================
  const parts = pathname.split('/');
  if (parts.length >= 4 && parts[parts.length - 2] === "manifests") {
    const ref = parts[parts.length - 1];
    if (ref.startsWith("sha256:")) {
      // 摘要请求直接代理到阿里云（带认证）
      return await proxyWithAuth(proxy_url, request, username, password);
    }

    const image_name = parts.slice(2, parts.length - 2).join("/");
    const tag = ref || "latest";
    const content = image_name.replace(/^library\//, "") + ":" + tag;

    const status_key = `IMAGE_STATUS_${content.replace(/[:/]/g, "_")}`;
    const status = await kv.get(status_key);

    if (status === "ready") {
      // 已就绪，直接代理阿里云 manifest
      return await proxyWithAuth(proxy_url, request, username, password);
    } else if (status === "building") {
      // 构建中，对于 manifest，返回官方 manifest，让 Docker 开始 pull layers
      return await getOfficialManifest(request, image_name, tag);
    } else if (status === "failed") {
      return new Response("镜像构建失败", { status: 500 });
    } else {
      // 不存在，先尝试代理阿里云
      let aliResponse = await proxyWithAuth(proxy_url, request, username, password);
      if (aliResponse.ok) {
        await kv.put(status_key, "ready");
        return aliResponse;
      } else if (aliResponse.status !== 404) {
        return aliResponse; // 其他错误直接返回
      }

      // 阿里云 404，触发构建，并返回官方 manifest
      try {
        await handleUpdate({ content }, kv);
      } catch (err) {
        return new Response("启动构建失败: " + err.message, { status: 500 });
      }

      return await getOfficialManifest(request, image_name, tag);
    }
  }

  // ====================== 处理 blobs (layers) 请求 ======================
  if (parts.length >= 4 && parts[parts.length - 2] === "blobs") {
    const digest = parts[parts.length - 1];
    // 尝试从阿里云获取
    let response = await proxyWithAuth(proxy_url, request, username, password);
    if (response.ok) {
      return response;
    } else if (response.status === 404) {
      // 如果 404，返回 503 让 Docker 重试
      return new Response("Layer is building, retry later", {
        status: 503,
        headers: { "Retry-After": "30" }
      });
    } else {
      return response;
    }
  }

  // 其他请求（如 tags/list）直接代理到阿里云
  return await proxyWithAuth(proxy_url, request, username, password);
}

/** ====================== 新增：从官方 Docker Hub 获取 manifest ====================== */
async function getOfficialManifest(request, image_name, tag) {
  const official_base = "https://registry-1.docker.io";
  const official_path = `/v2/${image_name}/manifests/${tag}`;
  const official_url = `${official_base}${official_path}`;

  // Docker Hub 也需要认证，类似阿里云
  let response = await fetch(official_url, {
    method: request.method,
    headers: request.headers,
    redirect: "follow"
  });

  if (response.status === 401) {
    const wwwAuth = response.headers.get("WWW-Authenticate");
    if (!wwwAuth) {
      throw new Error("No WWW-Authenticate for Docker Hub");
    }

    const authParams = new Map(wwwAuth.split(',').map(p => p.trim().split('=').map(s => s.replace(/"/g, ''))));
    const realm = authParams.get('realm');
    const service = authParams.get('service');
    const scope = authParams.get('scope');

    let tokenUrl = `${realm}?service=${service}`;
    if (scope) {
      tokenUrl += `&scope=${encodeURIComponent(scope)}`;
    }

    // Docker Hub token 请求无需 Basic Auth（匿名 pull）
    const tokenResponse = await fetch(tokenUrl);
    if (!tokenResponse.ok) {
      throw new Error(`Failed to get Docker Hub token: ${tokenResponse.status}`);
    }

    const tokenData = await tokenResponse.json();
    const token = tokenData.token || tokenData.access_token;

    const authHeaders = new Headers(request.headers);
    authHeaders.set("Authorization", `Bearer ${token}`);

    response = await fetch(official_url, {
      method: request.method,
      headers: authHeaders,
      redirect: "follow"
    });
  }

  if (!response.ok) {
    return new Response("Failed to get official manifest", { status: response.status });
  }

  // 返回官方 manifest，headers 需调整（Content-Type 等）
  const headers = new Headers(response.headers);
  headers.set("Docker-Content-Digest", await response.headers.get("Docker-Content-Digest") || "");
  return new Response(await response.blob(), { status: 200, headers });
}

/** ====================== 代理请求 + 处理 ACR 认证挑战 ====================== */
async function proxyWithAuth(proxy_url, request, username, password) {
  let response = await fetch(proxy_url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    redirect: "follow"
  });

  if (response.status === 401) {
    // 处理 401 Unauthorized，获取 token
    const wwwAuth = response.headers.get("WWW-Authenticate");
    if (!wwwAuth) {
      throw new Error("No WWW-Authenticate header in 401 response");
    }

    // 解析 WWW-Authenticate
    const authParams = new Map(wwwAuth.split(',').map(p => p.trim().split('=').map(s => s.replace(/"/g, ''))));
    const realm = authParams.get('realm') || authParams.get('Bearer realm');
    const service = authParams.get('service');
    const scope = authParams.get('scope');

    if (!realm) {
      throw new Error("No realm in WWW-Authenticate");
    }

    // 构建 token 请求 URL
    let tokenUrl = `${realm}?service=${service}`;
    if (scope) {
      tokenUrl += `&scope=${encodeURIComponent(scope)}`;
    }

    // 使用 Basic Auth 请求 token
    const basicAuth = `Basic ${btoa(`${username}:${password}`)}`;
    const tokenResponse = await fetch(tokenUrl, {
      headers: { Authorization: basicAuth }
    });

    if (!tokenResponse.ok) {
      throw new Error(`Failed to get token: ${tokenResponse.status}`);
    }

    const tokenData = await tokenResponse.json();
    const token = tokenData.token || tokenData.access_token;

    if (!token) {
      throw new Error("No token in response");
    }

    // 用 Bearer token 重试原请求
    const authHeaders = new Headers(request.headers);
    authHeaders.set("Authorization", `Bearer ${token}`);

    response = await fetch(proxy_url, {
      method: request.method,
      headers: authHeaders,
      body: request.body,
      redirect: "follow"
    });
  }

  return response;
}

/** ====================== 工具函数 ====================== */
async function safeGitHubRequest(url, token, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "Cloudflare-Worker-Docker-Updater",
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch (e) { throw new Error("GitHub 返回非 JSON"); }
  if (!response.ok) throw new Error(data.message || "GitHub API 错误");
  return data;
}

function base64Encode(str) {
  const bytes = new TextEncoder().encode(str);
  const binString = String.fromCharCode(...bytes);
  return btoa(binString);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}
