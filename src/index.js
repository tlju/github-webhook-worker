export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/update") {
      return handleUpdate(request, env);
    }

    if (url.pathname === "/webhook") {
      return handleWebhook(request, env);
    }

    return new Response("Not Found", { status: 404 });
  },
};

// ==============================
// 1️⃣ 更新文件
// ==============================
async function handleUpdate(request, env) {
  const body = await request.json();
  const newContent = body.content;

  if (!newContent) {
    return new Response("Missing content", { status: 400 });
  }

  // 获取文件 SHA
  const fileRes = await fetch(
    `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${env.FILE_PATH}?ref=${env.BRANCH}`,
    {
      headers: {
        Authorization: `Bearer ${env.GH_TOKEN}`,
        Accept: "application/vnd.github+json",
      },
    }
  );

  const fileData = await fileRes.json();

  // 更新文件
  const updateRes = await fetch(
    `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${env.FILE_PATH}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${env.GH_TOKEN}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: "auto update images.txt",
        content: btoa(unescape(encodeURIComponent(newContent))),
        sha: fileData.sha,
        branch: env.BRANCH,
      }),
    }
  );

  const result = await updateRes.json();

  return new Response(
    JSON.stringify({
      message: "Update triggered",
      commit: result.commit?.sha,
    }),
    { headers: { "Content-Type": "application/json" } }
  );
}

// ==============================
// 2️⃣ Webhook 接收 & 签名验证
// ==============================
async function handleWebhook(request, env) {
  const signature = request.headers.get("x-hub-signature-256");
  const body = await request.text();

  const valid = await verifySignature(body, signature, env.WEBHOOK_SECRET);

  if (!valid) {
    return new Response("Invalid signature", { status: 401 });
  }

  const payload = JSON.parse(body);

  if (payload.action === "completed") {
    const run = payload.workflow_run;

    return new Response(
      JSON.stringify({
        workflow: run.name,
        status: run.status,
        conclusion: run.conclusion,
        commit: run.head_sha,
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  }

  return new Response("Ignored");
}

// ==============================
// 3️⃣ HMAC SHA256 校验
// ==============================
async function verifySignature(body, signature, secret) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(body)
  );

  const hash = Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");

  const expected = `sha256=${hash}`;

  return expected === signature;
}
