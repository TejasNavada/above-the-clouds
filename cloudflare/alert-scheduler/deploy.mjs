import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const accountId = required("CLOUDFLARE_ACCOUNT_ID");
const token = required("CLOUDFLARE_API_TOKEN");
const scriptName = process.env.WORKER_NAME || "atc-alert-scheduler";
const api = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${scriptName}`;

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name} first.`);
  return value;
}

async function cloudflare(pathname, init = {}) {
  const response = await fetch(api + pathname, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.headers || {}),
    },
  });
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  if (!response.ok || (data && data.success === false)) {
    throw new Error(`${init.method || "GET"} ${pathname} ${response.status}: ${text.slice(0, 800)}`);
  }
  return data;
}

async function putSecret(name, text) {
  await cloudflare("/secrets", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, text, type: "secret_text" }),
  });
  console.log(`secret ${name} set`);
}

async function upload() {
  const code = await fs.readFile(path.join(here, "src/index.js"), "utf8");
  const form = new FormData();
  form.append(
    "metadata",
    new File(
      [JSON.stringify({
        main_module: "index.js",
        compatibility_date: "2026-11-01",
        observability: { enabled: true },
      })],
      "metadata.json",
      { type: "application/json" }
    )
  );
  form.append(
    "index.js",
    new File([code], "index.js", { type: "application/javascript+module" })
  );
  const data = await cloudflare("", { method: "PUT", body: form });
  console.log(`deployed ${data.result.id} (${data.result.handlers.join(", ")})`);
}

async function configureSecrets() {
  await putSecret("GITHUB_APP_ID", required("GITHUB_APP_ID"));
  await putSecret("GITHUB_INSTALLATION_ID", required("GITHUB_INSTALLATION_ID"));

  const pem = await fs.readFile(required("GITHUB_PRIVATE_KEY_PATH"), "utf8");
  const pkcs8 = crypto.createPrivateKey(pem).export({ type: "pkcs8", format: "pem" });
  const encoded = Buffer.from(pkcs8).toString("base64");
  const chunks = encoded.match(/.{1,800}/g) || [];
  for (let index = 0; index < chunks.length; index += 1) {
    await putSecret(`GITHUB_PRIVATE_KEY_${index + 1}`, chunks[index]);
  }
  for (let index = chunks.length + 1; index <= 4; index += 1) {
    try {
      await cloudflare(`/secrets/GITHUB_PRIVATE_KEY_${index}`, { method: "DELETE" });
    } catch {
      // The chunk does not exist; nothing to clean up.
    }
  }

  if (process.env.TRIGGER_TOKEN) {
    await putSecret("TRIGGER_TOKEN", process.env.TRIGGER_TOKEN);
  } else {
    console.log("TRIGGER_TOKEN not set; the manual /run endpoint stays locked.");
  }
}

async function configureSchedule() {
  await cloudflare("/schedules", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify([{ cron: "*/15 * * * *" }]),
  });
  console.log("cron */15 * * * * set");
}

await upload();
if (process.env.GITHUB_APP_ID) {
  await configureSecrets();
}
await configureSchedule();
console.log("done");
