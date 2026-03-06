/**
 * Cloudflare Worker - Docker 注册表代理 + 自动构建
 * 域名：tlju.qzz.io
 * 配置全部存放在 KV 命名空间 DOCKER_KV 中：
 * - ALIYUN_REGISTRY（默认 registry.cn-hangzhou.aliyuncs.com/tlju-docker-images）
 * - ALIYUN_USERNAME（阿里云 ACR 用户名，用于认证）
 * - ALIYUN_PASSWORD（阿里云 ACR 密码，用于认证）
 * - GITHUB_OWNER / GITHUB_REPO / FILE_PATH / BRANCH / GITHUB_TOKEN
 *
 * 使用方法：
 * 1. 把 https://tlju.qzz.io 加入 /etc/docker/daemon.json 的 registry-mirrors
 * 2. docker pull redis / python / nginx …… 全部自动触发构建并拉取
 * 
 * 优化：manifests tag 总是从 Hub 代理（获取层信息），并后台触发构建；blobs 返回 503 直到 ACR 构建完成，然后从 ACR 转发
 * 支持私有 ACR 认证，使用 Docker Registry token 流程
 * 修改：只用 LAST_WORKFLOW KV，支持单个 workflow，增加 503 响应中的状态信息
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
    token: await kv.get("GITHUB_TOKEN")
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

  // 标记为正在构建，存入 content
  const info = {
    status: 'building',
    content: body.content,
    time: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
  };
  await kv.put("LAST_WORKFLOW", JSON.stringify(info));

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
    info.status = 'failed';
    await kv.put("LAST_WORKFLOW", JSON.stringify(info));
    throw new Error('未找到触发的 Workflow');
  }

  info.id = run.id;
  await kv.put("LAST_WORKFLOW", JSON.stringify(info));
  return { ok: true, sha: updateResult.commit.sha };
}

/** ====================== GitHub Webhook ====================== */
async function handleWebhook(request, kv) {
  if (request.method !== "POST") return new Response("OK");
  const payload = await request.json();

  if (payload.workflow_run) {
    // 获取当前 LAST_WORKFLOW
    let current = await kv.get("LAST_WORKFLOW");
    current = current ? JSON.parse(current) : null;

    // 只处理匹配的 workflow id
    if (current && current.id === payload.workflow_run.id) {
      const info = {
        id: payload.workflow_run.id,
        name: payload.workflow_run.name,
        status: payload.workflow_run.status,
        conclusion: payload.workflow_run.conclusion,
        head_branch: payload.workflow_run.head_branch,
        updated_at: payload.workflow_run.updated_at,
        time: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
        content: current.content  // 保留镜像名
      };
      await kv.put("LAST_WORKFLOW", JSON.stringify(info));
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

  // 阿里云 proxy path：添加 repoPrefix
  let acr_proxy_path = pathname.replace(/^\/v2\/(library\/)?/, `/v2/${repoPrefix}/`);
  const acr_proxy_url = `${aliyun_base}${acr_proxy_path}${url.search}`;

  // Docker Hub proxy path：保持原样（官方镜像有 library/）
  const hub_base = 'https://registry-1.docker.io';
  const hub_proxy_url = `${hub_base}${pathname}${url.search}`;

  // 从 KV 获取 ACR 认证信息
  const username = await kv.get("ALIYUN_USERNAME");
  const password = await kv.get("ALIYUN_PASSWORD");
  if (!username || !password) {
    return new Response("KV 缺少 ALIYUN_USERNAME 或 ALIYUN_PASSWORD", { status: 500 });
  }

  // 解析镜像名（用于比较）
  let content = null;
  const parts = pathname.split('/');
  if (parts.length >= 3) {
    const image_name = parts.slice(2, parts.length - 2).join("/") || parts[2];
    const tag = (parts[parts.length - 1] && !parts[parts.length - 1].startsWith("sha256:")) ? parts[parts.length - 1] : "latest";
    content = image_name.replace(/^library\//, "") + ":" + tag;
  }

  // 获取当前 LAST_WORKFLOW 状态
  let last_workflow = await kv.get("LAST_WORKFLOW");
  last_workflow = last_workflow ? JSON.parse(last_workflow) : null;

  // ====================== 处理 manifests 请求 ======================
  if (parts.length >= 4 && parts[parts.length - 2] === "manifests") {
    const ref = parts[parts.length - 1];

    // 总是从 Hub 代理 manifest，并后台触发构建如果未 start 或不匹配当前镜像
    const hub_response = await proxyWithAuth(hub_proxy_url, request, null, null, false); // Hub auth
    if (hub_response.ok) {
      // 如果 Hub 有，检查是否需要触发构建
      if (!last_workflow || last_workflow.content !== content || last_workflow.status !== 'building' && last_workflow.status !== 'completed') {
        try {
          await handleUpdate({ content }, kv);
        } catch (err) {
          // 忽略错误，继续返回 Hub manifest
        }
      }
      return hub_response;
    } else {
      // Hub 无，返回错误（如 404）
      return hub_response;
    }
  }

  // ====================== 处理 blobs 请求 ======================
  if (parts.length >= 4 && parts[parts.length - 2] === "blobs") {
    // blobs 总是尝试从 ACR，如果 LAST_WORKFLOW 是当前镜像且 ready，返回；否则 503 + 状态信息
    if (last_workflow && last_workflow.content === content && last_workflow.status === 'completed' && last_workflow.conclusion === 'success') {
      return await proxyWithAuth(acr_proxy_url, request, username, password, true); // ACR auth
    } else if (last_workflow && last_workflow.content === content && last_workflow.status === 'building') {
      const msg = `镜像 ${content} 正在构建中，当前状态: ${last_workflow.status}，更新时间: ${last_workflow.time}`;
      return new Response(msg, { status: 503, headers: { "Retry-After": "60" } });
    } else if (last_workflow && last_workflow.content === content && last_workflow.status === 'failed') {
      const msg = `镜像 ${content} 构建失败，结论: ${last_workflow.conclusion}，更新时间: ${last_workflow.time}`;
      return new Response(msg, { status: 500 });
    } else {
      // 未开始或不匹配，应在 manifest 时已触发，但以防万一
      if (content) {
        try {
          await handleUpdate({ content }, kv);
        } catch (err) {
          return new Response("启动构建失败: " + err.message, { status: 500 });
        }
      }
      const msg = `启动 ${content} 构建，请重试...`;
      return new Response(msg, { status: 503, headers: { "Retry-After": "60" } });
    }
  }

  // ====================== 其他请求（如 tags/list） ======================
  // 默认从 Hub 代理
  return await proxyWithAuth(hub_proxy_url, request, null, null, false);
}

/** ====================== 代理请求 + 处理认证挑战 ====================== */
// isACR: true for ACR (use basic auth for token), false for Hub (anonymous token)
async function proxyWithAuth(proxy_url, request, username, password, isACR) {
  let response = await fetch(proxy_url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    redirect: "follow"
  });

  if (response.status === 401) {
    const wwwAuth = response.headers.get("WWW-Authenticate");
    if (!wwwAuth) {
      throw new Error("No WWW-Authenticate header in 401 response");
    }

    // 解析 WWW-Authenticate
    const authParams = new Map(wwwAuth.replace('Bearer ', '').split(',').map(p => p.trim().split('=').map(s => s.replace(/"/g, ''))));
    const realm = authParams.get('realm');
    const service = authParams.get('service');
    const scope = authParams.get('scope');

    if (!realm) {
      throw new Error("No realm in WWW-Authenticate");
    }

    // 构建 token URL
    let tokenUrl = `${realm}?service=${service}`;
    if (scope) {
      tokenUrl += `&scope=${encodeURIComponent(scope)}`;
    }

    // 请求 token：ACR 用 basic auth，Hub 匿名
    const tokenHeaders = new Headers();
    if (isACR) {
      const basicAuth = `Basic ${btoa(`${username}:${password}`)}`;
      tokenHeaders.set("Authorization", basicAuth);
    }

    const tokenResponse = await fetch(tokenUrl, { headers: tokenHeaders });

    if (!tokenResponse.ok) {
      throw new Error(`Failed to get token: ${tokenResponse.status}`);
    }

    const tokenData = await tokenResponse.json();
    const token = tokenData.token || tokenData.access_token;

    if (!token) {
      throw new Error("No token in response");
    }

    // 用 Bearer token 重试
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
