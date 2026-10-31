/*
 * Above the Clouds — Scriptable widget body
 * -----------------------------------------
 * This file is not run directly. `scripts/build-widget.mjs` prepends the
 * shared scoring engine, the Open-Meteo client, and the location catalog, then
 * writes widget/CloudInversionWidget.js — the file you paste into Scriptable.
 *
 * Edit APP_URL below (or edit the generated file after building) to enable
 * tapping through to the PWA.
 */
const APP_URL = "";
const TIME_ZONE = "America/Los_Angeles";
const REFRESH_MINUTES = 15;
const MAX_BAY_ROWS = 10;

const COLORS = {
  ink: "#f2f5ff",
  muted: "#9aa8c6",
  dim: "#6f7d9f",
  good: "#5eead4",
  maybe: "#fbbf24",
  no: "#fb7185",
  track: "#16233f",
  white: "#ffffff"
};

function toneColor(tone) {
  if (tone === "good") return new Color(COLORS.good);
  if (tone === "maybe") return new Color(COLORS.maybe);
  return new Color(COLORS.no);
}

function shortName(name) {
  return String(name || "")
    .replace(/\s*\([^)]*\)\s*/g, " ")
    .replace(/^Mount\s+/, "Mt. ")
    .trim();
}

function shortDay(ts, now) {
  const label = CloudInversion.formatDayLabel(ts, TIME_ZONE, now);
  if (label === "Today" || label === "Tomorrow") return label;
  return label.split(",")[0];
}

function compactTime(ts) {
  return CloudInversion.formatTime(ts, TIME_ZONE, true).replace(/\s+/g, "");
}

function windowInfo(forecast, now) {
  if (forecast.currentWindow) {
    return {
      tone: "good",
      label: "OPEN",
      text: "Until " + CloudInversion.formatTime(forecast.currentWindow.endTs, TIME_ZONE, true)
    };
  }
  if (forecast.nextWindow) {
    const win = forecast.nextWindow;
    const when = shortDay(win.startTs, now) + " " + compactTime(win.startTs) + "–" + compactTime(win.endTs);
    return {
      tone: "good",
      label: "NEXT",
      text: when + " · in " + CloudInversion.formatCountdown(win.startTs - now)
    };
  }
  const best = forecast.bestHour;
  return {
    tone: best.score >= 50 ? "maybe" : "no",
    label: "BEST",
    text: shortDay(best.ts, now) + " " + best.timeLabel + " · " + best.score + "/100"
  };
}

function reasonFor(hour) {
  switch (hour.verdict.code) {
    case "GOOD":
      return "Deck below · clear above · " + (hour.effectiveWindMph < 10 ? "calm" : "light wind");
    case "MAYBE":
      return "Borderline — one ingredient is marginal";
    case "LATE":
      return "The morning window has mostly passed";
    case "NIGHT":
      return "Deck still forming before sunrise";
    case "IN_CLOUD":
      return "You'd be inside the cloud layer";
    case "NO_DECK":
      return "No low cloud deck below the summit";
    case "CLOUDY_ABOVE":
      return "A cloud ceiling is blocking the view";
    case "CLOUDS_ABOVE":
      return "Clouds are sitting above the summit";
    case "SUMMIT_NOT_CLEAR":
      return "The summit is fogged in";
    case "WINDY":
      return "Too windy for a clean deck";
    case "RAIN":
      return "Rain is in the forecast";
    default:
      return hour.verdict.reason;
  }
}

