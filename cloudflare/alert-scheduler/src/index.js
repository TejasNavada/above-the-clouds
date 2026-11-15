/**
 * Cloudflare Worker: trigger the Above the Clouds alert workflow every 15 minutes.
 *
 * GitHub's own scheduled workflows are best-effort and can skip hours under
 * load. This Worker uses a GitHub App installation token (no expiring PAT) to
 * dispatch notify.yml on a reliable Cloudflare Cron Trigger.
 */

const enc = new TextEncoder();

function b64url(bytes) {
  let binary = "";
  const view = new Uint8Array(bytes);
  for (let i = 0; i < view.length; i++) binary += String.fromCharCode(view[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlText(text) {
  return b64url(enc.encode(text));
}

async function importPrivateKey(pem) {
  const body = pem
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");
  const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
}

async function appJwt(env) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64urlText(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64urlText(JSON.stringify({
    iat: now - 60,
    exp: now + 540,
    iss: env.GITHUB_APP_ID,
  }));
  // Cloudflare limits a single secret to about 2 KB in some account setups.
  // The PEM is base64-encoded and split across numbered secrets.
  const privateKeyB64 = env.GITHUB_PRIVATE_KEY_B64 ||
    [env.GITHUB_PRIVATE_KEY_1, env.GITHUB_PRIVATE_KEY_2, env.GITHUB_PRIVATE_KEY_3, env.GITHUB_PRIVATE_KEY_4]
      .filter(Boolean)
      .join("");
  const key = await importPrivateKey(atob(privateKeyB64));
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    enc.encode(header + "." + payload)
  );
  return header + "." + payload + "." + b64url(signature);
}

async function dispatchWorkflow(env) {
  const jwt = await appJwt(env);
  const tokenResponse = await fetch(
    "https://api.github.com/app/installations/" + env.GITHUB_INSTALLATION_ID + "/access_tokens",
    {
      method: "POST",
      headers: {
        Authorization: "Bearer " + jwt,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "atc-alert-scheduler",
      },
    }
  );
  if (!tokenResponse.ok) {
    throw new Error("token " + tokenResponse.status + ": " + (await tokenResponse.text()).slice(0, 300));
  }
  const { token } = await tokenResponse.json();
  const repo = env.GITHUB_REPO || "TejasNavada/above-the-clouds";
  const workflow = env.GITHUB_WORKFLOW || "notify.yml";
  const response = await fetch(
    "https://api.github.com/repos/" + repo + "/actions/workflows/" + workflow + "/dispatches",
    {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "atc-alert-scheduler",
      },
      body: JSON.stringify({ ref: env.GITHUB_REF || "main" }),
    }
  );
  if (!response.ok) {
    throw new Error("dispatch " + response.status + ": " + (await response.text()).slice(0, 300));
  }
  return { status: response.status };
}

async function run(env) {
  const started = new Date().toISOString();
  try {
    const result = await dispatchWorkflow(env);
    console.log("dispatched", started, result.status);
  } catch (error) {
    console.error("dispatch failed", started, String(error));
  }
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

async function proxyWeather(request) {
  const incoming = new URL(request.url);
  const upstream = new URL("https://api.open-meteo.com" + incoming.pathname);
  upstream.search = incoming.search;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  let response;
  try {
    response = await fetch(upstream.toString(), {
      method: "GET",
      headers: { "User-Agent": "above-the-clouds-pwa" },
      signal: controller.signal,
      cf: { cacheTtl: 300, cacheEverything: true },
    });
  } finally {
    clearTimeout(timer);
  }

  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(CORS_HEADERS)) headers.set(name, value);
  headers.set("Cache-Control", "public, max-age=300");
  return new Response(response.body, { status: response.status, headers });
}

export default {
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(run(env));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (url.pathname === "/v1/gfs") {
      if (request.method !== "GET") {
        return new Response("Method not allowed", { status: 405, headers: CORS_HEADERS });
      }
      try {
        return await proxyWeather(request);
      } catch (error) {
        return Response.json({ error: true, reason: String(error) }, {
          status: 502,
          headers: CORS_HEADERS,
        });
      }
    }
    if (url.pathname === "/run") {
      if (request.method !== "POST") {
        return new Response("POST required", { status: 405 });
      }
      if (!env.TRIGGER_TOKEN || request.headers.get("Authorization") !== "Bearer " + env.TRIGGER_TOKEN) {
        return new Response("unauthorized", { status: 401 });
      }
      try {
        const result = await dispatchWorkflow(env);
        return Response.json({ ok: true, ...result });
      } catch (error) {
        return Response.json({ ok: false, error: String(error) }, { status: 500 });
      }
    }
    return Response.json({
      ok: true,
      service: "atc-alert-scheduler",
      schedule: "*/15 * * * *",
    });
  },
};
