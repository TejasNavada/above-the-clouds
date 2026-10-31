#!/usr/bin/env node
/*
 * Assembles the deployable static site in _site/.
 *
 *   node scripts/build-site.mjs
 *
 * public/ becomes the site root, while shared/ and locations.json sit beside
 * it because index.html loads them with relative paths.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const out = path.join(root, "_site");

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

fs.cpSync(path.join(root, "public"), out, { recursive: true });
fs.cpSync(path.join(root, "shared"), path.join(out, "shared"), { recursive: true });
fs.copyFileSync(path.join(root, "locations.json"), path.join(out, "locations.json"));

// Let the deployed app hand the latest widget source to an iPhone without
// requiring a detour through the repository.
const widgetSource = path.join(root, "widget", "CloudInversionWidget.js");
if (fs.existsSync(widgetSource)) {
  fs.mkdirSync(path.join(out, "widget"), { recursive: true });
  fs.copyFileSync(widgetSource, path.join(out, "widget", "CloudInversionWidget.js"));
}

const bytes = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).reduce((total, entry) => {
    const full = path.join(dir, entry.name);
    return total + (entry.isDirectory() ? bytes(full) : fs.statSync(full).size);
  }, 0);

console.log(`Built _site/ (${(bytes(out) / 1024).toFixed(1)} KB)`);
