/* Above the Clouds — service worker
 * Keeps the app shell available offline and updates static files from the
 * network when they are available. Weather requests always go straight to the
 * network; the app keeps its own last-good forecast in localStorage.
 */
"use strict";

var VERSION = "atc-v2";
var SHELL_CACHE = VERSION + "-shell";
var RUNTIME_CACHE = VERSION + "-runtime";

var SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./shared/conditions.js",
  "./shared/openmeteo.js",
  "./locations.json",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
  "./icons/apple-touch-icon.png",
  "./icons/favicon.svg"
];

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(SHELL_CACHE).then(function (cache) {
      return cache.addAll(SHELL);
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (key) {
        if (key !== SHELL_CACHE && key !== RUNTIME_CACHE) return caches.delete(key);
      }));
    }).then(function () {
      return self.clients.claim();
    })
  );
});

self.addEventListener("message", function (event) {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", function (event) {
  var request = event.request;
  if (request.method !== "GET") return;

  var url;
  try {
    url = new URL(request.url);
  } catch (err) {
    return;
  }

  // Weather and notification APIs are never cached by the worker.
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).then(function (response) {
        if (response && response.ok) {
          var copy = response.clone();
          caches.open(SHELL_CACHE).then(function (cache) { cache.put("./index.html", copy); });
        }
        return response;
      }).catch(function () {
        return caches.match("./index.html").then(function (cached) {
          return cached || caches.match("./") || new Response("Offline", { status: 503, headers: { "Content-Type": "text/plain" } });
        });
      })
    );
    return;
  }

  // Network-first for static assets: a fresh deployment should show up on the
  // next load, while the cache still covers offline launches.
  event.respondWith(
    fetch(request).then(function (response) {
      if (response && response.ok) {
        var copy = response.clone();
        caches.open(RUNTIME_CACHE).then(function (cache) { cache.put(request, copy); });
      }
      return response;
    }).catch(function () {
      return caches.match(request).then(function (cached) {
        return cached || new Response("Offline", { status: 503, headers: { "Content-Type": "text/plain" } });
      });
    })
  );
});
