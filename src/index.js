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
      // 调试信息
      console.log("Request path:", url.pathname);
      console.log("Request method:", request.method);
      
      // 1️⃣ 处理 Docker Token 鉴权代理
      if (url.pathname === "/v2/auth") {
        return await handleAuth(request, kv);
      }

      // 2️⃣ 处理 Docker Registry 路径映射
      if (url.pathname.startsWith("/v2/")) {
        return await handleRegistry(request, kv);
      }

      // 3️⃣ 调试接口
      if (url.pathname === "/debug") {
        return await handleDebug(request, kv);
      }

      // 4️⃣ 处理业务路由 (GitHub 更新)
      if (url.pathname === "/update") {
        return await handleUpdate(request, kv);
      }

      // 5️⃣ 处理业务路由 (Webhook)
      if (url.pathname === "/webhook") {
        return await handleWebhook(request, kv);
      }

      return jsonResponse({ error: "Not Found" }, 404);
    } catch (err) {
      console.error("Error in fetch:", err);
      return jsonResponse({ error: err.message || "Internal Error" }, 500);
    }
  },
};

/**
 * Docker Registry 代理逻辑 - 修复版本
 */
async function handleRegistry(request, kv) {
  const url = new URL(request.url);
  
  // 从 KV 获取目标 Registry
  const targetHost = await kv.get("ALIYUN_REGISTRY");
  if (!targetHost) {
    return jsonResponse({ error: "KV 缺少 ALIYUN_REGISTRY 配置" }, 500);
  }
  
  // 目标命名空间
  const targetNamespace = await kv.get("TARGET_NAMESPACE") || "tlju-docker-images";

  let targetPath = url.pathname;

  // 路径重写逻辑
  if (targetPath !== "/v2/" && targetPath !== "/v2") {
    const match = targetPath.match(/^\/v2\/(.+)\/(manifests|blobs)\/(.+)$/);
    if (match) {
      const originalRepo = match[1];
      const action = match[2];
      const reference = match[3];

      // 从原始仓库名提取镜像名
      const parts = originalRepo.split('/');
      let imageName = originalRepo; // 默认使用完整路径
      
      // 如果是 library/ 前缀，则只取最后一部分
      if (originalRepo.startsWith('library/')) {
        imageName = parts[parts.length - 1];
      } else {
        // 如果包含多个部分，用连字符连接
        imageName = parts.join('-');
      }
      
      targetPath = `/v2/${targetNamespace}/${imageName}/${action}/${reference}`;
    }
  }

  const targetUrl = new URL(`https://${targetHost}${targetPath}${url.search}`);

  console.log("Original path:", url.pathname);
  console.log("Target path:", targetPath);
  console.log("Target URL:", targetUrl.toString());

  const headers = new Headers(request.headers);
  headers.set("Host", targetHost);

  const fetchInit = {
    method: request.method,
    headers: headers,
    redirect: "manual", 
  };

  if (request.method !== "GET" && request.method !== "HEAD") {
    fetchInit.body = request.body;
  }

  // 向阿里云发起请求
  try {
    const response = await fetch(targetUrl, fetchInit);
    const proxyResponse = new Response(response.body, response);

    // 处理 401 鉴权
    if (proxyResponse.status === 401) {
      const authHeader = proxyResponse.headers.get("Www-Authenticate");
      if (authHeader && authHeader.startsWith("Bearer ")) {
        const realmMatch = authHeader.match(/realm="([^"]+)"/);
        if (realmMatch) {
          const originalRealm = realmMatch[1];
          const newRealm = `https://${url.host}/v2/auth?upstream_realm=${encodeURIComponent(originalRealm)}`;
          const newAuthHeader = authHeader.replace(originalRealm, newRealm);
          proxyResponse.headers.set("Www-Authenticate", newAuthHeader);
        }
      }
    }

    proxyResponse.headers.set("Access-Control-Allow-Origin", "*");
    return proxyResponse;
  } catch (error) {
    console.error("Fetch error:", error);
    return jsonResponse({ error: `Upstream request failed: ${error.message}` }, 502);
  }
}

/**
 * 代理获取 Token - 修复版本
 */
async function handleAuth(request, kv) {
  const url = new URL(request.url);
  
  // 拿到真实鉴权地址
  const upstreamRealm = url.searchParams.get("upstream_realm");
  if (!upstreamRealm) {
    return jsonResponse({ error: "Missing upstream_realm parameter" }, 400);
  }

  // 重组请求阿里云的 URL
  const upstreamUrl = new URL(upstreamRealm);
  url.searchParams.forEach((value, key) => {
    if (key !== "upstream_realm") {
      upstreamUrl.searchParams.append(key, value);
    }
  });

  console.log("Auth request to:", upstreamUrl.toString());

  // 并发读取账号密码
  const [user, pass] = await Promise.all([
    kv.get("ALIYUN_REGISTRY_USER"),
    kv.get("ALIYUN_REGISTRY_PASSWORD")
  ]);

  if (!user || !pass) {
    return jsonResponse({ error: "Missing ALIYUN_REGISTRY credentials in KV" }, 500);
  }

  const headers = new Headers();
  headers.set("Accept", request.headers.get("Accept") || "application/json");
  headers.set("User-Agent", request.headers.get("User-Agent") || "Cloudflare-Worker-Proxy");

  // 设置 Basic 认证
  const authStr = btoa(`${user}:${pass}`);
  headers.set("Authorization", `Basic ${authStr}`);

  try {
    // 去阿里云获取 Token
    const tokenRes = await fetch(upstreamUrl.toString(), {
      method: "GET",
      headers: headers
    });

    console.log("Auth response status:", tokenRes.status);

    if (!tokenRes.ok) {
      const errorText = await tokenRes.text();
      console.error("Auth failed:", errorText);
      return jsonResponse({ error: `Auth failed: ${errorText}` }, tokenRes.status);
    }

    const proxyTokenRes = new Response(tokenRes.body, tokenRes);
    proxyTokenRes.headers.set("Access-Control-Allow-Origin", "*");
    return proxyTokenRes;
  } catch (error) {
    console.error("Auth request error:", error);
    return jsonResponse({ error: `Auth request failed: ${error.message}` }, 502);
  }
}

/**
 * 调试接口
 */
async function handleDebug(request, kv) {
  // 获取所有配置值
  const config = {};
  const keys = [
    'ALIYUN_REGISTRY',
    'ALIYUN_REGISTRY_USER', 
    'TARGET_NAMESPACE',
    'GITHUB_OWNER',
    'GITHUB_REPO',
    'FILE_PATH',
    'BRANCH',
    'GH_TOKEN',
    'WEBHOOK_SECRET'
  ];
  
  for (const key of keys) {
    config[key] = await kv.get(key);
  }
  
  // 检查必需的配置
  const missing = [];
  if (!config.ALIYUN_REGISTRY) missing.push('ALIYUN_REGISTRY');
  if (!config.ALIYUN_REGISTRY_USER) missing.push('ALIYUN_REGISTRY_USER');
  
  return jsonResponse({
    config,
    missingConfig: missing,
    timestamp: new Date().toISOString(),
    status: missing.length === 0 ? 'OK' : 'CONFIG_ERROR'
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