function appBase() {
  return APP_URL.replace(/[?#].*$/, "").replace(/\/+$/, "");
}

function appLink(location) {
  if (!APP_URL) return null;
  return appBase() + "/?location=" + encodeURIComponent(location.id);
}

function bayLink() {
  if (!APP_URL) return null;
  return appBase() + "/?bay=1";
}

function paintBackground(widget) {
  const gradient = new LinearGradient();
  gradient.colors = [new Color("#081020"), new Color("#132342"), new Color("#0b1428")];
  gradient.locations = [0, 0.62, 1];
  widget.backgroundGradient = gradient;
  widget.backgroundColor = new Color("#0b1428");
}

function addHeader(widget, location, stale, showName) {
  const header = widget.addStack();
  header.layoutHorizontally();
  header.centerAlignContent();

  const brand = header.addText("△  ABOVE THE CLOUDS");
  brand.font = Font.boldSystemFont(8);
  brand.textColor = new Color(COLORS.muted);
  brand.lineLimit = 1;

  if (showName) {
    header.addSpacer();
    const name = header.addText(shortName(location.name).toUpperCase() + (stale ? " · SAVED" : ""));
    name.font = Font.boldSystemFont(8);
    name.textColor = new Color(COLORS.dim);
    name.lineLimit = 1;
    name.minimumScaleFactor = 0.7;
  }
}

function addVerdict(widget, forecast, size) {
  const current = forecast.current;
  const tone = CloudInversion.verdictTone(current.verdict.code);
  const headline = CloudInversion.verdictHeadline(current.verdict.code);

  const row = widget.addStack();
  row.layoutHorizontally();
  row.centerAlignContent();

  const word = row.addText(headline);
  word.font = Font.boldSystemFont(size);
  word.textColor = toneColor(tone);
  word.lineLimit = 1;
  word.minimumScaleFactor = 0.5;

  row.addSpacer(9);

  const right = row.addStack();
  right.layoutVertically();
  right.spacing = 0;

  const score = right.addText(current.score + "/100");
  score.font = Font.boldSystemFont(size > 34 ? 12 : 10);
  score.textColor = new Color(COLORS.ink);

  const state = right.addText(CloudInversion.cloudStateLabel(current.cloudState));
  state.font = Font.systemFont(size > 34 ? 9 : 8);
  state.textColor = new Color(COLORS.muted);
  state.lineLimit = 1;
}

function addWindow(widget, forecast, now, size) {
  const info = windowInfo(forecast, now);
  const row = widget.addStack();
  row.layoutHorizontally();
  row.centerAlignContent();

  const label = row.addText(info.label);
  label.font = Font.boldSystemFont(size);
  label.textColor = toneColor(info.tone);

  row.addSpacer(5);

  const text = row.addText(info.text);
  text.font = Font.boldSystemFont(size + 2);
  text.textColor = new Color(COLORS.ink);
  text.lineLimit = 1;
  text.minimumScaleFactor = 0.7;
}

function drawBars(hours, width, height, now) {
  const ctx = new DrawContext();
  ctx.size = new Size(width, height);
  ctx.opaque = false;
  ctx.respectScreenScale = true;

  const count = Math.max(1, hours.length);
  const gap = count > 9 ? 3 : 4;
  const barWidth = (width - gap * (count - 1)) / count;

  for (let i = 0; i < hours.length; i++) {
    const hour = hours[i];
    const x = i * (barWidth + gap);

    ctx.setFillColor(new Color(COLORS.track));
    ctx.fillRect(new Rect(x, 0, barWidth, height));

    const tone = CloudInversion.verdictTone(hour.verdict.code);
    const barHeight = Math.max(2, Math.round((hour.score / 100) * (height - 2)));
    ctx.setFillColor(toneColor(tone));
    ctx.fillRect(new Rect(x, height - barHeight, barWidth, barHeight));

    if (hour.ts <= now && hour.ts + 3600 > now) {
      ctx.setFillColor(new Color(COLORS.white));
      ctx.fillRect(new Rect(x, 0, barWidth, 1.5));
    }

    if (hour.sunriseTs && Math.abs(hour.ts - hour.sunriseTs) < 1800) {
      ctx.setFillColor(new Color(COLORS.maybe));
      ctx.fillRect(new Rect(x, 0, barWidth, 1.5));
    }
  }

  return ctx.getImage();
}

function addBars(widget, forecast, now, width, height) {
  const start = Math.max(
    0,
    forecast.hours.findIndex((hour) => hour.ts + 3600 > now)
  );
  const count = width < 150 ? 8 : 12;
  const hours = forecast.hours.slice(start, start + count);
  if (!hours.length) return;

  const image = drawBars(hours, width, height, now);
  const item = widget.addImage(image);
  item.imageSize = new Size(width, height);
}

function buildMedium(forecast, location, now, stale) {
  const widget = new ListWidget();
  paintBackground(widget);
  widget.setPadding(13, 14, 11, 14);

  addHeader(widget, location, stale, true);
  widget.addSpacer(2);
  addVerdict(widget, forecast, 40);

  const reason = widget.addText(reasonFor(forecast.current));
  reason.font = Font.systemFont(10);
  reason.textColor = new Color(COLORS.muted);
  reason.lineLimit = 1;
  reason.minimumScaleFactor = 0.8;

  widget.addSpacer(8);
  addWindow(widget, forecast, now, 8);
  widget.addSpacer(7);
  addBars(widget, forecast, now, 310, 25);

  return widget;
}

function buildSmall(forecast, location, now, stale) {
  const widget = new ListWidget();
  paintBackground(widget);
  widget.setPadding(12, 13, 11, 13);

  addHeader(widget, location, stale, false);
  widget.addSpacer(1);

  const name = widget.addText(shortName(location.name).toUpperCase());
  name.font = Font.boldSystemFont(9);
  name.textColor = new Color(COLORS.dim);
  name.lineLimit = 1;
  name.minimumScaleFactor = 0.7;

  widget.addSpacer(2);
  addVerdict(widget, forecast, 33);
  widget.addSpacer();

  addWindow(widget, forecast, now, 7);
  widget.addSpacer(4);
  addBars(widget, forecast, now, 132, 15);

  return widget;
}

function buildRectangular(forecast, location, now, stale) {
  const widget = new ListWidget();
  widget.setPadding(0, 0, 0, 0);

  const current = forecast.current;
  const tone = CloudInversion.verdictTone(current.verdict.code);

  const top = widget.addText(
    CloudInversion.verdictHeadline(current.verdict.code) + " · " + current.score + "/100"
  );
  top.font = Font.boldSystemFont(13);
  top.textColor = toneColor(tone);

  const middle = widget.addText(
    shortName(location.name) + " · " + CloudInversion.cloudStateLabel(current.cloudState)
  );
  middle.font = Font.systemFont(10);
  middle.textColor = new Color(COLORS.ink);
  middle.lineLimit = 1;
  middle.minimumScaleFactor = 0.7;

  const info = windowInfo(forecast, now);
  const bottom = widget.addText(info.label + " " + info.text);
  bottom.font = Font.systemFont(10);
  bottom.textColor = new Color(COLORS.muted);
  bottom.lineLimit = 1;
  bottom.minimumScaleFactor = 0.7;

  return widget;
}

function buildCircular(forecast) {
  const widget = new ListWidget();
  widget.setPadding(0, 0, 0, 0);
  widget.addSpacer();

  const current = forecast.current;
  const tone = CloudInversion.verdictTone(current.verdict.code);
  const word = widget.addText(CloudInversion.verdictHeadline(current.verdict.code));
  word.font = Font.boldSystemFont(18);
  word.textColor = toneColor(tone);
  word.centerAlignText();
  word.minimumScaleFactor = 0.5;

  const score = widget.addText(current.score + "/100");
  score.font = Font.systemFont(9);
  score.textColor = new Color(COLORS.ink);
  score.centerAlignText();

  widget.addSpacer();
  return widget;
}

function buildInline(forecast, location, now) {
  const widget = new ListWidget();
  const info = windowInfo(forecast, now);
  const text = widget.addText(
    CloudInversion.verdictHeadline(forecast.current.verdict.code) +
      " · " +
      shortName(location.name) +
      " · " +
      info.text
  );
  text.font = Font.systemFont(12);
  return widget;
}

function bayTimeLabel(row, now) {
  if (row.ts <= now && row.endTs > now) {
    return row.isGo ? "Now–" + CloudInversion.formatTime(row.endTs, TIME_ZONE, true).replace(/\s+/g, "") : "Now";
  }
  const label = CloudInversion.formatDayLabel(row.ts, TIME_ZONE, now);
  const day = label === "Today" ? "Today" : label === "Tomorrow" ? "Tmrw" : label.split(",")[0];
  const start = CloudInversion.formatTime(row.ts, TIME_ZONE, true).replace(/\s+/g, "");
  if (!row.isGo) return day + " " + start;
  const end = CloudInversion.formatTime(row.endTs, TIME_ZONE, true).replace(/\s+/g, "");
  return day + " " + start + "–" + end;
}

function bayRow(widget, row, now) {
  const stack = widget.addStack();
  stack.layoutHorizontally();
  stack.centerAlignContent();

  const name = stack.addText(shortName(row.name));
  name.font = Font.boldSystemFont(10);
  name.textColor = new Color(COLORS.ink);
  name.lineLimit = 1;
  name.minimumScaleFactor = 0.7;

  stack.addSpacer(6);

  const time = stack.addText(bayTimeLabel(row, now));
  time.font = Font.systemFont(8);
  time.textColor = new Color(COLORS.muted);
  time.lineLimit = 1;
  time.minimumScaleFactor = 0.7;

  stack.addSpacer(7);

  const score = stack.addText(String(row.score));
  score.font = Font.boldSystemFont(11);
  score.textColor = toneColor(row.isGo ? "good" : row.score >= 50 ? "maybe" : "no");
  score.lineLimit = 1;

  return stack;
}

function buildLarge(rows, meta, now) {
  const widget = new ListWidget();
  paintBackground(widget);
  widget.setPadding(13, 15, 12, 15);

  const goRows = rows.filter((row) => row.isGo);
  const ranked = rows.slice().sort((a, b) =>
    b.score - a.score ||
    a.ts - b.ts ||
    a.name.localeCompare(b.name)
  );
  const visible = goRows.length
    ? ranked.filter((row) => row.isGo).slice(0, MAX_BAY_ROWS)
    : ranked.slice(0, 4);

  const header = widget.addStack();
  header.layoutHorizontally();
  header.centerAlignContent();

  const brand = header.addText("△  ABOVE THE CLOUDS");
  brand.font = Font.boldSystemFont(8);
  brand.textColor = new Color(COLORS.muted);

  header.addSpacer();

  const count = header.addText(goRows.length ? goRows.length + " GO" : "0 GO");
  count.font = Font.boldSystemFont(8);
  count.textColor = goRows.length ? new Color(COLORS.good) : new Color(COLORS.muted);

  widget.addSpacer(3);

  const title = widget.addText(goRows.length ? "GOOD WINDOWS" : "CLOSEST CALLS");
  title.font = Font.boldSystemFont(21);
  title.textColor = goRows.length ? new Color(COLORS.good) : new Color(COLORS.maybe);
  title.lineLimit = 1;
  title.minimumScaleFactor = 0.8;

  const subtitle = widget.addText(
    goRows.length
      ? "Next 3 days · strongest outlook first"
      : "Top 4 single hours · next 3 days"
  );
  subtitle.font = Font.systemFont(9);
  subtitle.textColor = new Color(COLORS.muted);

  widget.addSpacer(8);

  for (const row of visible) {
    bayRow(widget, row, now);
    widget.addSpacer(5);
  }

  widget.addSpacer();

  let footText;
  if (goRows.length > visible.length) {
    footText = (meta.stale ? "Saved · " : "") +
      "Top " + visible.length + " of " + goRows.length + " GO · tap for all";
  } else if (meta.stale) {
    footText = "Saved " + CloudInversion.formatTime(meta.savedAt, TIME_ZONE, true) + " · tap for all";
  } else {
    footText = "Updated " + CloudInversion.formatTime(meta.savedAt, TIME_ZONE, true) + " · tap for all";
  }

  const foot = widget.addText(footText);
  foot.font = Font.systemFont(8);
  foot.textColor = new Color(COLORS.dim);
  foot.lineLimit = 1;

  return widget;
}

function buildError(message) {
  const widget = new ListWidget();
  paintBackground(widget);
  widget.setPadding(14, 14, 12, 14);

  const title = widget.addText("NO SIGNAL");
  title.font = Font.boldSystemFont(28);
  title.textColor = new Color(COLORS.no);

  const copy = widget.addText(message || "Couldn't reach Open-Meteo. Tap to open the app and try again.");
  copy.font = Font.systemFont(10);
  copy.textColor = new Color(COLORS.muted);
  copy.lineLimit = 3;

  widget.addSpacer();

  const hint = widget.addText("Tap to open Above the Clouds");
  hint.font = Font.boldSystemFont(9);
  hint.textColor = new Color(COLORS.dim);

  return widget;
}

function readCache(location, now) {
  try {
    const fm = FileManager.local();
    const file = fm.joinPath(fm.documentsDirectory(), "atc-widget-cache.json");
    if (!fm.fileExists(file)) return null;
    const cached = JSON.parse(fm.readString(file));
    if (!cached || cached.locationId !== location.id || !cached.weather) return null;
    return {
      savedAt: cached.savedAt,
      forecast: CloudInversion.evaluateForecast({
        peak: cached.weather.peak,
        valley: cached.weather.valley,
        location: location,
        now: now,
        timezone: TIME_ZONE
      })
    };
  } catch (error) {
    return null;
  }
}

function writeCache(locationId, weather) {
  try {
    const fm = FileManager.local();
    const file = fm.joinPath(fm.documentsDirectory(), "atc-widget-cache.json");
    fm.writeString(
      file,
      JSON.stringify({ locationId: locationId, savedAt: Date.now(), weather: weather })
    );
  } catch (error) {
    // A read-only container just means no offline cache.
  }
}

function readBayCache() {
  try {
    const fm = FileManager.local();
    const file = fm.joinPath(fm.documentsDirectory(), "atc-bay-summaries.json");
    if (!fm.fileExists(file)) return null;
    const cached = JSON.parse(fm.readString(file));
    if (!cached || !Array.isArray(cached.rows) || !cached.rows.length) return null;
    return cached;
  } catch (error) {
    return null;
  }
}

function writeBayCache(rows) {
  try {
    const fm = FileManager.local();
    const file = fm.joinPath(fm.documentsDirectory(), "atc-bay-summaries.json");
    fm.writeString(file, JSON.stringify({ savedAt: Date.now(), rows: rows }));
  } catch (error) {
    // A read-only container just means no offline cache.
  }
}

async function loadBayDashboard(now) {
  try {
    const bay = await CloudWeather.fetchBayForecast(LOCATIONS, {
      forecastHours: 80,
      timeoutMs: false,
      fetchImpl: async function (url) {
        const request = new Request(url);
        request.timeoutInterval = 30;
        const data = await request.loadJSON();
        return {
          ok: true,
          status: 200,
          json: async function () {
            return data;
          }
        };
      }
    });

    const rows = [];
    for (const item of bay.locations) {
      try {
        const forecast = CloudInversion.evaluateForecast({
          peak: item.peak,
          valley: item.valley,
          location: item.location,
          now: now,
          timezone: TIME_ZONE
        });
        const summary = CloudInversion.summarizeForecast(forecast, now);
        const chosen = summary.go || summary.best;
        if (!chosen) continue;
        rows.push({
          id: item.location.id,
          name: item.location.name,
          score: chosen.score,
          ts: chosen.ts,
          endTs: chosen.endTs,
          isGo: Boolean(summary.go)
        });
      } catch (error) {
        // Skip one bad location rather than losing the whole dashboard.
      }
    }
    if (!rows.length) throw new Error("No bay outlooks could be computed");
    writeBayCache(rows);
    return { rows: rows, stale: false, savedAt: Math.floor(Date.now() / 1000) };
  } catch (error) {
    const cached = readBayCache();
    if (cached) {
      return {
        rows: cached.rows,
        stale: true,
        savedAt: Math.floor(cached.savedAt / 1000)
      };
    }
    throw error;
  }
}

async function loadForecast(location, now) {
  try {
    const weather = await CloudWeather.fetchForecast(location, {
      timeoutMs: false,
      fetchImpl: async function (url) {
        const request = new Request(url);
        request.timeoutInterval = 30;
        const data = await request.loadJSON();
        return {
          ok: true,
          status: 200,
          json: async function () {
            return data;
          }
        };
      }
    });

    const forecast = CloudInversion.evaluateForecast({
      peak: weather.peak,
      valley: weather.valley,
      location: location,
      now: now,
      timezone: TIME_ZONE
    });
    writeCache(location.id, weather);
    return { forecast: forecast, stale: false };
  } catch (error) {
    const cached = readCache(location, now);
    if (cached) return { forecast: cached.forecast, stale: true };
    throw error;
  }
}

async function main() {
  const parameter = String(args.widgetParameter || "").trim();
  const location =
    LOCATIONS.find((item) => item.id === parameter) ||
    LOCATIONS.find((item) => item.id === DEFAULT_LOCATION_ID) ||
    LOCATIONS[0];

  const family = config.widgetFamily || "medium";
  const now = Math.floor(Date.now() / 1000);
  let widget;

  if (family === "large") {
    try {
      const result = await loadBayDashboard(now);
      widget = buildLarge(result.rows, { stale: result.stale, savedAt: result.savedAt }, now);
    } catch (error) {
      widget = buildError("Couldn't reach Open-Meteo.\n" + (error && error.message ? error.message : "Check your connection."));
    }
    const link = bayLink();
    if (link) widget.url = link;
    widget.refreshAfterDate = new Date(Date.now() + REFRESH_MINUTES * 60 * 1000);
  } else {
    try {
      const result = await loadForecast(location, now);
      const forecast = result.forecast;

      if (family === "accessoryInline") {
        widget = buildInline(forecast, location, now);
      } else if (family === "accessoryCircular") {
        widget = buildCircular(forecast);
      } else if (family === "accessoryRectangular") {
        widget = buildRectangular(forecast, location, now, result.stale);
      } else if (family === "small") {
        widget = buildSmall(forecast, location, now, result.stale);
      } else {
        widget = buildMedium(forecast, location, now, result.stale);
      }

      const link = appLink(location);
      if (link) widget.url = link;
      widget.refreshAfterDate = new Date(Date.now() + REFRESH_MINUTES * 60 * 1000);
    } catch (error) {
      widget = buildError("Couldn't reach Open-Meteo.\n" + (error && error.message ? error.message : "Check your connection."));
      const link = appLink(location);
      if (link) widget.url = link;
      widget.refreshAfterDate = new Date(Date.now() + REFRESH_MINUTES * 60 * 1000);
    }
  }

  if (config.runsInWidget) {
    Script.setWidget(widget);
  } else if (family === "large") {
    await widget.presentLarge();
  } else if (family === "small") {
    await widget.presentSmall();
  } else if (family === "accessoryCircular") {
    await widget.presentAccessoryCircular();
  } else if (family === "accessoryRectangular") {
    await widget.presentAccessoryRectangular();
  } else if (family === "accessoryInline") {
    await widget.presentAccessoryInline();
  } else {
    await widget.presentMedium();
  }

  Script.complete();
}

main().catch(function (error) {
  const widget = buildError("The widget hit an error.\n" + (error && error.message ? error.message : ""));
  Script.setWidget(widget);
  Script.complete();
});
