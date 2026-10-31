#!/usr/bin/env node
/*
 * Above the Clouds — scheduled alert check
 * ----------------------------------------
 * Fetches the forecast for one or more peaks, finds GO windows inside the
 * alert horizon, and sends a push through ntfy and/or Telegram. A small state
 * file keeps the 15-minute schedule from sending the same window twice.
 *
 * Environment:
 *   NTFY_TOPIC          required for ntfy (a long private topic name)
 *   NTFY_URL            optional, defaults to https://ntfy.sh
 *   NTFY_TOKEN          optional access token for a protected ntfy server
 *   TELEGRAM_BOT_TOKEN  optional Telegram bot token
 *   TELEGRAM_CHAT_ID    optional Telegram chat id
 *   ATC_LOCATIONS       comma-separated ids, defaults to boccardo-peak
 *   ATC_APP_URL         link included in the alert
 *   ATC_HORIZON_HOURS   how far ahead to alert, defaults to 30
 *   ATC_THRESHOLD       GO score threshold, defaults to 70
 *   ATC_STATE_FILE      defaults to .state/notified.json
 *   ATC_DRY_RUN         set to 1 to print instead of send
 *   ATC_TEST            set to true to send one test alert and exit
 *
 *   node scripts/check-and-notify.mjs
 *   node scripts/check-and-notify.mjs --dry-run --location mount-tamalpais
 *   node scripts/check-and-notify.mjs --test
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const CloudInversion = require("../shared/conditions.js");
const CloudWeather = require("../shared/openmeteo.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const TZ = "America/Los_Angeles";

const args = process.argv.slice(2);
const argValue = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
};

function boundedNumber(value, fallback, min, max) {
  if (value == null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

const dryRun = args.includes("--dry-run") || process.env.ATC_DRY_RUN === "1";
const testMode = args.includes("--test") || process.env.ATC_TEST === "true";
const explicitLocation = argValue("--location");
const horizonHours = boundedNumber(process.env.ATC_HORIZON_HOURS, 30, 1, 96);
const threshold = boundedNumber(process.env.ATC_THRESHOLD, 70, 1, 100);
const stateFile = path.resolve(root, process.env.ATC_STATE_FILE || ".state/notified.json");
const appUrl = resolveAppUrl();

const locations = JSON.parse(fs.readFileSync(path.join(root, "locations.json"), "utf8"));
const requestedIds = (explicitLocation || process.env.ATC_LOCATIONS || process.env.ATC_LOCATION_IDS || "boccardo-peak")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const selected = requestedIds
  .map((id) => locations.find((location) => location.id === id))
  .filter(Boolean);

if (!selected.length) {
  console.error(`No matching locations. Requested: ${requestedIds.join(", ")}`);
  process.exit(1);
}

const channels = {
  ntfy: Boolean(process.env.NTFY_TOPIC),
  telegram: Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID)
};

if (!dryRun && !channels.ntfy && !channels.telegram) {
  const message =
    "No alert channel configured. Add NTFY_TOPIC (or TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID) as a repository secret.";
  if (testMode) {
    console.error(message);
    process.exit(1);
  }
  console.warn(message);
  process.exit(0);
}

if (testMode) {
  const message = {
    title: "Above the Clouds test alert",
    body:
      "Alerts are working. Your GitHub Actions notification setup is ready.\n\n" +
      `Watching: ${selected.length > 5 ? `${selected.length} Bay Area peaks` : selected.map((location) => location.name).join(", ")}` +
      (appUrl ? `\n\nOpen the forecast: ${appUrl}` : ""),
    link: appUrl,
    priority: 3,
    tags: ["sunrise", "mountain"]
  };

  console.log(`Sending a test alert${dryRun ? " [dry run]" : ""}...\n`);
  console.log(`Title: ${message.title}`);
  console.log(message.body + "\n");

  if (dryRun) process.exit(0);

  const results = await Promise.allSettled([
    channels.ntfy ? sendNtfy(message) : Promise.resolve("skipped"),
    channels.telegram ? sendTelegram(message) : Promise.resolve("skipped")
  ]);
  const delivered = results.some(
    (result) => result.status === "fulfilled" && result.value === "sent"
  );
  const errors = results
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason && result.reason.message);

  if (!delivered) {
    console.error(`Test alert failed: ${errors.join("; ") || "no channel accepted the message"}`);
    process.exit(1);
  }
  const sentTo = [channels.ntfy ? "ntfy" : null, channels.telegram ? "Telegram" : null].filter(Boolean).join(" + ");
  console.log(`Test alert sent via ${sentTo}.`);
  if (errors.length) console.warn(`Some channels failed: ${errors.join("; ")}`);
  process.exit(0);
}

const now = Math.floor(Date.now() / 1000);
const state = readState();
const sent = [];
const skipped = [];
const failed = [];

console.log(
  `Checking ${selected.map((l) => l.name).join(", ")} at ${new Date().toISOString()} ` +
    `(horizon ${horizonHours}h, threshold ${threshold})${dryRun ? " [dry run]" : ""}`
);

for (const location of selected) {
  let forecast;
  try {
    const weather = await CloudWeather.fetchForecast(location, { days: 4 });
    forecast = CloudInversion.evaluateForecast({
      peak: weather.peak,
      valley: weather.valley,
      location,
      now,
      timezone: TZ,
      threshold
    });
  } catch (error) {
    console.error(`  ${location.name}: forecast failed — ${error.message}`);
    failed.push(`${location.name}: forecast failed`);
    continue;
  }

  const candidates = [];
  const current = forecast.currentWindow;
  if (current && current.endTs - now >= 30 * 60) {
    candidates.push({ phase: "now", window: current });
  }

  const upcoming = forecast.upcomingWindows.find((window) => window.startTs - now <= horizonHours * 3600);
  if (upcoming) candidates.push({ phase: "upcoming", window: upcoming });

  if (!candidates.length) {
    console.log(`  ${location.name}: no GO window in the next ${horizonHours}h (best ${forecast.bestHour.score}/100)`);
    continue;
  }

  for (const candidate of candidates) {
    const key = `${location.id}:${candidate.window.startTs}:${candidate.phase}`;
    if (state.windows[key]) {
      skipped.push(key);
      console.log(`  ${location.name}: ${candidate.phase} ${candidate.window.label} — already sent`);
      continue;
    }

    const message = buildMessage(location, forecast, candidate);
    if (dryRun) {
      console.log(`\n--- ${candidate.phase.toUpperCase()} ${location.name} ---`);
      console.log(`Title: ${message.title}`);
      console.log(message.body);
      console.log("---\n");
      sent.push(key);
      continue;
    }

    const results = await Promise.allSettled([
      channels.ntfy ? sendNtfy(message) : Promise.resolve("skipped"),
      channels.telegram ? sendTelegram(message) : Promise.resolve("skipped")
    ]);

    const delivered = results.some(
      (result) => result.status === "fulfilled" && result.value === "sent"
    );
    const errors = results
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason && result.reason.message);

    if (delivered) {
      state.windows[key] = {
        sentAt: now,
        windowStartTs: candidate.window.startTs,
        windowEndTs: candidate.window.endTs,
        locationId: location.id,
        phase: candidate.phase,
        score: candidate.window.score
      };
      sent.push(key);
      console.log(`  ${location.name}: sent ${candidate.phase} alert for ${candidate.window.label}`);
      if (errors.length) console.warn(`    Some channels failed: ${errors.join("; ")}`);
    } else {
      failed.push(`${location.name}: ${errors.join("; ") || "no channel accepted the message"}`);
      console.error(`  ${location.name}: failed to send ${candidate.phase} alert`);
    }
  }
}

if (!dryRun && sent.length) {
  pruneState(now);
  writeState();
}

console.log(
  `\nDone. sent=${sent.length} skipped=${skipped.length} failed=${failed.length}` +
    (failed.length ? `\n${failed.map((item) => "  ! " + item).join("\n")}` : "")
);

if (failed.length) process.exitCode = 1;

// ---------------------------------------------------------------------------
// Message building
// ---------------------------------------------------------------------------

function buildMessage(location, forecast, candidate) {
  const window = candidate.window;
  const elevation = location.peak.elevationFt.toLocaleString("en-US");
  const windowLabel = CloudInversion.formatWindowLabel(
    { startTs: window.startTs, endTs: window.endTs },
    TZ,
    now
  );
  const hour = window.hours.find((h) => h.score === window.score) || forecast.current;
  const detail = CloudInversion.cloudStateDetail(hour, forecast.peakElevationFt);
  const reasons = [
    detail,
    hour.metrics.skyClear >= 0.7 ? "clear sky above" : "some high cloud above",
    hour.effectiveWindMph < 10 ? "light wind" : "a bit breezy"
  ];

  const base = appUrl.replace(/[?#].*$/, "").replace(/\/+$/, "");
  const link = base ? `${base}/?location=${location.id}` : "";
  let body =
    `${location.name} · ${elevation} ft\n` +
    `Score ${window.score}/100. ${reasons.join(", ")}.\n\n` +
    `${windowLabel}`;
  if (link) body += `\n\nOpen the forecast: ${link}`;

  if (candidate.phase === "now") {
    const minutesLeft = Math.max(0, Math.round((window.endTs - now) / 60));
    return {
      title: `Above the clouds now — until ${CloudInversion.formatTime(window.endTs, TZ, true)}`,
      body: `The window is open for about ${minutesLeft} more minutes.\n\n${body}`,
      link,
      priority: 4,
      tags: ["sunrise", "cloud"]
    };
  }

  const hoursAway = Math.max(1, Math.round((window.startTs - now) / 3600));
  return {
    title: `Sunrise window: ${windowLabel}`,
    body: `${body}\n\nStarts in about ${hoursAway} hour${hoursAway === 1 ? "" : "s"}.`,
    link,
    priority: 3,
    tags: ["sunrise", "mountain"]
  };
}

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

async function sendNtfy(message) {
  const base = (process.env.NTFY_URL || "https://ntfy.sh").replace(/\/+$/, "");
  const headers = { "Content-Type": "application/json" };
  if (process.env.NTFY_TOKEN) headers.Authorization = `Bearer ${process.env.NTFY_TOKEN}`;

  const payload = {
    topic: process.env.NTFY_TOPIC,
    title: message.title,
    message: message.body,
    priority: message.priority,
    tags: message.tags
  };
  if (message.link) payload.click = message.link;

  const response = await fetch(base, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`ntfy HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
  }
  return "sent";
}

async function sendTelegram(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: `${message.title}\n\n${message.body}`,
      disable_web_page_preview: false
    }),
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Telegram HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
  }
  return "sent";
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

function resolveAppUrl() {
  if (process.env.ATC_APP_URL) return process.env.ATC_APP_URL.replace(/\/+$/, "");
  const repo = process.env.GITHUB_REPOSITORY;
  const owner = process.env.GITHUB_REPOSITORY_OWNER || (repo ? repo.split("/")[0] : "");
  if (!repo || !owner) return "";
  const name = repo.split("/")[1];
  if (!name) return "";
  if (name.toLowerCase() === `${owner.toLowerCase()}.github.io`) return `https://${owner}.github.io`;
  return `https://${owner}.github.io/${name}`;
}

function readState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    if (parsed && typeof parsed.windows === "object") return parsed;
  } catch (error) {
    // A missing or corrupt state file just means a fresh start.
  }
  return { windows: {} };
}

function pruneState(nowTs) {
  const cutoff = nowTs - 72 * 3600;
  const entries = Object.entries(state.windows);
  for (const [key, value] of entries) {
    if (!value || !value.windowStartTs || value.windowStartTs < cutoff) delete state.windows[key];
  }
  const remaining = Object.entries(state.windows);
  if (remaining.length > 200) {
    remaining
      .sort((a, b) => (a[1].sentAt || 0) - (b[1].sentAt || 0))
      .slice(0, remaining.length - 200)
      .forEach(([key]) => delete state.windows[key]);
  }
}

function writeState() {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + "\n");
}
