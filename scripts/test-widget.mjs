#!/usr/bin/env node
/*
 * Runs the generated Scriptable widget inside a small mock of the Scriptable
 * runtime, using live Open-Meteo data. Catches API typos and rendering errors
 * without needing an iPhone.
 *
 *   node scripts/test-widget.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const code = fs.readFileSync(path.join(root, "widget", "CloudInversionWidget.js"), "utf8");

function createRuntime(options = {}) {
  const family = options.family || "medium";
  const docs = options.docs || fs.mkdtempSync(path.join(os.tmpdir(), "atc-widget-"));
  let widget = null;
  let finish;
  const finished = new Promise((resolve) => {
    finish = resolve;
  });

  class Color {
    constructor(value, alpha) {
      this.value = value;
      this.alpha = alpha == null ? 1 : alpha;
    }
  }

  class Size {
    constructor(width, height) {
      this.width = width;
      this.height = height;
    }
  }

  class LinearGradient {
    constructor() {
      this.colors = [];
      this.locations = [];
    }
  }

  class Rect {
    constructor(x, y, width, height) {
      Object.assign(this, { x, y, width, height });
    }
  }

  class Point {
    constructor(x, y) {
      this.x = x;
      this.y = y;
    }
  }

  const Font = {
    systemFont: (size) => ({ size, bold: false }),
    boldSystemFont: (size) => ({ size, bold: true }),
    monospacedSystemFont: (size) => ({ size, mono: true })
  };

  class DrawContext {
    constructor() {
      this.size = new Size(0, 0);
      this.opaque = true;
      this.respectScreenScale = false;
      this.fills = [];
    }
    setFillColor(color) {
      this.fill = color;
    }
    fillRect(rect) {
      this.fills.push({ color: this.fill, rect });
    }
    getImage() {
      return { size: this.size, fills: this.fills };
    }
  }

  class ListWidget {
    constructor() {
      this.children = [];
      this.spacers = 0;
      this.padding = null;
      this.backgroundGradient = null;
      this.backgroundColor = null;
      this.url = null;
      this.refreshAfterDate = null;
      this.horizontal = false;
    }
    addStack() {
      const stack = new ListWidget();
      this.children.push(stack);
      return stack;
    }
    addText(value) {
      const text = {
        value: String(value),
        font: null,
        textColor: null,
        lineLimit: null,
        minimumScaleFactor: null,
        centered: false,
        centerAlignText() {
          this.centered = true;
        }
      };
      this.children.push(text);
      return text;
    }
    addImage(image) {
      const item = { image, imageSize: null };
      this.children.push(item);
      return item;
    }
    addSpacer() {
      this.spacers++;
    }
    setPadding() {
      this.padding = Array.from(arguments);
    }
    layoutHorizontally() {
      this.horizontal = true;
    }
    layoutVertically() {
      this.horizontal = false;
    }
    centerAlignContent() {}
    bottomAlignContent() {}
    presentSmall() {
      return Promise.resolve();
    }
    presentMedium() {
      return Promise.resolve();
    }
    presentLarge() {
      return Promise.resolve();
    }
    presentAccessoryCircular() {
      return Promise.resolve();
    }
    presentAccessoryRectangular() {
      return Promise.resolve();
    }
    presentAccessoryInline() {
      return Promise.resolve();
    }
  }

  class Request {
    constructor(url) {
      this.url = url;
      this.timeoutInterval = 30;
    }
    async loadJSON() {
      if (options.failNetwork) throw new Error("Network unavailable (mock)");
      const response = await fetch(this.url);
      if (!response.ok) throw new Error("HTTP " + response.status);
      return response.json();
    }
  }

  const FileManager = {
    local() {
      return {
        documentsDirectory: () => docs,
        joinPath: (...parts) => path.join(...parts),
        fileExists: (file) => fs.existsSync(file),
        readString: (file) => fs.readFileSync(file, "utf8"),
        writeString: (file, value) => fs.writeFileSync(file, value)
      };
    }
  };

  const Script = {
    setWidget(value) {
      widget = value;
    },
    complete() {
      finish();
    }
  };

  const sandbox = {
    console,
    fetch,
    URL,
    Request,
    Color,
    Size,
    LinearGradient,
    Rect,
    Point,
    Font,
    DrawContext,
    ListWidget,
    FileManager,
    Script,
    Intl: options.noIntl ? undefined : Intl,
    config: {
      widgetFamily: family,
      runsInWidget: true,
      runsInApp: false
    },
    args: { widgetParameter: options.parameter || null }
  };

  vm.createContext(sandbox);
  return { sandbox, finished, docs, getWidget: () => widget };
}

function flatten(widget) {
  const texts = [];
  const images = [];
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (node.value != null) texts.push(node.value);
    if (node.image) images.push(node.image);
    if (Array.isArray(node.children)) node.children.forEach(visit);
  };
  visit(widget);
  return { texts, images };
}

async function render(options) {
  const runtime = createRuntime(options);
  vm.runInNewContext(code, runtime.sandbox, { filename: "CloudInversionWidget.js", timeout: 30000 });
  await Promise.race([
    runtime.finished,
    new Promise((_, reject) => setTimeout(() => reject(new Error("Widget timed out")), 25000))
  ]);
  const widget = runtime.getWidget();
  if (!widget) throw new Error("Script did not set a widget");
  return { widget, docs: runtime.docs, sandbox: runtime.sandbox, ...flatten(widget) };
}

let failures = 0;
function check(name, condition, detail) {
  console.log(`${condition ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
  if (!condition) failures++;
}

try {
  const medium = await render({ family: "medium" });
  const mediumText = medium.texts.join(" | ");
  check("medium renders", medium.texts.length >= 5, `${medium.texts.length} text nodes`);
  check("medium includes a verdict", /^(GO|MAYBE|FOG|NO DECK|CLOUDY|FOGGED IN|WINDY|RAIN)$/.test(medium.texts[2] || ""), mediumText.slice(0, 160));
  check("medium includes Boccardo", mediumText.includes("BOCCARDO PEAK"));
  check("medium draws the hourly strip", medium.images.length === 1);
  check(
    "medium sets a refresh date",
    Boolean(medium.widget.refreshAfterDate && typeof medium.widget.refreshAfterDate.getTime === "function")
  );

  const small = await render({ family: "small" });
  const smallText = small.texts.join(" | ");
  check("small renders", small.texts.length >= 4, `${small.texts.length} text nodes`);
  check("small includes a verdict", /GO|MAYBE|FOG|NO DECK|CLOUDY|FOGGED IN|WINDY|RAIN/.test(smallText));
  check("small draws the hourly strip", small.images.length === 1);

  const large = await render({ family: "large" });
  const largeText = large.texts.join(" | ");
  check(
    "large bay dashboard renders",
    (large.texts[0] || "").includes("ABOVE THE CLOUDS") &&
      /(GOOD WINDOWS|CLOSEST CALLS)/.test(largeText) &&
      large.texts.length >= 10,
    largeText.slice(0, 220)
  );
  const largeOffline = await render({ family: "large", failNetwork: true, docs: large.docs });
  check(
    "large dashboard uses its cached summaries offline",
    largeOffline.texts.join(" ").includes("ABOVE THE CLOUDS") &&
      !largeOffline.texts.join(" ").includes("NO SIGNAL") &&
      largeOffline.texts.join(" ").includes("Saved"),
    largeOffline.texts.slice(0, 7).join(" / ")
  );
  const fakeNow = Math.floor(Date.now() / 1000);
  const fakeRows = Array.from({ length: 12 }, (_, i) => ({
    id: "fake-" + i,
    name: "Fake Peak " + (i + 1),
    score: 99 - i,
    ts: fakeNow + (i + 1) * 3600,
    endTs: fakeNow + (i + 2) * 3600,
    isGo: true
  }));
  const fakeWidget = large.sandbox.buildLarge(
    fakeRows.slice().reverse(),
    { stale: false, savedAt: fakeNow },
    fakeNow
  );
  const fakeText = flatten(fakeWidget).texts.join(" | ");
  check(
    "large GO mode ranks, caps, and discloses overflow",
    fakeText.includes("GOOD WINDOWS") &&
      fakeText.includes("12 GO") &&
      fakeText.includes("Fake Peak 1") &&
      fakeText.includes("Fake Peak 10") &&
      !fakeText.includes("Fake Peak 11") &&
      fakeText.indexOf("Fake Peak 1") < fakeText.indexOf("Fake Peak 2") &&
      fakeText.includes("Top 10 of 12 GO"),
    fakeText.slice(0, 260)
  );

  const tam = await render({ family: "medium", parameter: "mount-tamalpais" });
  check("widget parameter selects a location", tam.texts.join(" ").includes("MT. TAMALPAIS") || tam.texts.join(" ").includes("TAMALPAIS"));

  const noIntl = await render({ family: "medium", noIntl: true });
  check(
    "widget renders without Intl",
    noIntl.texts.length >= 5 &&
      !noIntl.texts.join(" ").includes("NO SIGNAL") &&
      noIntl.texts.some((text) => /(?:AM|PM)/.test(text)),
    noIntl.texts.slice(0, 8).join(" / ")
  );

  const failed = await render({ family: "medium", failNetwork: true });
  check("network failure falls back to an error widget", failed.texts.join(" ").includes("NO SIGNAL"));

  // A successful render writes the weather cache. A second run without the
  // network should re-evaluate that cache against the current time.
  const online = await render({ family: "medium" });
  const stale = await render({ family: "medium", failNetwork: true, docs: online.docs });
  check(
    "cached weather renders when offline",
    !stale.texts.join(" ").includes("NO SIGNAL") && stale.images.length === 1,
    stale.texts.slice(0, 4).join(" / ")
  );
} catch (error) {
  failures++;
  console.error("FAIL widget harness — " + (error && error.stack ? error.stack : error));
}

if (failures) {
  console.error(`\n${failures} widget check(s) failed`);
  process.exit(1);
}
console.log("\nAll widget checks passed.\n");
