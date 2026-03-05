/**
 * Cloudflare Worker - Docker 注册表代理 + 自动构建
 * 域名：tlju.qzz.io
 * 配置全部存放在 KV 命名空间 DOCKER_KV 中：
 * - ALIYUN_REGISTRY（默认 registry.cn-hangzhou.aliyuncs.com/tlju-docker-images）
 * - ALIYUN_ACCESS_KEY_ID（阿里云 AK，用于获取临时 token）
 * - ALIYUN_ACCESS_KEY_SECRET（阿里云 SK，用于签名 API 请求）
 * - ALIYUN_REGION（例如 cn-hangzhou）
 * - ALIYUN_INSTANCE_ID（企业版实例 ID，个人版留空 ''）
 * - GITHUB_OWNER / GITHUB_REPO / FILE_PATH / BRANCH / GH_TOKEN
 *
 * 使用方法：
 * 1. 把 https://tlju.qzz.io 加入 /etc/docker/daemon.json 的 registry-mirrors
 * 2. docker pull redis / python / nginx …… 全部自动触发构建并拉取
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

/** ====================== 阿里云 ACR 临时 token 获取 ====================== */
async function getAcrAuth(kv) {
  const tokenKey = "ALIYUN_ACR_TOKEN";
  const usernameKey = "ALIYUN_ACR_USERNAME";
  const tokenTtl = 1800; // 30 分钟缓存（token 有效 1 小时）

  let token = await kv.get(tokenKey);
  let tempUsername = await kv.get(usernameKey);

  if (token && tempUsername) {
    return `Basic ${btoa(`${tempUsername}:${token}`)}`;
  }

  const accessKeyId = await kv.get("ALIYUN_ACCESS_KEY_ID");
  const accessKeySecret = await kv.get("ALIYUN_ACCESS_KEY_SECRET");
  const region = await kv.get("ALIYUN_REGION") || "cn-hangzhou";
  const instanceId = await kv.get("ALIYUN_INSTANCE_ID") || ""; // 个人版为空

  if (!accessKeyId || !accessKeySecret || !region) {
    throw new Error("KV 缺少 ALIYUN_ACCESS_KEY_ID, ALIYUN_ACCESS_KEY_SECRET 或 ALIYUN_REGION");
  }

  // 构建阿里云 API 请求参数
  const params = {
    Action: "GetAuthorizationToken",
    Format: "JSON",
    Version: "2016-06-07",
    AccessKeyId: accessKeyId,
    SignatureMethod: "HMAC-SHA1",
    Timestamp: new Date().toISOString().replace(/\.\d{3}/, ""),
    SignatureVersion: "1.0",
    SignatureNonce: crypto.randomUUID(),
  };
  if (instanceId) {
    params.InstanceId = instanceId;
  }

  // 排序 params 并构建 stringToSign
  const sortedParams = Object.keys(params).sort().map(key => `${encodeURIComponent(key)}=${encodeURIComponent(params[key])}`).join('&');
  const stringToSign = `GET&%2F&${encodeURIComponent(sortedParams)}`;

  // HMAC-SHA1 签名
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(accessKeySecret + "&"), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(stringToSign));
  const signature = btoa(String.fromCharCode(...new Uint8Array(sig)));

  params.Signature = signature;

  // 构建 API URL
  const apiUrl = `https://cr.${region}.aliyuncs.com/?${Object.keys(params).map(key => `${key}=${encodeURIComponent(params[key])}`).join('&')}`;

  // 调用 API
  const response = await fetch(apiUrl);
  const data = await response.json();

  if (!response.ok || data.code !== "OK") {
    throw new Error(`获取 ACR token 失败: ${data.message || data.error}`);
  }

  token = data.data.AuthorizationToken;
  tempUsername = data.data.TempUserName || "cr_temp_user";

  // 缓存 token 和 username
  await kv.put(tokenKey, token, { expirationTtl: tokenTtl });
  await kv.put(usernameKey, tempUsername, { expirationTtl: tokenTtl });

  return `Basic ${btoa(`${tempUsername}:${token}`)}`;
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

  // 关键修复：强制加上命名空间前缀
  let proxy_path = pathname.replace(/^\/v2\/(library\/)?/, `/v2/${repoPrefix}/`);

  const proxy_url = `${aliyun_base}${proxy_path}${url.search}`;

  // ====================== 获取阿里云临时认证 ======================
  const auth = await getAcrAuth(kv);

  // ====================== 清单请求（manifests）才做状态检查与触发 ======================
  const parts = pathname.split('/');
  if (parts.length >= 4 && parts[parts.length - 2] === "manifests") {
    const ref = parts[parts.length - 1];
    if (ref.startsWith("sha256:")) {
      // 摘要请求直接代理（带认证）
      return await fetch(proxy_url, { 
        method: request.method, 
        headers: { ...request.headers, Authorization: auth }, 
        body: request.body, 
        redirect: "follow" 
      });
    }

    const image_name = parts.slice(2, parts.length - 2).join("/");
    const tag = ref || "latest";
    // 去掉 library/ 前缀，得到实际镜像名 python:latest
    const content = image_name.replace(/^library\//, "") + ":" + tag;

    const status_key = `IMAGE_STATUS_${content.replace(/[:/]/g, "_")}`;
    const status = await kv.get(status_key);

    if (status === "ready") {
      // 已构建好，直接代理（带认证）
      return await fetch(proxy_url, { 
        method: request.method, 
        headers: { ...request.headers, Authorization: auth }, 
        body: request.body, 
        redirect: "follow" 
      });
    }

    if (status === "building") {
      return new Response("镜像正在构建中，请稍后重试...", { status: 503, headers: { "Retry-After": "30" } });
    }

    if (status === "failed") {
      return new Response("镜像构建失败", { status: 500 });
    }

    // 第一次请求 → 触发构建
    try {
      await handleUpdate({ content }, kv);
    } catch (err) {
      return new Response("启动构建失败: " + err.message, { status: 500 });
    }

    return new Response("正在启动构建，请稍后重试...", {
      status: 503,
      headers: { "Retry-After": "30" }
    });
  }

  // 其他请求（blobs、tags/list 等）直接代理（带认证）
  return await fetch(proxy_url, { 
    method: request.method, 
    headers: { ...request.headers, Authorization: auth }, 
    body: request.body, 
    redirect: "follow" 
  });
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
