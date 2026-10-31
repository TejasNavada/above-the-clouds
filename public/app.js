/* Above the Clouds — app shell */
(function () {
  "use strict";

  var TZ = "America/Los_Angeles";
  var SETTINGS_KEY = "atc:settings:v1";
  var CACHE_KEY = "atc:cache:v1";
  var SUMMARY_KEY = "atc:summaries:v1";
  var REFRESH_MS = 15 * 60 * 1000;

  var FALLBACK_LOCATION = {
    id: "boccardo-peak",
    name: "Boccardo Peak",
    region: "San Jose & South Bay",
    peak: { lat: 37.4056127, lon: -121.806776, elevationFt: 1896 },
    valley: { lat: 37.3382, lon: -121.8863, name: "San Jose", elevationFt: 90 },
    notes: "Sierra Vista Open Space Preserve"
  };

  var state = {
    locations: [],
    location: null,
    forecast: null,
    weather: null,
    loading: true,
    error: null,
    stale: false,
    lastUpdated: null,
    forecastRequest: 0,
    summaries: {},
    summarySavedAt: null,
    summaryLoading: false,
    summaryStale: false,
    summaryError: null,
    summaryPromise: null,
    bayWeather: null,
    bayWeatherSavedAt: null,
    openBayOnInit: false,
    settings: null,
    openSheet: null,
    lastFocus: null,
    timelineHours: [],
    fromLink: false,
    widgetSourcePromise: null,
    widgetSourceText: ""
  };

  var dom = {};

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------

  function $(id) {
    return document.getElementById(id);
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }

  function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
  }

  function round(v) {
    return Math.round(v);
  }

  function toNumber(v, fallback) {
    return typeof v === "number" && isFinite(v) ? v : fallback;
  }

  function formatClock(ms) {
    if (!ms) return "—";
    return CloudInversion.formatTime(Math.floor(ms / 1000), TZ, true);
  }

  function formatRelative(ms) {
    if (!ms) return "—";
    var seconds = Math.max(0, Math.floor((Date.now() - ms) / 1000));
    if (seconds < 45) return "just now";
    if (seconds < 3600) return Math.round(seconds / 60) + " min ago";
    if (seconds < 86400) return Math.round(seconds / 3600) + " hr ago";
    return formatClock(ms);
  }

  function formatCountdown(targetTs) {
    return CloudInversion.formatCountdown(targetTs - Math.floor(Date.now() / 1000));
  }

  function formatShortDate(dateString) {
    var p = String(dateString).split("-").map(Number);
    var d = new Date(Date.UTC(p[0], p[1] - 1, p[2], 12));
    return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(d);
  }

  function formatMaybe(value, suffix, digits) {
    if (value == null || isNaN(value)) return "—";
    var n = Number(value);
    return (digits == null ? Math.round(n) : n.toFixed(digits)) + (suffix || "");
  }

  function showToast(message, duration) {
    if (!dom.toast) return;
    dom.toast.textContent = message;
    dom.toast.classList.add("is-visible");
    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(function () {
      dom.toast.classList.remove("is-visible");
    }, duration || 2800);
  }

  function legacyCopy(text) {
    return new Promise(function (resolve, reject) {
      try {
        var area = document.createElement("textarea");
        area.value = text;
        area.setAttribute("readonly", "");
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.select();
        document.execCommand("copy");
        document.body.removeChild(area);
        resolve();
      } catch (err) {
        reject(err);
      }
    });
  }

  function copyText(text) {
    if (!text) return Promise.reject(new Error("Nothing to copy"));
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).catch(function () {
        return legacyCopy(text);
      });
    }
    return legacyCopy(text);
  }

  function haversineMiles(a, b) {
    var toRad = Math.PI / 180;
    var dLat = (b.lat - a.lat) * toRad;
    var dLon = (b.lon - a.lon) * toRad;
    var lat1 = a.lat * toRad;
    var lat2 = b.lat * toRad;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 3958.8 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  }

  // ---------------------------------------------------------------------------
  // Settings and cache
  // ---------------------------------------------------------------------------

  function defaultSettings() {
    return {
      locationId: "boccardo-peak",
      ntfyTopic: "",
      onboardingDone: false,
      threshold: 70,
      locationSort: "best"
    };
  }

  function loadSettings() {
    var base = defaultSettings();
    try {
      var raw = localStorage.getItem(SETTINGS_KEY);
      if (!raw) return base;
      var saved = JSON.parse(raw);
      return Object.assign(base, saved && typeof saved === "object" ? saved : {});
    } catch (err) {
      return base;
    }
  }

  function saveSettings() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
    } catch (err) {
      // Private mode or full storage: the app still works without persistence.
    }
  }

  function cacheForecast(weather, forecast) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({
        locationId: state.location.id,
        savedAt: Date.now(),
        weather: weather,
        forecast: forecast
      }));
    } catch (err) {
      // Ignore quota errors.
    }
  }

  function readCache(locationId) {
    try {
      var raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      var saved = JSON.parse(raw);
      if (!saved || saved.locationId !== locationId || !saved.forecast) return null;
      return saved;
    } catch (err) {
      return null;
    }
  }

  function rescoreCached(cached) {
    if (cached && cached.weather && cached.weather.peak && cached.weather.valley) {
      try {
        // Re-score the saved weather at the current time so the "current"
        // hour stays meaningful when a cached forecast is shown on launch.
        return CloudInversion.evaluateForecast({
          peak: cached.weather.peak,
          valley: cached.weather.valley,
          location: state.location,
          now: Math.floor(Date.now() / 1000),
          timezone: TZ,
          threshold: state.settings.threshold
        });
      } catch (err) {
        // Fall through to the forecast that was saved with the weather.
      }
    }
    return cached ? cached.forecast : null;
  }

  function readSummaryCache() {
    try {
      var raw = localStorage.getItem(SUMMARY_KEY);
      if (!raw) return null;
      var saved = JSON.parse(raw);
      if (!saved || !saved.byLocation || typeof saved.byLocation !== "object") return null;
      return {
        byLocation: saved.byLocation,
        savedAt: saved.savedAt || null
      };
    } catch (err) {
      return null;
    }
  }

  function saveSummaryCache() {
    try {
      localStorage.setItem(SUMMARY_KEY, JSON.stringify({
        savedAt: state.summarySavedAt,
        byLocation: state.summaries
      }));
    } catch (err) {
      // The picker still works for this session if storage is full.
    }
  }

  function activeSummary(id) {
    var summary = state.summaries[id];
    if (!summary || summary.score == null || !summary.ts) return null;
    var now = Math.floor(Date.now() / 1000);
    if (summary.endTs && summary.endTs <= now) return null;
    return summary;
  }

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------

  document.addEventListener("DOMContentLoaded", init);

  function init() {
    cacheDom();
    state.settings = loadSettings();

    var params = new URLSearchParams(window.location.search);
    var linkedLocation = params.get("location");
    if (linkedLocation) {
      state.settings.locationId = linkedLocation;
      state.fromLink = true;
    }
    if (params.get("bay") === "1") {
      state.fromLink = true;
      state.openBayOnInit = true;
    }
    if (linkedLocation || state.openBayOnInit) {
      // Consume deep-link parameters so a later manual location change is not
      // undone when the page is reloaded from the same URL.
      try {
        params.delete("location");
        params.delete("bay");
        var query = params.toString();
        history.replaceState(null, "", window.location.pathname + (query ? "?" + query : "") + window.location.hash);
      } catch (err) {
        // Some locked-down browsers do not allow history updates.
      }
    }

    var cachedSummaries = readSummaryCache();
    if (cachedSummaries) {
      state.summaries = cachedSummaries.byLocation;
      state.summarySavedAt = cachedSummaries.savedAt;
      state.summaryStale = true;
    }

    bindEvents();
    registerServiceWorker();
    renderLoading();
    startTimers();

    loadLocations().then(function () {
      var saved = state.locations.find(function (l) { return l.id === state.settings.locationId; });
      state.location = saved || state.locations[0] || FALLBACK_LOCATION;
      state.settings.locationId = state.location.id;
      saveSettings();
      renderLocationHeader();
      renderLocationList();
      renderLocationStatus();
      renderSettingsValues();

      if (state.openBayOnInit) {
        state.openBayOnInit = false;
        openSheet(dom.locationSheet);
      }

      // Compute the whole bay's 3-day outlook in one bulk Open-Meteo request.
      // This runs in the background so the selected peak still paints fast.
      loadBaySummaries();

      // Show the last good forecast immediately, then refresh in the
      // background. A cold phone launch should never wait on the network
      // before showing a verdict.
      var cached = readCache(state.location.id);
      if (cached) {
        state.forecast = rescoreCached(cached);
        state.weather = cached.weather;
        state.lastUpdated = cached.savedAt;
        state.stale = true;
        state.loading = false;
        renderAll();
        return loadForecast({ silent: true });
      }
      return loadForecast();
    }).then(function () {
      if (!state.settings.onboardingDone && !state.fromLink) {
        setTimeout(showOnboarding, 650);
      }
    });
  }

  function cacheDom() {
    [
      "hero", "heroWord", "heroTitle", "heroCopy", "heroEyebrow", "heroStats", "liveDot",
      "locationName", "locationMeta", "locationBtn", "settingsBtn", "refreshBtn",
      "windowCard", "windowIcon", "windowEyebrow", "windowTitle", "windowMeta", "alertBtn",
      "timeline", "timelineRefreshBtn", "sunriseLabel", "scoreNote",
      "whyGrid", "outlook", "updatedAt",
      "sheetBackdrop", "locationSheet", "settingsSheet", "detailSheet",
      "locationSearch", "locationList", "useLocationBtn", "locationSort", "locationStatus", "settingsLocationBtn",
      "settingsLocationName", "settingsLocationMeta", "ntfyTopic",
      "generateTopicBtn", "copyTopicBtn", "testNotifyBtn", "copyWidgetBtn",
      "replayOnboardingBtn", "detailEyebrow", "detailSheetTitle", "detailBody",
      "onboarding", "onboardingStartBtn", "onboardingSettingsBtn", "toast"
    ].forEach(function (id) {
      dom[id] = $(id);
    });
  }

  // ---------------------------------------------------------------------------
  // Locations
  // ---------------------------------------------------------------------------

  async function loadLocations() {
    try {
      var response = await fetch("./locations.json", { cache: "no-cache" });
      if (!response.ok) throw new Error("HTTP " + response.status);
      var data = await response.json();
      if (!Array.isArray(data) || !data.length) throw new Error("Empty location list");
      state.locations = data.filter(function (l) {
        return l && l.id && l.peak && l.valley && l.peak.lat != null && l.peak.lon != null;
      });
      if (!state.locations.length) throw new Error("No valid locations");
    } catch (err) {
      state.locations = [FALLBACK_LOCATION];
      showToast("Couldn't load the peak list. Using Boccardo Peak.");
    }
  }

  function renderLocationHeader() {
    if (!state.location) return;
    var loc = state.location;
    dom.locationName.textContent = loc.name;
    dom.locationMeta.textContent = loc.peak.elevationFt.toLocaleString() + " ft · " + loc.region;
    dom.settingsLocationName.textContent = loc.name;
    dom.settingsLocationMeta.textContent = loc.peak.elevationFt.toLocaleString() + " ft · " + loc.valley.name;
  }

  function formatSummaryTime(summary) {
    var now = Math.floor(Date.now() / 1000);
    if (summary.ts <= now && summary.endTs > now) {
      return summary.isGo ? "Now–" + CloudInversion.formatTime(summary.endTs, TZ, true) : "Now";
    }
    var day = CloudInversion.formatDayLabel(summary.ts, TZ, now);
    var shortDay = day === "Today" ? "Today" : day === "Tomorrow" ? "Tmrw" : day.split(",")[0];
    var start = CloudInversion.formatTime(summary.ts, TZ, true);
    var range = summary.isGo && summary.endTs
      ? "–" + CloudInversion.formatTime(summary.endTs, TZ, true)
      : "";
    return shortDay + " " + start + range;
  }

  function locationRow(loc, showRegion) {
    var selected = state.location && loc.id === state.location.id;
    var summary = activeSummary(loc.id);
    var tone = summary
      ? summary.isGo ? "good" : summary.score >= 50 ? "maybe" : "no"
      : "empty";
    var time = summary ? formatSummaryTime(summary) : state.summaryLoading ? "…" : "—";
    var sub = showRegion
      ? loc.region + " · " + (loc.notes || loc.valley.name)
      : loc.notes || loc.valley.name;
    var aria = loc.name + ", " + loc.peak.elevationFt.toLocaleString() + " feet. " +
      (summary
        ? (summary.isGo ? "GO window" : "Best chance") + " " + summary.score + " out of 100, " + time + "."
        : "Outlook loading.");

    return '<button class="location-item' + (selected ? " is-selected" : "") + '" type="button" data-id="' + escapeHtml(loc.id) + '" aria-label="' + escapeHtml(aria) + '">' +
      '<span class="loc-check"><svg><use href="#i-check"></use></svg></span>' +
      '<span class="loc-copy"><strong>' + escapeHtml(loc.name) + "</strong><small>" + escapeHtml(sub) + "</small></span>" +
      '<span class="loc-side">' +
        '<span class="loc-side-top">' +
          '<span class="loc-score" data-tone="' + tone + '">' + (summary ? summary.score : "—") + "</span>" +
          '<span class="loc-elev">' + loc.peak.elevationFt.toLocaleString() + " ft</span>" +
        "</span>" +
        '<span class="loc-time">' + escapeHtml(time) + "</span>" +
      "</span>" +
      "</button>";
  }

  function compareLocationsByOutlook(a, b) {
    var aSummary = activeSummary(a.id);
    var bSummary = activeSummary(b.id);
    var aScore = aSummary ? aSummary.score : -1;
    var bScore = bSummary ? bSummary.score : -1;
    if (aScore !== bScore) return bScore - aScore;
    var aTs = aSummary ? aSummary.ts : Number.MAX_SAFE_INTEGER;
    var bTs = bSummary ? bSummary.ts : Number.MAX_SAFE_INTEGER;
    if (aTs !== bTs) return aTs - bTs;
    return a.name.localeCompare(b.name);
  }

  function renderLocationSort() {
    if (!dom.locationSort) return;
    var sort = state.settings.locationSort === "region" ? "region" : "best";
    dom.locationSort.querySelectorAll("button[data-sort]").forEach(function (button) {
      button.setAttribute("aria-pressed", button.dataset.sort === sort ? "true" : "false");
    });
  }

  function renderLocationStatus() {
    if (!dom.locationStatus) return;
    var count = Object.keys(state.summaries).length;
    var total = state.locations.length || 38;
    var goCount = state.locations.reduce(function (sum, loc) {
      var summary = activeSummary(loc.id);
      return sum + (summary && summary.isGo ? 1 : 0);
    }, 0);
    var stamp = state.summarySavedAt ? formatClock(state.summarySavedAt) : "";

    if (state.summaryLoading) {
      dom.locationStatus.textContent = count ? "Refreshing bay outlook…" : "Computing " + total + " peaks…";
      return;
    }
    if (!count) {
      dom.locationStatus.textContent = state.summaryError ? "Bay outlook unavailable" : "Bay outlook not loaded";
      return;
    }
    dom.locationStatus.textContent =
      goCount + " GO · " +
      count + " peaks · " +
      (state.summaryStale ? "saved " : "") +
      stamp;
  }

  function renderLocationList(query) {
    var filter = String(query || "").trim().toLowerCase();
    var matches = state.locations.filter(function (loc) {
      var haystack = [loc.name, loc.region, loc.valley && loc.valley.name, loc.notes].join(" ").toLowerCase();
      return !filter || haystack.indexOf(filter) !== -1;
    });

    if (!matches.length) {
      dom.locationList.innerHTML = '<div class="empty-locations">No peaks match “' + escapeHtml(query) + '”.</div>';
      renderLocationSort();
      return;
    }

    var sort = state.settings.locationSort === "region" ? "region" : "best";
    var html = "";
    if (sort === "best") {
      matches.sort(compareLocationsByOutlook);
      html += '<div class="location-group"><h3>' + (filter ? "Best matches" : "Best 3-day chance") + "</h3>";
      matches.forEach(function (loc) {
        html += locationRow(loc, true);
      });
      html += "</div>";
    } else {
      var groups = {};
      var order = [];
      matches.forEach(function (loc) {
        if (!groups[loc.region]) {
          groups[loc.region] = [];
          order.push(loc.region);
        }
        groups[loc.region].push(loc);
      });
      order.forEach(function (region) {
        html += '<div class="location-group"><h3>' + escapeHtml(region) + "</h3>";
        groups[region].forEach(function (loc) {
          html += locationRow(loc, false);
        });
        html += "</div>";
      });
    }

    dom.locationList.innerHTML = html;
    renderLocationSort();
  }

  async function selectLocation(id) {
    var loc = state.locations.find(function (l) { return l.id === id; });
    if (!loc) return;
    if (state.location && state.location.id === id) {
      closeAllSheets();
      return;
    }
    state.location = loc;
    state.settings.locationId = id;
    saveSettings();
    renderLocationHeader();
    renderLocationList(dom.locationSearch ? dom.locationSearch.value : "");
    closeAllSheets();
    window.scrollTo({ top: 0, behavior: "smooth" });
    if (!applyBayForecast(id)) await loadForecast();
  }

  function useMyLocation() {
    if (!navigator.geolocation) {
      showToast("This browser doesn't support location access.");
      return;
    }
    dom.useLocationBtn.disabled = true;
    dom.useLocationBtn.classList.add("is-busy");
    navigator.geolocation.getCurrentPosition(function (position) {
      var point = { lat: position.coords.latitude, lon: position.coords.longitude };
      var nearest = null;
      var nearestDistance = Infinity;
      state.locations.forEach(function (loc) {
        var distance = haversineMiles(point, loc.peak);
        if (distance < nearestDistance) {
          nearestDistance = distance;
          nearest = loc;
        }
      });
      dom.useLocationBtn.disabled = false;
      dom.useLocationBtn.classList.remove("is-busy");
      if (nearest) {
        showToast("Closest peak: " + nearest.name + " (" + Math.round(nearestDistance) + " mi away)");
        selectLocation(nearest.id);
      }
    }, function () {
      dom.useLocationBtn.disabled = false;
      dom.useLocationBtn.classList.remove("is-busy");
      showToast("Location access was denied. Pick a peak from the list.");
    }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 });
  }

  // ---------------------------------------------------------------------------
  // Forecast loading
  // ---------------------------------------------------------------------------

  async function loadForecast(options) {
    options = options || {};
    if (!state.location) return;
    var requestId = state.forecastRequest + 1;
    state.forecastRequest = requestId;
    setRefreshing(true);

    if (!options.silent) {
      state.loading = true;
      state.error = null;
      renderLoading();
    }

    try {
      var weather = await CloudWeather.fetchForecast(state.location);
      if (requestId !== state.forecastRequest) return;
      var forecast = CloudInversion.evaluateForecast({
        peak: weather.peak,
        valley: weather.valley,
        location: state.location,
        now: Math.floor(Date.now() / 1000),
        timezone: TZ,
        threshold: state.settings.threshold
      });

      state.weather = weather;
      state.forecast = forecast;
      state.error = null;
      state.stale = false;
      state.lastUpdated = Date.now();
      state.loading = false;
      cacheForecast(weather, forecast);
      renderAll();
      if (options.toast) showToast("Forecast updated.");
    } catch (err) {
      if (requestId !== state.forecastRequest) return;
      var cached = readCache(state.location.id);
      if (cached) {
        state.forecast = rescoreCached(cached);
        state.weather = cached.weather;
        state.lastUpdated = cached.savedAt;
        state.stale = true;
        state.error = err;
        state.loading = false;
        renderAll();
        showToast("Using the last saved forecast. Check your connection.");
      } else {
        state.error = err;
        state.loading = false;
        renderError();
        showToast("Couldn't reach the weather service.");
      }
    } finally {
      if (requestId === state.forecastRequest) setRefreshing(false);
    }
  }

  function applyBayForecast(locationId) {
    var raw = state.bayWeather && state.bayWeather[locationId];
    if (!raw) return false;
    try {
      var forecast = CloudInversion.evaluateForecast({
        peak: raw.peak,
        valley: raw.valley,
        location: state.location,
        now: Math.floor(Date.now() / 1000),
        timezone: TZ,
        threshold: state.settings.threshold
      });
      // Invalidate any slower single-location request that may still be in
      // flight from a previous selection.
      state.forecastRequest += 1;
      state.forecast = forecast;
      state.weather = raw;
      state.lastUpdated = state.bayWeatherSavedAt || Date.now();
      state.stale = false;
      state.error = null;
      state.loading = false;
      cacheForecast(raw, forecast);
      renderAll();
      return true;
    } catch (err) {
      return false;
    }
  }

  function loadBaySummaries() {
    if (!state.locations.length) return Promise.resolve();
    if (state.summaryPromise) return state.summaryPromise;

    state.summaryLoading = true;
    state.summaryError = null;
    renderLocationStatus();

    state.summaryPromise = CloudWeather.fetchBayForecast(state.locations, { forecastHours: 80 })
      .then(function (bay) {
        var now = Math.floor(Date.now() / 1000);
        var byLocation = {};
        var bayWeather = {};
        bay.locations.forEach(function (item) {
          bayWeather[item.location.id] = { peak: item.peak, valley: item.valley };
          try {
            var forecast = CloudInversion.evaluateForecast({
              peak: item.peak,
              valley: item.valley,
              location: item.location,
              now: now,
              timezone: TZ,
              threshold: state.settings.threshold
            });
            var summary = CloudInversion.summarizeForecast(forecast, now);
            var chosen = summary.go || summary.best;
            if (!chosen) return;
            byLocation[item.location.id] = {
              score: chosen.score,
              ts: chosen.ts,
              endTs: chosen.endTs,
              isGo: Boolean(summary.go)
            };
          } catch (err) {
            // One unusual forecast location should not blank the whole list.
          }
        });
        if (!Object.keys(byLocation).length) throw new Error("No bay outlooks could be computed");
        state.summaries = byLocation;
        state.bayWeather = bayWeather;
        state.bayWeatherSavedAt = Date.now();
        state.summarySavedAt = Date.now();
        state.summaryStale = false;
        state.summaryError = null;
        saveSummaryCache();
        if (state.openSheet === dom.locationSheet) renderLocationList(dom.locationSearch.value);
      })
      .catch(function (err) {
        state.summaryError = err;
        if (state.summarySavedAt) state.summaryStale = true;
      })
      .then(function () {
        state.summaryLoading = false;
        state.summaryPromise = null;
        renderLocationStatus();
        if (state.openSheet === dom.locationSheet) renderLocationList(dom.locationSearch.value);
      });

    return state.summaryPromise;
  }

  function refreshAll(options) {
    loadForecast(options);
    loadBaySummaries();
  }

  function setRefreshing(isRefreshing) {
    [dom.refreshBtn, dom.timelineRefreshBtn].forEach(function (btn) {
      if (!btn) return;
      btn.classList.toggle("is-spinning", isRefreshing);
      btn.disabled = isRefreshing;
    });
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  function renderAll() {
    if (!state.forecast) return;
    renderHero();
    renderWindowCard();
    renderTimeline();
    renderWhy();
    renderOutlook();
    renderUpdated();
    renderLocationHeader();
    renderSettingsValues();
    dom.scoreNote.textContent = "Score " + state.forecast.current.score + "/100";
  }

  function renderHero() {
    var c = state.forecast.current;
    var tone = CloudInversion.verdictTone(c.verdict.code);
    dom.hero.dataset.tone = tone;
    dom.heroWord.classList.remove("hero-word--loading", "hero-word--small");

    var headline = CloudInversion.verdictHeadline(c.verdict.code);
    dom.heroWord.textContent = headline;
    if (headline.length > 5) dom.heroWord.classList.add("hero-word--small");

    dom.heroEyebrow.textContent = state.stale
      ? "Saved forecast · " + c.timeLabel
      : c.verdict.code === "GOOD"
        ? "Window open now"
        : "Conditions at " + c.timeLabel;

    dom.heroTitle.textContent = heroTitle(c);
    dom.heroCopy.textContent = c.verdict.reason;
    dom.liveDot.style.background = tone === "good" ? "var(--good)" : tone === "maybe" ? "var(--maybe)" : "var(--no)";

    dom.heroStats.innerHTML =
      '<span class="stat"><svg><use href="#i-sparkle"></use></svg><strong>' + c.score + "</strong>/100</span>" +
      '<span class="stat"><svg><use href="#i-cloud"></use></svg>' + CloudInversion.cloudStateLabel(c.cloudState) + "</span>" +
      '<span class="stat"><svg><use href="#i-wind"></use></svg><strong>' + Math.round(c.effectiveWindMph) + "</strong> mph</span>";
  }

  function heroTitle(hour) {
    switch (hour.verdict.code) {
      case "GOOD": return "You'd be above the clouds.";
      case "MAYBE": return "Worth a look, not a guarantee.";
      case "NIGHT": return "The deck is still forming.";
      case "LATE": return "The morning window has passed.";
      case "IN_CLOUD": return "You'd be in the fog.";
      case "NO_DECK": return "No sea of clouds right now.";
      case "CLOUDY_ABOVE": return "Cloudy overhead.";
      case "CLOUDS_ABOVE": return "The deck is above you.";
      case "SUMMIT_NOT_CLEAR": return "The summit is fogged in.";
      case "WINDY": return "Too windy for a clean deck.";
      case "RAIN": return "Rain is in the forecast.";
      default: return "The ingredients don't line up.";
    }
  }

  function renderWindowCard() {
    var f = state.forecast;
    var now = Math.floor(Date.now() / 1000);
    var tone = "no";
    var icon = "i-fog";
    var eyebrow = "Looking ahead";
    var title = "No GO window in the next 3 days";
    var meta = "Best chance " + f.bestHour.score + "/100 · " + CloudInversion.formatDayLabel(f.bestHour.ts, TZ, now) + " " + f.bestHour.timeLabel;

    if (f.currentWindow) {
      tone = "good";
      icon = "i-sunrise";
      eyebrow = "Window open now";
      title = "Open until " + CloudInversion.formatTime(f.currentWindow.endTs, TZ, true);
      meta = "Score " + f.currentWindow.score + " · " + formatCountdown(f.currentWindow.endTs) + " left";
    } else if (f.nextWindow) {
      tone = "good";
      icon = "i-sunrise";
      eyebrow = "Next good window";
      title = f.nextWindow.label;
      meta = "In " + formatCountdown(f.nextWindow.startTs) + " · score " + f.nextWindow.score + "/100";
    } else if (f.bestHour.score >= 50) {
      tone = "maybe";
      icon = "i-cloud-sun";
      eyebrow = "Best chance";
      title = CloudInversion.formatDayLabel(f.bestHour.ts, TZ, now) + " · " + f.bestHour.timeLabel;
      meta = "Score " + f.bestHour.score + "/100 · " + CloudInversion.cloudStateLabel(f.bestHour.cloudState);
    } else {
      title = "No GO window in the next 3 days";
    }

    dom.windowCard.dataset.tone = tone;
    dom.windowEyebrow.textContent = eyebrow;
    dom.windowTitle.textContent = title;
    dom.windowMeta.textContent = meta;
    dom.windowIcon.innerHTML = '<svg><use href="#' + icon + '"></use></svg>';
  }

  function renderTimeline() {
    var f = state.forecast;
    var now = Math.floor(Date.now() / 1000);
    var startIndex = f.hours.findIndex(function (h) { return h.ts + 3600 > now; });
    if (startIndex < 0) startIndex = 0;
    var hours = f.hours.slice(startIndex, startIndex + 24);
    state.timelineHours = hours;

    var sunriseTs = null;
    for (var i = 0; i < f.days.length; i++) {
      if (f.days[i].sunriseTs && f.days[i].sunriseTs >= now - 3600) {
        sunriseTs = f.days[i].sunriseTs;
        break;
      }
    }
    if (!sunriseTs && f.current.sunriseTs) sunriseTs = f.current.sunriseTs;
    dom.sunriseLabel.textContent = sunriseTs ? "Sunrise " + CloudInversion.formatTime(sunriseTs, TZ, true) : "Sunrise —";

    var html = "";
    hours.forEach(function (h, index) {
      var tone = CloudInversion.verdictTone(h.verdict.code);
      var isNow = h.ts <= now && h.ts + 3600 > now;
      var isSunrise = sunriseTs && h.ts >= sunriseTs - 1800 && h.ts <= sunriseTs + 1800;
      var showLabel = h.hour % 3 === 0 || isNow || isSunrise || index === 0;
      var height = Math.round(14 + clamp(h.score, 0, 100) * 0.62);
      var timeLabel = isNow ? "Now" : CloudInversion.formatTime(h.ts, TZ, false).replace(" ", "<br>");
      var aria = h.timeLabel + ", " + CloudInversion.formatDayLabel(h.ts, TZ, now) + ": " + h.score + " out of 100, " + h.verdict.label + ". " + h.verdict.reason;

      html += '<button class="tl-hour' + (isNow ? " is-now" : "") + (h.verdict.code === "GOOD" ? " is-good" : "") + '" type="button" role="listitem" data-tone="' + tone + '" data-index="' + index + '" aria-label="' + escapeHtml(aria) + '">' +
        '<span class="tl-sun">' + (isSunrise ? '<svg><use href="#i-sunrise"></use></svg>' : "") + "</span>" +
        '<span class="tl-track"><span class="tl-bar" style="height:' + height + 'px"></span></span>' +
        '<span class="tl-time">' + (showLabel ? timeLabel : "&nbsp;") + "</span>" +
        "</button>";
    });
    dom.timeline.innerHTML = html;
  }

  function renderWhy() {
    var f = state.forecast;
    var h = f.current;
    var above = aboveCloudPercent(h);
    var anomaly = lapseAnomaly(h, f);
    var inversion = h.metrics.inversion;

    var deckTone = h.cloudState === "below" ? "good" : h.cloudState === "edge" ? "maybe" : "no";
    var skyTone = h.metrics.skyClear >= 0.7 ? "good" : h.metrics.skyClear >= 0.4 ? "maybe" : "no";
    var windTone = h.effectiveWindMph < 10 ? "good" : h.effectiveWindMph < 18 ? "maybe" : "no";
    var invTone = inversion == null ? "no" : inversion >= 0.55 ? "good" : inversion >= 0.25 ? "maybe" : "no";

    var tiles = [
      {
        icon: "i-cloud",
        label: "Cloud deck",
        value: CloudInversion.cloudStateLabel(h.cloudState),
        detail: CloudInversion.cloudStateDetail(h, f.peakElevationFt),
        tone: deckTone,
        fill: Math.round(clamp(h.metrics.valleyCloud, 0, 1) * 100)
      },
      {
        icon: "i-eye",
        label: "Sky above",
        value: skyLabel(above),
        detail: "Mid/high cloud " + Math.round(above) + "%",
        tone: skyTone,
        fill: Math.round(clamp(h.metrics.skyClear, 0, 1) * 100)
      },
      {
        icon: "i-wind",
        label: "Wind",
        value: windLabel(h.effectiveWindMph),
        detail: Math.round(h.peak.windMph || 0) + " mph · gusts " + Math.round(h.peak.gustMph || 0),
        tone: windTone,
        fill: Math.round(clamp(h.metrics.calm, 0, 1) * 100)
      },
      {
        icon: "i-thermometer",
        label: "Inversion",
        value: inversionLabel(inversion),
        detail: anomaly == null ? "Temperature profile unavailable" : "Peak is " + Math.round(Math.abs(anomaly)) + "°F " + (anomaly >= 0 ? "warmer" : "colder") + " than the normal lapse rate",
        tone: invTone,
        fill: Math.round(clamp(inversion == null ? 0 : inversion, 0, 1) * 100)
      }
    ];

    dom.whyGrid.innerHTML = tiles.map(function (tile) {
      return '<div class="why-tile" data-tone="' + tile.tone + '">' +
        '<span class="why-icon"><svg><use href="#' + tile.icon + '"></use></svg></span>' +
        '<span class="why-label">' + tile.label + "</span>" +
        '<strong class="why-value">' + escapeHtml(tile.value) + "</strong>" +
        '<span class="why-detail">' + escapeHtml(tile.detail) + "</span>" +
        '<span class="tile-bar"><span style="--value:' + tile.fill + '%"></span></span>' +
        "</div>";
    }).join("");
  }

  function renderOutlook() {
    var f = state.forecast;
    var now = Math.floor(Date.now() / 1000);
    var days = f.days.slice(0, 3);

    dom.outlook.innerHTML = days.map(function (day) {
      var future = day.hours.filter(function (h) { return h.ts + 3600 > now; });
      if (!future.length) future = day.hours;
      var bestHour = future.reduce(function (a, b) { return b.score > a.score ? b : a; }, future[0]);
      var window = day.windows.find(function (w) { return w.endTs > now; }) || null;
      var tone = window ? "good" : bestHour.score >= 50 ? "maybe" : "no";
      var score = window ? window.score : bestHour.score;
      var windowText = window
        ? CloudInversion.formatTime(window.startTs, TZ, false) + " – " + CloudInversion.formatTime(window.endTs, TZ, false)
        : "No GO window";
      var sub = window
        ? CloudInversion.cloudStateLabel(bestHour.cloudState) + " · clear above"
        : "Best chance " + bestHour.score + " · " + bestHour.timeLabel;

      return '<button class="outlook-row" type="button" data-tone="' + tone + '" data-ts="' + bestHour.ts + '">' +
        '<span class="outlook-day"><strong>' + escapeHtml(day.label) + "</strong><small>" + escapeHtml(formatShortDate(day.date)) + "</small></span>" +
        '<span class="outlook-main"><span class="outlook-window">' + escapeHtml(windowText) + '</span><span class="outlook-sub">' + escapeHtml(sub) + '</span><span class="outlook-mini"><span style="width:' + clamp(score, 0, 100) + '%"></span></span></span>' +
        '<span class="outlook-score">' + score + "</span>" +
        "</button>";
    }).join("");
  }

  function renderUpdated() {
    if (!state.lastUpdated) {
      dom.updatedAt.textContent = "—";
      return;
    }
    dom.updatedAt.textContent = formatClock(state.lastUpdated) + (state.stale ? " (saved)" : "");
  }

  function renderSettingsValues() {
    if (!state.settings) return;
    if (dom.ntfyTopic && document.activeElement !== dom.ntfyTopic) {
      dom.ntfyTopic.value = state.settings.ntfyTopic || "";
    }
  }

  function aboveCloudPercent(hour) {
    var mid = hour.peak.mid == null ? 0 : hour.peak.mid;
    var high = hour.peak.high == null ? 0 : hour.peak.high;
    return clamp(Math.max(mid, high) + 0.25 * Math.min(mid, high), 0, 100);
  }

  function lapseAnomaly(hour, forecast) {
    if (hour.peak.tempF == null || hour.valley.tempF == null) return null;
    var expected = -3.5 * ((forecast.peakElevationFt - forecast.valleyElevationFt) / 1000);
    return (hour.peak.tempF - hour.valley.tempF) - expected;
  }

  function skyLabel(above) {
    if (above <= 20) return "Clear";
    if (above <= 50) return "Partly cloudy";
    if (above <= 80) return "Mostly cloudy";
    return "Overcast";
  }

  function windLabel(mph) {
    if (mph < 8) return "Calm";
    if (mph < 14) return "Light";
    if (mph < 20) return "Breezy";
    return "Windy";
  }

  function inversionLabel(value) {
    if (value == null) return "Unknown";
    if (value >= 0.66) return "Strong";
    if (value >= 0.33) return "Moderate";
    if (value >= 0.15) return "Weak";
    return "None";
  }

  // ---------------------------------------------------------------------------
  // Loading / error states
  // ---------------------------------------------------------------------------

  function renderLoading() {
    dom.hero.dataset.tone = "no";
    dom.heroWord.textContent = "…";
    dom.heroWord.classList.add("hero-word--loading");
    dom.heroWord.classList.remove("hero-word--small");
    dom.heroEyebrow.textContent = "Reading the sky";
    dom.heroTitle.textContent = "Checking the marine layer…";
    dom.heroCopy.textContent = "Comparing the summit with the valley and the sky above.";
    dom.heroStats.innerHTML = "";
    dom.windowCard.dataset.tone = "no";
    dom.windowEyebrow.textContent = "Next good window";
    dom.windowTitle.textContent = "Checking the forecast…";
    dom.windowMeta.textContent = "One moment.";
    dom.windowIcon.innerHTML = '<svg><use href="#i-sunrise"></use></svg>';
    dom.sunriseLabel.textContent = "Sunrise —";
    dom.scoreNote.textContent = "—";
    dom.timeline.innerHTML = '<div class="timeline-skeleton">' + Array.from({ length: 14 }, function (_, i) {
      return '<span style="--h:' + (24 + (i * 17) % 56) + '%"></span>';
    }).join("") + "</div>";
    dom.whyGrid.innerHTML = Array.from({ length: 4 }, function () {
      return '<div class="why-tile"><span class="skeleton" style="height:100%;min-height:100px"></span></div>';
    }).join("");
    dom.outlook.innerHTML = Array.from({ length: 3 }, function () {
      return '<div class="outlook-row"><span class="skeleton" style="height:12px;width:60px"></span><span class="skeleton" style="height:12px;width:100%"></span><span class="skeleton" style="height:28px;width:38px"></span></div>';
    }).join("");
    dom.updatedAt.textContent = "—";
  }

  function renderError() {
    dom.hero.dataset.tone = "no";
    dom.heroWord.textContent = "—";
    dom.heroWord.classList.remove("hero-word--loading", "hero-word--small");
    dom.heroEyebrow.textContent = "No connection";
    dom.heroTitle.textContent = "Couldn't read the sky.";
    dom.heroCopy.textContent = "The weather service didn't answer. Check your connection and try again.";
    dom.heroStats.innerHTML = '<button class="button button--soft" id="retryBtn" type="button">Try again</button>';
    var retry = $("retryBtn");
    if (retry) retry.addEventListener("click", function () { refreshAll(); });

    dom.windowCard.dataset.tone = "no";
    dom.windowEyebrow.textContent = "Forecast unavailable";
    dom.windowTitle.textContent = "Tap refresh to retry";
    dom.windowMeta.textContent = state.error ? String(state.error.message || state.error) : "Unknown error";
    dom.timeline.innerHTML = '<div class="empty-locations">No hourly data yet. Check your connection, then tap the refresh button above.</div>';
    dom.whyGrid.innerHTML = "";
    dom.outlook.innerHTML = '<div class="empty-locations">The outlook will appear after the first successful update.</div>';
    dom.scoreNote.textContent = "—";
    dom.updatedAt.textContent = "—";
  }

  // ---------------------------------------------------------------------------
  // Hour detail
  // ---------------------------------------------------------------------------

  function openDetail(hour) {
    if (!hour) return;
    var f = state.forecast;
    var now = Math.floor(Date.now() / 1000);
    var tone = CloudInversion.verdictTone(hour.verdict.code);
    var above = aboveCloudPercent(hour);
    var anomaly = lapseAnomaly(hour, f);
    var metrics = hour.metrics;

    dom.detailSheetTitle.textContent = CloudInversion.formatDayLabel(hour.ts, TZ, now) + " · " + hour.timeLabel;
    dom.detailEyebrow.textContent = "Hourly detail";

    var breakdown = [
      ["Cloud deck", metrics.valleyCloud, 30],
      ["Summit clear", metrics.peakClear, 30],
      ["Sky above", metrics.skyClear, 15],
      ["Calm wind", metrics.calm, 10],
      ["Morning timing", metrics.morning, 10],
      ["Inversion", metrics.inversion == null ? 0.5 : metrics.inversion, 5]
    ];

    dom.detailBody.innerHTML =
      '<div class="detail-hero" data-tone="' + tone + '">' +
        '<div class="detail-score">' + hour.score + "</div>" +
        '<div class="detail-verdict"><strong>' + escapeHtml(CloudInversion.verdictHeadline(hour.verdict.code)) + "</strong><span>" + escapeHtml(hour.verdict.reason) + "</span></div>" +
      "</div>" +
      '<div class="detail-grid">' +
        detailStat("Temperature", formatMaybe(hour.peak.tempF, "°F"), "Valley " + formatMaybe(hour.valley.tempF, "°F")) +
        detailStat("Humidity", formatMaybe(hour.peak.rh, "%"), "Valley " + formatMaybe(hour.valley.rh, "%")) +
        detailStat("Low clouds", formatMaybe(hour.peak.low, "%"), "Valley " + formatMaybe(hour.valley.low, "%")) +
        detailStat("Mid / high", formatMaybe(hour.peak.mid, "%") + " / " + formatMaybe(hour.peak.high, "%"), "Sky above " + Math.round(above) + "%") +
        detailStat("Visibility", formatMaybe(hour.peak.visMi, " mi", 1), "Valley " + formatMaybe(hour.valley.visMi, " mi", 1)) +
        detailStat("Wind", formatMaybe(hour.peak.windMph, " mph"), "Gusts " + formatMaybe(hour.peak.gustMph, " mph")) +
        detailStat("Rain (3h)", formatMaybe(hour.precip3h, " in", 2), "Peak + valley") +
        detailStat("Sunrise", hour.sunriseTs ? CloudInversion.formatTime(hour.sunriseTs, TZ, true) : "—", "Pacific time") +
      "</div>" +
      '<div class="breakdown" style="--status:' + (tone === "good" ? "var(--good)" : tone === "maybe" ? "var(--maybe)" : "var(--no)") + '">' +
        breakdown.map(function (item) {
          var fill = Math.round(clamp(item[1] == null ? 0 : item[1], 0, 1) * 100);
          return '<div class="breakdown-row"><span>' + item[0] + '</span><span class="breakdown-bar"><span style="--value:' + fill + '%"></span></span><span class="breakdown-value">' + Math.round(fill * item[2] / 100) + "</span></div>";
        }).join("") +
      "</div>" +
      '<div class="detail-note">' +
        "<strong>Why:</strong> " + escapeHtml(CloudInversion.cloudStateDetail(hour, f.peakElevationFt)) + ". " +
        (anomaly == null ? "" : "The peak is " + Math.round(Math.abs(anomaly)) + "°F " + (anomaly >= 0 ? "warmer" : "colder") + " than a normal lapse rate. ") +
        "Weighting: deck 30, summit 30, sky 15, wind 10, timing 10, inversion 5. Hard caps apply when a key ingredient is missing." +
      "</div>";

    openSheet(dom.detailSheet);
  }

  function detailStat(label, value, sub) {
    return '<div class="detail-stat"><span>' + label + "</span><strong>" + escapeHtml(value) + "</strong><small>" + escapeHtml(sub) + "</small></div>";
  }

  // ---------------------------------------------------------------------------
  // Sheets and onboarding
  // ---------------------------------------------------------------------------

  function openSheet(sheet) {
    if (!sheet) return;
    state.lastFocus = document.activeElement;
    if (state.openSheet && state.openSheet !== sheet) {
      state.openSheet.classList.remove("is-open");
      state.openSheet.hidden = true;
    }
    state.openSheet = sheet;
    sheet.hidden = false;
    sheet.setAttribute("aria-hidden", "false");
    dom.sheetBackdrop.hidden = false;
    document.body.style.overflow = "hidden";
    if (sheet === dom.settingsSheet) widgetSource().catch(function () {});
    requestAnimationFrame(function () {
      sheet.classList.add("is-open");
      var focusTarget = sheet.querySelector(".sheet-body input, .sheet-body button") || sheet;
      if (focusTarget) {
        try { focusTarget.focus({ preventScroll: true }); } catch (err) { focusTarget.focus(); }
      }
    });
  }

  function closeSheet(sheet) {
    if (!sheet) return;
    sheet.classList.remove("is-open");
    sheet.setAttribute("aria-hidden", "true");
    setTimeout(function () {
      if (!sheet.classList.contains("is-open")) sheet.hidden = true;
      if (!state.openSheet || state.openSheet === sheet || state.openSheet.hidden) {
        state.openSheet = null;
        dom.sheetBackdrop.hidden = true;
        document.body.style.overflow = "";
        if (state.lastFocus && typeof state.lastFocus.focus === "function") {
          try { state.lastFocus.focus({ preventScroll: true }); } catch (err) { state.lastFocus.focus(); }
        }
      }
    }, 350);
  }

  function closeAllSheets() {
    [dom.locationSheet, dom.settingsSheet, dom.detailSheet].forEach(function (sheet) {
      if (sheet && !sheet.hidden) closeSheet(sheet);
    });
    state.openSheet = null;
    dom.sheetBackdrop.hidden = true;
    document.body.style.overflow = "";
  }

  function showOnboarding() {
    dom.onboarding.hidden = false;
    document.body.style.overflow = "hidden";
  }

  function hideOnboarding() {
    dom.onboarding.hidden = true;
    document.body.style.overflow = "";
    state.settings.onboardingDone = true;
    saveSettings();
  }

  // ---------------------------------------------------------------------------
  // Notifications
  // ---------------------------------------------------------------------------

  function currentTopic() {
    return (dom.ntfyTopic.value || "").trim();
  }

  function validTopic(topic) {
    return /^[A-Za-z0-9_-]{3,64}$/.test(topic);
  }

  function saveTopic() {
    state.settings.ntfyTopic = currentTopic();
    saveSettings();
  }

  async function sendTestNotification() {
    var topic = currentTopic();
    if (!topic) {
      showToast("Add your ntfy topic first.");
      dom.ntfyTopic.focus();
      return;
    }
    if (!validTopic(topic)) {
      showToast("Use 3–64 letters, numbers, dashes or underscores.");
      dom.ntfyTopic.focus();
      return;
    }
    saveTopic();
    dom.testNotifyBtn.disabled = true;
    dom.testNotifyBtn.textContent = "Sending…";
    try {
      var response = await fetch("https://ntfy.sh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          topic: topic,
          title: "Above the Clouds test",
          message:
            "Alerts are working. " +
            (state.location ? state.location.name : "Above the Clouds") +
            " says hi. You'll get a push when a good window is coming.",
          tags: ["sunrise", "mountain"],
          priority: 3
        })
      });
      if (!response.ok) throw new Error("HTTP " + response.status);
      showToast("Test alert sent. Check your phone.");
    } catch (err) {
      showToast("Couldn't send the test. Check the topic and your connection.");
    } finally {
      dom.testNotifyBtn.disabled = false;
      dom.testNotifyBtn.textContent = "Send test alert";
    }
  }

  function copyTopic() {
    var topic = currentTopic();
    if (!topic) {
      showToast("Add your ntfy topic first.");
      return;
    }
    saveTopic();
    copyText(topic).then(function () {
      showToast("Topic copied.");
    }).catch(function () {
      showToast("Copy failed.");
    });
  }

  function generateTopic() {
    var alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
    var bytes = new Uint8Array(12);
    if (window.crypto && window.crypto.getRandomValues) {
      window.crypto.getRandomValues(bytes);
    } else {
      for (var i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    }
    var raw = "";
    for (var j = 0; j < bytes.length; j++) raw += alphabet.charAt(bytes[j] % alphabet.length);
    var topic = "atc-" + raw.slice(0, 4) + "-" + raw.slice(4, 8) + "-" + raw.slice(8, 12);
    dom.ntfyTopic.value = topic;
    saveTopic();
    showToast("Private topic created. Copy it into ntfy and your GitHub secret.");
  }

  function widgetAppUrl() {
    try {
      return new URL("./", window.location.href).href.replace(/\/+$/, "");
    } catch (err) {
      return "";
    }
  }

  function widgetSource() {
    if (!state.widgetSourcePromise) {
      state.widgetSourcePromise = fetch("./widget/CloudInversionWidget.js", { cache: "no-cache" })
        .then(function (response) {
          if (!response.ok) throw new Error("HTTP " + response.status);
          return response.text();
        })
        .then(function (source) {
          // Bake in this deployment's URL so the pasted script can open the
          // right peak without any hand editing.
          state.widgetSourceText = source.replace(
            /^const APP_URL = "[^"]*";/m,
            "const APP_URL = " + JSON.stringify(widgetAppUrl()) + ";"
          );
          return state.widgetSourceText;
        })
        .catch(function (err) {
          state.widgetSourcePromise = null;
          throw err;
        });
    }
    return state.widgetSourcePromise;
  }

  function copyWidgetScript() {
    if (!dom.copyWidgetBtn) return;
    var button = dom.copyWidgetBtn;
    var label = button.textContent;
    button.disabled = true;
    button.textContent = "Preparing…";
    var source = state.widgetSourceText ? Promise.resolve(state.widgetSourceText) : widgetSource();
    source
      .then(function (text) { return copyText(text); })
      .then(function () {
        showToast("Widget script copied. Paste it into a new Scriptable script.");
      })
      .catch(function () {
        showToast("Couldn't copy the widget script. Open the raw file and set APP_URL by hand.");
      })
      .then(function () {
        button.disabled = false;
        button.textContent = label;
      });
  }

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------

  function bindEvents() {
    dom.refreshBtn.addEventListener("click", function () { refreshAll({ toast: true }); });
    dom.timelineRefreshBtn.addEventListener("click", function () { refreshAll({ toast: true }); });
    dom.settingsBtn.addEventListener("click", function () { openSheet(dom.settingsSheet); });
    dom.alertBtn.addEventListener("click", function () {
      openSheet(dom.settingsSheet);
      setTimeout(function () { dom.ntfyTopic.focus(); }, 420);
    });

    dom.locationBtn.addEventListener("click", function () {
      renderLocationList(dom.locationSearch.value);
      renderLocationStatus();
      openSheet(dom.locationSheet);
    });
    dom.settingsLocationBtn.addEventListener("click", function () {
      closeSheet(dom.settingsSheet);
      renderLocationList("");
      renderLocationStatus();
      setTimeout(function () { openSheet(dom.locationSheet); }, 380);
    });
    dom.locationSort.addEventListener("click", function (event) {
      var button = event.target.closest("button[data-sort]");
      if (!button) return;
      state.settings.locationSort = button.dataset.sort === "region" ? "region" : "best";
      saveSettings();
      renderLocationList(dom.locationSearch.value);
    });

    dom.sheetBackdrop.addEventListener("click", closeAllSheets);
    document.querySelectorAll(".sheet-close").forEach(function (button) {
      button.addEventListener("click", function () {
        var sheet = button.closest(".sheet");
        if (sheet) closeSheet(sheet);
      });
    });

    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape") {
        if (!dom.onboarding.hidden) {
          hideOnboarding();
        } else if (state.openSheet) {
          closeSheet(state.openSheet);
        }
      }
    });

    dom.locationSearch.addEventListener("input", function () {
      renderLocationList(dom.locationSearch.value);
    });
    dom.locationList.addEventListener("click", function (event) {
      var item = event.target.closest(".location-item");
      if (item) selectLocation(item.dataset.id);
    });
    dom.useLocationBtn.addEventListener("click", useMyLocation);

    dom.timeline.addEventListener("click", function (event) {
      var item = event.target.closest(".tl-hour");
      if (!item) return;
      var index = Number(item.dataset.index);
      openDetail(state.timelineHours[index]);
    });

    dom.outlook.addEventListener("click", function (event) {
      var row = event.target.closest(".outlook-row");
      if (!row || !state.forecast) return;
      var ts = Number(row.dataset.ts);
      var hour = state.forecast.hours.find(function (h) { return h.ts === ts; });
      openDetail(hour);
    });

    dom.ntfyTopic.addEventListener("input", saveTopic);
    dom.ntfyTopic.addEventListener("blur", function () {
      dom.ntfyTopic.value = currentTopic();
      saveTopic();
    });
    dom.copyTopicBtn.addEventListener("click", copyTopic);
    dom.generateTopicBtn.addEventListener("click", generateTopic);
    dom.testNotifyBtn.addEventListener("click", sendTestNotification);
    if (dom.copyWidgetBtn) dom.copyWidgetBtn.addEventListener("click", copyWidgetScript);
    dom.replayOnboardingBtn.addEventListener("click", function () {
      closeSheet(dom.settingsSheet);
      setTimeout(showOnboarding, 380);
    });

    dom.onboardingStartBtn.addEventListener("click", hideOnboarding);
    dom.onboardingSettingsBtn.addEventListener("click", function () {
      hideOnboarding();
      openSheet(dom.settingsSheet);
    });

    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible" && state.lastUpdated && Date.now() - state.lastUpdated > 10 * 60 * 1000) {
        refreshAll({ silent: true });
      }
    });

    window.addEventListener("online", function () {
      if (state.error) refreshAll({ silent: true });
      else if (!state.summarySavedAt || state.summaryError) loadBaySummaries();
    });
  }

  function startTimers() {
    setInterval(function () {
      renderUpdated();
      if (state.forecast) renderWindowCard();
    }, 30 * 1000);

    setInterval(function () {
      if (document.visibilityState === "visible" && state.location) {
        refreshAll({ silent: true });
      }
    }, REFRESH_MS);
  }

  function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) return;
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("./sw.js", { updateViaCache: "none" }).catch(function () {
        // Service workers need HTTPS or localhost; the app still works without one.
      });
    });
  }
})();
