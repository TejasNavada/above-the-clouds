#!/usr/bin/env node
/*
 * Smoke test for the scoring engine.
 *
 *   node scripts/test-conditions.mjs
 *   node scripts/test-conditions.mjs --location mount-tamalpais
 *
 * It fetches live Open-Meteo data, prints a readable forecast table, and
 * checks a handful of synthetic scenarios so threshold changes don't silently
 * break the "good / maybe / no" logic.
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const CloudInversion = require("../shared/conditions.js");
const CloudWeather = require("../shared/openmeteo.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const locations = JSON.parse(fs.readFileSync(path.join(root, "locations.json"), "utf8"));

const args = process.argv.slice(2);
const locationArg = args.includes("--location") ? args[args.indexOf("--location") + 1] : "boccardo-peak";
const location = locations.find((l) => l.id === locationArg);
if (!location) {
  console.error(`Unknown location: ${locationArg}`);
  console.error("Available: " + locations.map((l) => l.id).join(", "));
  process.exit(1);
}

function bar(score) {
  const filled = Math.round(score / 5);
  return "█".repeat(filled) + "·".repeat(20 - filled);
}

function fmt(ts, tz) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "short",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(ts * 1000));
}

console.log(`\nFetching ${location.name} (${location.peak.elevationFt.toLocaleString()} ft)...\n`);
const weather = await CloudWeather.fetchForecast(location);
const forecast = CloudInversion.evaluateForecast({
  peak: weather.peak,
  valley: weather.valley,
  location,
  now: Math.floor(Date.now() / 1000),
  timezone: "America/Los_Angeles"
});

console.log(`NOW  ${forecast.current.timeLabel}  ${forecast.current.verdict.label}  ${forecast.current.score}/100  ${forecast.current.verdict.reason}`);
console.log(`Deck: ${CloudInversion.cloudStateLabel(forecast.current.cloudState)} — ${CloudInversion.cloudStateDetail(forecast.current, forecast.peakElevationFt)}`);
console.log(`Valley low cloud ${forecast.current.valley.low}% · RH ${forecast.current.valley.rh}% · vis ${forecast.current.valley.visMi?.toFixed(1)} mi`);
console.log(`Peak low cloud ${forecast.current.peak.low}% · RH ${forecast.current.peak.rh}% · vis ${forecast.current.peak.visMi?.toFixed(1)} mi`);
console.log(`Next window: ${forecast.nextWindow ? forecast.nextWindow.label + " (" + forecast.nextWindow.score + ")" : "none in the next few days"}`);
console.log(`Best chance: ${forecast.bestHour.timeLabel} ${forecast.bestHour.date} — ${forecast.bestHour.score}/100\n`);

console.log("Next 48 hours");
console.log("──────────────────────────────────────────────────────────────");
const start = Math.floor(Date.now() / 1000);
for (const h of forecast.hours.filter((x) => x.ts >= start - 3600).slice(0, 48)) {
  console.log(
    `${fmt(h.ts, forecast.timezone).padEnd(20)} ${String(h.score).padStart(3)} ${bar(h.score)} ${h.verdict.label.padEnd(6)} ${h.verdict.code}`
  );
}

console.log("\nThree-day outlook");
for (const day of forecast.days) {
  console.log(
    `${day.label.padEnd(12)} best ${String(day.bestHour.score).padStart(3)} at ${day.bestHour.timeLabel.padEnd(9)} ` +
      (day.bestWindow ? `window ${day.bestWindow.label}` : "no GO window")
  );
}

// ---------------------------------------------------------------------------
// Synthetic scenarios
// ---------------------------------------------------------------------------

function synthetic({ peakLow, peakRh, peakVis, valleyLow, valleyRh, valleyVis, mid = 0, high = 0, wind = 5, gust = 8, peakTemp = 55, valleyTemp = 50 }) {
  const times = Array.from({ length: 6 }, (_, i) => 1793370000 + i * 3600);
  const sunrise = times[0] - 1800;
  const arr = (v) => times.map(() => v);
  const peak = {
    timezone: "America/Los_Angeles",
    hourly_units: { visibility: "ft", boundary_layer_height: "ft" },
    hourly: {
      time: times,
      temperature_2m: arr(peakTemp),
      relative_humidity_2m: arr(peakRh),
      cloud_cover_low: arr(peakLow),
      cloud_cover_mid: arr(mid),
      cloud_cover_high: arr(high),
      cloud_cover: arr(Math.max(peakLow, mid, high)),
      visibility: arr(peakVis * 5280),
      wind_speed_10m: arr(wind),
      wind_gusts_10m: arr(gust),
      precipitation: arr(0),
      boundary_layer_height: arr(1200)
    },
    daily: { time: [times[0]], sunrise: [sunrise], sunset: [sunrise + 10 * 3600] }
  };
  const valley = {
    timezone: "America/Los_Angeles",
    hourly_units: { visibility: "ft", boundary_layer_height: "ft" },
    hourly: {
      time: times,
      temperature_2m: arr(valleyTemp),
      relative_humidity_2m: arr(valleyRh),
      cloud_cover_low: arr(valleyLow),
      cloud_cover_mid: arr(mid),
      cloud_cover_high: arr(high),
      cloud_cover: arr(Math.max(valleyLow, mid, high)),
      visibility: arr(valleyVis * 5280),
      wind_speed_10m: arr(wind),
      wind_gusts_10m: arr(gust),
      precipitation: arr(0),
      boundary_layer_height: arr(900)
    },
    daily: { time: [times[0]], sunrise: [sunrise], sunset: [sunrise + 10 * 3600] }
  };
  return CloudInversion.evaluateForecast({
    peak,
    valley,
    location: { peak: { elevationFt: 1900 }, valley: { elevationFt: 100 } },
    now: times[2],
    timezone: "America/Los_Angeles"
  });
}

const scenarios = [
  {
    name: "classic sea of clouds",
    expect: "GO",
    input: { peakLow: 5, peakRh: 65, peakVis: 20, valleyLow: 95, valleyRh: 96, valleyVis: 2, wind: 5, gust: 8 }
  },
  {
    name: "inside the fog",
    expect: "NO",
    input: { peakLow: 100, peakRh: 98, peakVis: 0.4, valleyLow: 100, valleyRh: 98, valleyVis: 0.5 }
  },
  {
    name: "clear but no deck",
    expect: "NO",
    input: { peakLow: 0, peakRh: 55, peakVis: 25, valleyLow: 0, valleyRh: 60, valleyVis: 20 }
  },
  {
    name: "cloud ceiling overhead",
    expect: "NO",
    input: { peakLow: 5, peakRh: 65, peakVis: 20, valleyLow: 95, valleyRh: 96, valleyVis: 2, mid: 100, high: 100 }
  }
];

let failures = 0;
console.log("\nSynthetic scenarios");
for (const scenario of scenarios) {
  const result = synthetic(scenario.input);
  const current = result.current;
  const pass = current.verdict.label === scenario.expect;
  if (!pass) failures++;
  console.log(
    `${pass ? "PASS" : "FAIL"} ${scenario.name.padEnd(26)} ${current.verdict.label.padEnd(6)} ${String(current.score).padStart(3)}  ${current.verdict.code}`
  );
}

// Scriptable and old WebKit builds may expose no Intl at all. Load a fresh
// copy of the engine with Intl disabled and make sure the Pacific fallback
// still formats the same labels the app and widget use.
console.log("No-Intl fallback");
{
  const enginePath = require.resolve("../shared/conditions.js");
  const realIntl = globalThis.Intl;
  try {
    globalThis.Intl = undefined;
    delete require.cache[enginePath];
    const NoIntl = require("../shared/conditions.js");
    const start = 1793548800; // Sun Nov 1 2026, 8 AM PST
    const now = 1793370000; // Fri Oct 30 2026
    const checks = [
      ["time with minutes", NoIntl.formatTime(start, "America/Los_Angeles", true), "8 AM"],
      ["time without minutes", NoIntl.formatTime(start, "America/Los_Angeles", false), "8 AM"],
      ["day label", NoIntl.formatDayLabel(start, "America/Los_Angeles", now), "Sun, Nov 1"],
      [
        "window label",
        NoIntl.formatWindowLabel({ startTs: start, endTs: start + 7200 }, "America/Los_Angeles", now),
        "Sun, Nov 1 · 8 AM – 10 AM"
      ]
    ];
    for (const [name, actual, expected] of checks) {
      const pass = actual === expected;
      if (!pass) failures++;
      console.log(`${pass ? "PASS" : "FAIL"} ${name.padEnd(22)} ${JSON.stringify(actual)}`);
    }
  } finally {
    globalThis.Intl = realIntl;
    delete require.cache[enginePath];
  }
}

if (failures) {
  console.error(`\n${failures} scenario(s) failed`);
  process.exit(1);
}
console.log("\nAll synthetic and fallback checks passed.\n");
