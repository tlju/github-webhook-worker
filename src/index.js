export default {
  /**
   * Worker 入口函数
   * @param {Request} request 
   * @param {object} env 环境变量，包含 KV 绑定 DOCKER_KV
   */
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
      // 1️⃣ 处理 Docker Token 鉴权代理
      if (url.pathname === "/v2/auth") {
        return await handleAuth(request, kv);
      }

      // 2️⃣ 处理 Docker Registry 路由 (反向代理到阿里云)
      if (url.pathname.startsWith("/v2/")) {
        return await handleRegistry(request, kv);
      }

      // 3️⃣ 处理业务路由 (GitHub 更新)
      if (url.pathname === "/update") {
        return await handleUpdate(request, kv);
      }

      // 4️⃣ 处理业务路由 (Webhook)
      if (url.pathname === "/webhook") {
        return await handleWebhook(request, kv);
      }

      return jsonResponse({ error: "Not Found" }, 404);
    } catch (err) {
      return jsonResponse({ error: err.message || "Internal Error" }, 500);
    }
  },
};

/**
 * Docker Registry 代理逻辑
 * 拦截请求，修改路径，处理 401 鉴权挑战
 */
async function handleRegistry(request, kv) {
  const url = new URL(request.url);
  
  // 从 KV 获取目标 Registry
  const targetHost = await kv.get("ALIYUN_REGISTRY");
  if (!targetHost) {
    return jsonResponse({ error: "KV 缺少 ALIYUN_REGISTRY 配置" }, 500);
  }
  
  // 你的目标命名空间 (如果以后有变，也可以提出来放进 KV)
  const targetNamespace = "tlju-docker-images";

  let targetPath = url.pathname;

  // 核心逻辑：路径重写
  // 匹配类似 /v2/library/python/manifests/latest
  if (targetPath !== "/v2/" && targetPath !== "/v2") {
    const match = targetPath.match(/^\/v2\/(.+)\/(manifests|blobs)\/(.+)$/);
    if (match) {
      const originalRepo = match[1]; // 例如 "library/python"
      const action = match[2];       // "manifests" 或 "blobs"
      const reference = match[3];    // "latest" 或 "sha256:..."

      const imageName = originalRepo.split('/').pop();
      targetPath = `/v2/${targetNamespace}/${imageName}/${action}/${reference}`;
    }
  }

  const targetUrl = new URL(`https://${targetHost}${targetPath}${url.search}`);

  const headers = new Headers(request.headers);
  headers.set("Host", targetHost);

  const fetchInit = {
    method: request.method,
    headers: headers,
    // 关键：必须设为 manual。这样当阿里云返回 OSS 的下载链接 (307) 时，
    // Worker 会把链接直接丢给 Docker 客户端，让 Docker 直接去 OSS 下载，既省 Worker 流量又防止鉴权头冲突。
    redirect: "manual", 
  };

  if (request.method !== "GET" && request.method !== "HEAD") {
    fetchInit.body = request.body;
  }

  // 向阿里云发起请求
  const response = await fetch(targetUrl, fetchInit);
  const proxyResponse = new Response(response.body, response);

  // 🌟 无感鉴权核心：拦截 401，篡改 Www-Authenticate 的 realm
  if (proxyResponse.status === 401) {
    const authHeader = proxyResponse.headers.get("Www-Authenticate");
    if (authHeader && authHeader.startsWith("Bearer ")) {
      const realmMatch = authHeader.match(/realm="([^"]+)"/);
      if (realmMatch) {
        const originalRealm = realmMatch[1];
        // 把真实的鉴权地址藏在 url 参数里，让 Docker 客户端来请求 Worker 的 /v2/auth
        const newRealm = `https://${url.host}/v2/auth?upstream_realm=${encodeURIComponent(originalRealm)}`;
        const newAuthHeader = authHeader.replace(originalRealm, newRealm);
        proxyResponse.headers.set("Www-Authenticate", newAuthHeader);
      }
    }
  }

  proxyResponse.headers.set("Access-Control-Allow-Origin", "*");
  return proxyResponse;
}

/**
 * 代理获取 Token
 * 使用 KV 里的账密，帮客户端从真实的阿里云 Auth 服务器获取 Token
 */
async function handleAuth(request, kv) {
  const url = new URL(request.url);
  
  // 拿到刚才藏起来的真实鉴权地址
  const upstreamRealm = url.searchParams.get("upstream_realm");
  if (!upstreamRealm) {
    return jsonResponse({ error: "Missing upstream_realm parameter" }, 400);
  }

  // 重组请求阿里云的 URL（带上 service 和 scope 等参数）
  const upstreamUrl = new URL(upstreamRealm);
  url.searchParams.forEach((value, key) => {
    if (key !== "upstream_realm") {
      upstreamUrl.searchParams.append(key, value);
    }
  });

  // 并发读取账号密码
  const [user, pass] = await Promise.all([
    kv.get("ALIYUN_REGISTRY_USER"),
    kv.get("ALIYUN_REGISTRY_PASSWORD")
  ]);

  const headers = new Headers();
  headers.set("Accept", request.headers.get("Accept") || "application/json");
  headers.set("User-Agent", request.headers.get("User-Agent") || "Cloudflare-Worker-Proxy");

  // 将账密转为 Basic 认证头注入
  if (user && pass) {
    const authStr = btoa(`${user}:${pass}`);
    headers.set("Authorization", `Basic ${authStr}`);
  }

  // 去阿里云真正获取 Token
  const tokenRes = await fetch(upstreamUrl.toString(), {
    method: "GET",
    headers: headers
  });

  const proxyTokenRes = new Response(tokenRes.body, tokenRes);
  proxyTokenRes.headers.set("Access-Control-Allow-Origin", "*");
  return proxyTokenRes;
}

//////////////////////////////////////////////////////
// 更新 GitHub 文件接口 (保持不变)
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
// Webhook 接收接口 (保持不变)
//////////////////////////////////////////////////////
async function handleWebhook(request, kv) {
  if (request.method !== "POST") return new Response("OK");
  const secret = await kv.get("WEBHOOK_SECRET");
  const signature = request.headers.get("x-hub-signature-256");
  const rawBody = await request.text();

  if (!(await verifySignature(rawBody, signature, secret))) return jsonResponse({ error: "Invalid signature" }, 401);

  const payload = JSON.parse(rawBody);
  if (payload.action === "completed" && payload.workflow_run) {
    return jsonResponse({
      workflow: payload.workflow_run.name, status: payload.workflow_run.status, conclusion: payload.workflow_run.conclusion
    });
  }
  return jsonResponse({ message: "Event received and verified" });
}

//////////////////////////////////////////////////////
// 工具函数 (保持不变)
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
