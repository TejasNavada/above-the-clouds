# Above the Clouds

A phone-first forecast for the Bay Area's best marine-layer mornings. Open the
app and get an immediate **GO / MAYBE / NO** for a peak, the next sunrise window,
and the reasons behind the score. A free Cloudflare cron triggers a GitHub Action
that turns good windows into ntfy or Telegram alerts, and a Scriptable widget puts
the current verdict on your iPhone home screen.

The default peak is **Boccardo Peak** (1,896 ft) above San Jose. The catalog
includes 38 summits from San Jose to Point Reyes.

> This is a planning aid, not a safety device. Marine layers are local and
> change quickly. Check the sky, trail conditions, and your own judgment before
> you go.

---

## What it does

- Scores every hour using the summit forecast and a nearby valley reference point.
- Looks for a low cloud deck **below** the peak, clear air **above** the peak,
  light wind, morning timing, and a temperature inversion.
- Computes the whole bay's 3-day outlook in one bulk Open-Meteo request and shows
  each peak's best score and time right in the location picker.
- Shows the current verdict plus the next GO window and a 3-day outlook.
- Works as a PWA with offline app-shell caching and a saved last-good forecast.
- Sends free push alerts through [ntfy](https://ntfy.sh/) or Telegram.
- Includes bay-wide Scriptable widgets in all three home-screen sizes, with
  lock-screen layouts for one peak.

The app calls the free [Open-Meteo](https://open-meteo.com/) API. There is no
account, analytics, or application server.

---

## Run it locally

Requirements: Node.js 20 or newer.

```bash
npm run serve
```

Then open <http://localhost:4173>. The `serve` command builds `_site/` and starts
a small static server on port 4173.

Useful commands:

```bash
npm run build       # assemble _site/
npm test            # live scoring checks + widget harness
npm run widget      # rebuild widget/CloudInversionWidget.js
npm run notify:dry  # print alerts without sending them
```

`npm test` makes a live forecast request, so it needs an internet connection.

---

## Put it on your phone

1. Deploy the site (below) to an HTTPS URL. (The local development server is
   for your computer; iPhone installation needs HTTPS.)
2. Open the site in **Safari** on the iPhone.
3. Tap **Share → Add to Home Screen**.
4. Launch it once from the new icon so the app shell is cached.

The PWA itself does not send background push notifications on iOS. Alerts come
through the ntfy or Telegram app; the Scriptable widget handles home-screen
glanceability.

---

## Deploy with GitHub Pages

1. Create a GitHub repository and push this project to the `main` branch.
2. In the repository, open **Settings → Pages** and set **Source** to
   **GitHub Actions**.
3. Run the **Deploy site** workflow, or push a commit to `main`.
4. Your site will be at:

   ```text
   https://<your-github-username>.github.io/<repository-name>/
   ```

   If the repository is named `<username>.github.io`, the path is just
   `https://<username>.github.io/`.

GitHub Pages for a private repository requires a plan that supports it. A
public repository works on the free plan. The alert workflow uses only a few
seconds per run, and Actions minutes are free on public repositories.

---

## Set up alerts

### Option A: ntfy (recommended)

ntfy is the simplest option: no bot setup, free iOS and Android apps, and a
long random topic acts as the shared secret.

1. In the app, open **Settings**.
2. Tap the sparkle next to **ntfy topic** to generate a private topic such as
   `atc-7f3k-m2q8-p9xr`.
3. Install the free **ntfy** app, tap **+**, paste the topic, and allow
   notifications. Use the copy icon in the app's ntfy field to copy the topic.
4. In GitHub, open **Settings → Secrets and variables → Actions**.
5. Add a **repository secret** named `NTFY_TOPIC` with that topic.
6. Optionally add a **repository variable** named `ATC_APP_URL` with your Pages
   URL, so tapping an alert opens the forecast for the right peak.
7. Open the **Actions** tab, select **Cloud alerts**, choose **Run workflow**,
   and enable the **Send a test notification** checkbox. This verifies the
   secret and the whole delivery path. You can also use **Send test alert** in
   the app to verify the phone subscription itself.

The random topic is the only password. Do not reuse a short or guessable topic.

**Self-hosted ntfy:** add a repository variable `NTFY_URL` with the server root
(for example `https://ntfy.example.com`) and, if the server requires it, a
secret `NTFY_TOKEN` containing an access token. The in-app test button posts to
ntfy.sh; for a self-hosted server, use the workflow's test option instead.

### Option B: Telegram

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy its token.
2. Send the bot a message (or add it to a group and send a message there).
3. Find the chat ID from
   `https://api.telegram.org/bot<TOKEN>/getUpdates`.
4. Add repository secrets named `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`.

If both ntfy and Telegram are configured, both are used. If only one is
configured, only that channel is used.

ntfy is the lowest-friction option because it has no account or bot setup. Its
iOS app relies on Apple's push service and can occasionally be delayed; Telegram
is a good alternative if you already use Telegram and want its push pipeline.

### Alert behavior

A free [Cloudflare Worker](./cloudflare/alert-scheduler) dispatches
`.github/workflows/notify.yml` every 15 minutes. It checks every configured peak
and sends **at most one combined notification per run**. The default look-ahead
is **72 hours**, matching the 3-day outlook in the app:

- All newly eligible peaks are listed together, grouped into **OPEN NOW** and
  **COMING UP**.
- If no peak has a new GO window, nothing is sent.
- A specific peak is not repeated for the same window. The next run can send a
  new digest only if another window becomes eligible.
- Tapping the alert opens the full, ranked Bay-wide picker.

GitHub's native scheduler is best-effort and, in practice, can skip hours under
load. This repository therefore does **not** use `on: schedule`. The Cloudflare
cron is the only trigger, so there is no 60-day scheduled-workflow pause and no
dependency on GitHub's scheduler. The Worker mints a short-lived GitHub App
installation token, so there is no personal access token to rotate.

If alerts go quiet, check **Workers & Pages → atc-alert-scheduler →
Observability** for dispatch errors, then check the repository's **Actions**
tab. The Worker setup and deployment steps are in
[`cloudflare/alert-scheduler/README.md`](./cloudflare/alert-scheduler/README.md).

### Alert configuration

Repository **variables** (Settings → Secrets and variables → Actions → Variables):

| Variable | Default | Meaning |
| --- | --- | --- |
| `ATC_LOCATIONS` | `boccardo-peak` | Comma-separated location IDs, for example `boccardo-peak,mount-tamalpais` |
| `ATC_APP_URL` | derived from the repo | Base URL used in alert links |
| `ATC_THRESHOLD` | `70` | Minimum score for a GO alert, from 1 to 100 |
| `ATC_HORIZON_HOURS` | `72` | How far ahead to look for an upcoming window (1–96) |
| `NTFY_URL` | `https://ntfy.sh` | Optional self-hosted ntfy server |

Secrets: `NTFY_TOPIC`, optional `NTFY_TOKEN`, optional
`TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`.

`ATC_LOCATIONS` uses IDs from [`locations.json`](./locations.json). Include
`boccardo-peak` explicitly when adding other peaks, because setting the variable
replaces the default rather than extending it.

To watch every peak in this catalog, set `ATC_LOCATIONS` to the comma-separated
list generated by:

```bash
node -e "console.log(require('./locations.json').map(l => l.id).join(','))"
```

The 15-minute alert job checks each configured peak. If several peaks line up,
they are combined into one deduplicated digest for that run.

### The 15-minute trigger

`cloudflare/alert-scheduler` is a tiny Worker that dispatches `notify.yml` on a
`*/15 * * * *` cron. It authenticates as a GitHub App installed on this
repository, so it uses a short-lived installation token instead of a personal
access token. The Worker is on Cloudflare's free plan and uses 96 invocations a
day.

To recreate it in a copy of this repository, follow
[`cloudflare/alert-scheduler/README.md`](./cloudflare/alert-scheduler/README.md).
The short version: create a GitHub App with **Actions: Read and write**, install
it on the repository, create the Worker, add the App ID / installation ID /
private-key secrets, and set the cron trigger.

To try the notification logic without sending anything:

```bash
# Print any GO windows in the next 48 hours
ATC_HORIZON_HOURS=48 npm run notify:dry

# Check a different peak
npm run notify:dry -- --location mount-tamalpais

# Send one test message using the configured local environment
npm run notify:test
```

On PowerShell, set environment variables with `$env:ATC_HORIZON_HOURS = "48"`
before running the command.

---

## iPhone home-screen widget (Scriptable)

The widget is a single self-contained script and fetches Open-Meteo directly.
It does not need the GitHub Action, and it keeps the last good forecast for
offline display.

1. Install [Scriptable](https://scriptable.app/) from the App Store (free).
2. On the iPhone, open the deployed app and go to **Settings → iPhone
   home-screen widget**.
3. Tap **Copy widget script**. This copies the self-contained script with your
   site's URL already filled in.
4. In Scriptable, tap **+**, choose a script, and paste. Give it a name such as
   “Cloud Inversion.”
5. Run the script once inside Scriptable to grant network access and verify it
   renders.
6. Long-press the home screen → **+** → **Scriptable** → choose a large,
   small, medium, or lock-screen widget → select this script.

### Bay-wide widget sizes

Every home-screen size ranks the Bay by the best outlook in the next three days:
highest score first, then earliest occurrence time. If there are GO windows, it
shows those; otherwise it shows the closest single-hour chances.

| Size | Rows | Extra detail |
| --- | ---: | --- |
| Small | 3 | Ranked list only |
| Medium | 4 | 3-day Bay pulse with the best score for each of the next three days |
| Large | 7 | Larger 3-day pulse, including the peak behind each day’s best score |

Tapping any widget opens the full, ranked 38-peak picker in the app. The widget
uses one bulk Open-Meteo request for all 38 peaks and caches the compact summary
for offline display. When more locations qualify than fit, the footer shows
“Top N of M GO.”

Lock-screen widgets still show one peak. Set their **Parameter** to a location
ID, for example `mount-tamalpais`. Without a parameter they use
`boccardo-peak`, or the value of `ATC_DEFAULT_LOCATION` at build time.

If copying is blocked, the deployed site also serves the raw script at
`./widget/CloudInversionWidget.js`; set its `APP_URL` constant by hand. To
pre-build the widget locally with the URL baked in:

```bash
# macOS / Linux
ATC_APP_URL="https://yourname.github.io/above-the-clouds" npm run widget

# PowerShell
$env:ATC_APP_URL = "https://yourname.github.io/above-the-clouds"; npm run widget
```

iOS decides when widgets refresh. The script asks for a refresh after 15
minutes, but the system may throttle it. Tapping the widget opens the full app
(with the selected peak) when `APP_URL` is set.

---

## Locations

The catalog lives in [`locations.json`](./locations.json). Each entry has a
summit coordinate and elevation plus a nearby valley town used as the lowland
reference:

```json
{
  "id": "boccardo-peak",
  "name": "Boccardo Peak",
  "region": "San Jose & South Bay",
  "peak": { "lat": 37.4056127, "lon": -121.806776, "elevationFt": 1896 },
  "valley": {
    "lat": 37.3382,
    "lon": -121.8863,
    "name": "San Jose",
    "elevationFt": 90
  },
  "notes": "Sierra Vista Open Space Preserve"
}
```

The app and widget both read this catalog. After editing it, rebuild both:

```bash
npm run build
npm run widget
```

All location IDs:

| Region | IDs |
| --- | --- |
| South Bay | `boccardo-peak`, `mission-peak`, `mount-hamilton`, `mount-umunhum`, `loma-prieta`, `el-sombroso`, `mount-madonna`, `fremont-peak`, `mount-sizer`, `copernicus-peak` |
| Peninsula | `black-mountain`, `windy-hill`, `russian-ridge`, `mount-bielawski`, `castle-rock`, `san-bruno-mountain`, `montara-mountain`, `sweeney-ridge` |
| East Bay | `rose-peak`, `mount-diablo`, `north-peak-diablo`, `eagle-peak-diablo`, `monument-peak`, `las-trampas-peak`, `brushy-peak`, `pleasanton-ridge`, `sunol-peak` |
| Marin | `mount-tamalpais`, `mount-burdell`, `big-rock-ridge`, `bolinas-ridge`, `mount-barnabe` |
| Point Reyes | `mount-wittenberg`, `mount-vision`, `point-reyes-hill` |
| San Francisco | `mount-davidson`, `twin-peaks`, `mount-sutro` |

---

## How the score works

Each hour compares two forecast points: the summit and a nearby valley town.
The score is a weighted blend of:

- **Low cloud deck** in the valley (low cloud cover, humidity, visibility).
- **Summit clarity** (low cloud, humidity, visibility at the peak).
- **Mid/high sky** above the summit (a high ceiling is a dealbreaker).
- **Wind** at the summit (gusts count too).
- **Morning timing** relative to sunrise.
- **Temperature inversion** relative to the normal lapse rate.

Hard caps prevent misleading high scores: rain, being inside the cloud layer,
no deck at all, a thick ceiling overhead, or strong wind force a low score. The
resulting verdict is **GO** at or above the threshold (70 by default), **MAYBE**
when marginal, and **NO** when an ingredient is missing.

The cloud-top estimate is deliberately conservative. When the boundary-layer
height is between the valley and the summit, the app rounds it to the nearest
100 ft; otherwise it says the deck is below the summit without inventing a
number.

---

## Project layout

```text
public/                 PWA shell, styles, icons, service worker
shared/conditions.js    scoring engine and shared formatting
shared/openmeteo.js     two-point Open-Meteo request client
locations.json          Bay Area peak catalog
widget/CloudInversionWidget.js   generated, single-file Scriptable widget
widget/widget-body.js   editable widget UI
scripts/                build, test, serve, notification scripts
.github/workflows/      Pages deployment and scheduled alerts
```

Generated files (`_site/`, `.state/`) and local secrets are gitignored.

---

## Troubleshooting

**The app shows a forecast but the alert never arrives**

- Check **Actions → Cloud alerts** for a successful run. A run with no GO window
  is a success, not a failure.
- Verify the repository secret `NTFY_TOPIC` exists and exactly matches the topic
  subscribed to in the ntfy app.
- Use **Send test alert** in the app. If that works, the phone subscription is
  fine and the remaining issue is the workflow configuration.
- Remember the default horizon is 72 hours. The 3-day picker and the alert
  horizon now cover the same period.

**The widget says NO SIGNAL**

- Open the Scriptable script and run it manually to see the error.
- Check that the phone has network access and that Open-Meteo is reachable.
- A previously cached forecast should appear when the network is unavailable;
  the medium widget marks it with a `SAVED` label.

**The app is showing an old version after a deploy**

The service worker updates static files over the network and falls back to its
cache offline. Close and reopen the Home Screen app; if needed, remove and
re-add it.

**GitHub Pages returns 404**

Confirm **Settings → Pages → Source** is **GitHub Actions**, the **Deploy site**
workflow succeeded, and the repository is public (or your plan allows Pages for
private repositories).

---

## Privacy

Forecasts are fetched directly from Open-Meteo by your browser or widget. The
only data sent to ntfy or Telegram is the alert text and link you configure.
There is no account, analytics, or tracking.
