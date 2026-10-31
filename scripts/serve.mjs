#!/usr/bin/env node
/*
 * Tiny local static server for the assembled site.
 *
 *   node scripts/serve.mjs
 *   node scripts/serve.mjs --port 5000
 *
 * This is only for development; any static host can serve _site/.
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..", "_site");
const args = process.argv.slice(2);
const portIndex = args.indexOf("--port");
const port = Number(portIndex >= 0 ? args[portIndex + 1] : process.env.PORT || 4173);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8"
};

if (!fs.existsSync(path.join(root, "index.html"))) {
  console.error("_site/ is missing. Run `node scripts/build-site.mjs` first.");
  process.exit(1);
}

const server = http.createServer((request, response) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
  } catch (error) {
    response.writeHead(400).end("Bad request");
    return;
  }

  if (pathname.endsWith("/")) pathname += "index.html";
  const file = path.resolve(root, "." + pathname);

  if (!file.startsWith(root + path.sep) && file !== path.join(root, "index.html")) {
    response.writeHead(403).end("Forbidden");
    return;
  }

  fs.stat(file, (error, stats) => {
    if (error || !stats.isFile()) {
      // Serve the app shell for unknown paths so deep links keep working.
      fs.readFile(path.join(root, "index.html"), (indexError, html) => {
        if (indexError) {
          response.writeHead(404).end("Not found");
          return;
        }
        response.writeHead(200, {
          "Content-Type": MIME[".html"],
          "Cache-Control": "no-cache"
        });
        response.end(html);
      });
      return;
    }

    response.writeHead(200, {
      "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-cache",
      "Service-Worker-Allowed": "/"
    });
    fs.createReadStream(file).pipe(response);
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Above the Clouds: http://localhost:${port}`);
  console.log("Press Ctrl+C to stop.");
});
