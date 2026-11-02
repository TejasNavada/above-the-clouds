# Alert scheduler (Cloudflare Worker)

GitHub's native `schedule` trigger is best-effort. In practice it can skip
hours under load, which is not good enough for a 15-minute alert check. This
Worker is a small, free, reliable cron that asks GitHub to run
`.github/workflows/notify.yml` every 15 minutes.

```
Cloudflare Cron (*/15 * * * *)
        │
        ▼
Worker (this directory)
        │  GitHub App installation token
        ▼
GitHub Actions: Cloud alerts
        │
        ▼
ntfy + Telegram
```

The Worker does not compute forecasts or send notifications itself. It only
dispatches the existing, tested workflow. GitHub Actions still owns the
forecast check, dedupe state, and ntfy/Telegram delivery.

## Why a GitHub App instead of a personal access token

A GitHub App installation token is minted on demand, expires after one hour,
and is scoped to this repository. There is no long-lived user token to rotate,
so the scheduler keeps working without maintenance.

The App needs only:

- **Repository permissions → Actions: Read and write**
- Installed on `TejasNavada/above-the-clouds` only

## Cloudflare setup

The Worker uses the Workers Free plan: 100,000 requests/day, 5 cron triggers per
account, and a minimum interval of one minute. This job uses 96 invocations/day.

One-time setup:

1. Create a Cloudflare account and open **Workers & Pages**.
2. Create a Worker named `atc-alert-scheduler`.
3. Create a GitHub App with the permission above, install it on the repo, and
   generate a private key.
4. Add Worker secrets:

   | Secret | Value |
   | --- | --- |
   | `GITHUB_APP_ID` | The App ID from the GitHub App settings |
   | `GITHUB_INSTALLATION_ID` | The installation ID from the installed App URL |
   | `GITHUB_PRIVATE_KEY_1` … `_3` | The PKCS#8 private key, base64-encoded and split into 800-character chunks |
   | `TRIGGER_TOKEN` | Optional random token for the manual `/run` endpoint |

   The PEM is split because some Cloudflare accounts cap a single secret at
   about 2 KB. `deploy.mjs` handles the PKCS#8 conversion and chunking.

5. Add a Cron Trigger: `*/15 * * * *`.
6. Confirm the Worker URL returns `{"ok":true,...}`.

## Deploy from this directory

Create a short-lived Cloudflare API token with **Workers Scripts: Edit** and run:

```bash
CLOUDFLARE_ACCOUNT_ID=... \
CLOUDFLARE_API_TOKEN=... \
GITHUB_APP_ID=... \
GITHUB_INSTALLATION_ID=... \
GITHUB_PRIVATE_KEY_PATH=/path/to/private-key.pem \
TRIGGER_TOKEN=... \
node deploy.mjs
```

On PowerShell:

```powershell
$env:CLOUDFLARE_ACCOUNT_ID = "..."
$env:CLOUDFLARE_API_TOKEN = "..."
$env:GITHUB_APP_ID = "..."
$env:GITHUB_INSTALLATION_ID = "..."
$env:GITHUB_PRIVATE_KEY_PATH = "$env:USERPROFILE\Downloads\app.private-key.pem"
$env:TRIGGER_TOKEN = "..."
node cloudflare/alert-scheduler/deploy.mjs
```

`deploy.mjs` uploads the module, writes the secrets, and sets the cron trigger.
It does not store the Cloudflare token or the private key in this repository.

## Manual test

```bash
curl -X POST https://atc-alert-scheduler.<subdomain>.workers.dev/run \
  -H "Authorization: Bearer $TRIGGER_TOKEN"
```

A `204` means GitHub accepted the workflow dispatch. Check the repository's
**Actions → Cloud alerts** list for the new run. The scheduled invocation uses
the same code path; the manual endpoint is only for testing.

The Worker's logs are in **Workers & Pages → atc-alert-scheduler →
Observability**.
