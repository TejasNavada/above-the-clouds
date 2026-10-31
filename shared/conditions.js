/*
 * Above the Clouds — forecast scoring engine
 * ------------------------------------------
 * Works in the browser, Node, and Scriptable. No dependencies.
 *
 * The score is built from two points for each hike:
 *   - peak:   conditions at the summit (is it clear up there?)
 *   - valley: conditions in the nearby lowland (is there a cloud deck below?)
 *
 * A good "sea of clouds" morning needs:
 *   1. a low cloud/fog deck in the valley,
 *   2. clear air at the summit (you are above the deck),
 *   3. no mid/high cloud ceiling blocking the view,
 *   4. light wind,
 *   5. morning timing (inversions burn off later),
 *   6. ideally a temperature inversion (warmer at the peak than a normal lapse rate).
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.CloudInversion = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var VERSION = "1.0.0";
  var HOUR = 3600;
  var DEFAULT_TIMEZONE = "America/Los_Angeles";
  var DEFAULT_THRESHOLD = 70;
  var DEFAULT_MAYBE_THRESHOLD = 50;

  var clamp = function (v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
  };

  var num = function (v) {
    return typeof v === "number" && isFinite(v) ? v : null;
  };

  var norm = function (v, lo, hi) {
    if (v == null) return null;
    if (hi === lo) return v >= hi ? 1 : 0;
    return clamp((v - lo) / (hi - lo), 0, 1);
  };

  var round = function (v, digits) {
    if (v == null) return null;
    var p = Math.pow(10, digits || 0);
    return Math.round(v * p) / p;
  };

  var weighted = function (parts) {
    var sum = 0;
    var weight = 0;
    for (var i = 0; i < parts.length; i++) {
      var value = parts[i][0];
      var w = parts[i][1];
      if (value == null) continue;
      sum += value * w;
      weight += w;
    }
    return weight ? sum / weight : 0.5;
  };

  function unitIsFeet(unit) {
    return /(^|\b)(ft|feet|foot)(\b|$)/i.test(String(unit || ""));
  }

  function unitIsMiles(unit) {
    return /(^|\b)(mi|mile|miles)(\b|$)/i.test(String(unit || ""));
  }

  function toFeet(value, unit) {
    var v = num(value);
    if (v == null) return null;
    if (unitIsFeet(unit)) return v;
    if (unitIsMiles(unit)) return v * 5280;
    return v * 3.280839895; // metres
  }

  function toMiles(value, unit) {
    var v = num(value);
    if (v == null) return null;
    if (unitIsMiles(unit)) return v;
    if (unitIsFeet(unit)) return v / 5280;
    return v / 1609.344; // metres
  }

  // ---------------------------------------------------------------------------
  // Time-zone helpers. Open-Meteo is asked for unixtime so DST transitions are
  // handled correctly by Intl rather than by a fixed UTC offset.
  // ---------------------------------------------------------------------------

  var formatterCache = Object.create(null);
  var WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  function pad2(value) {
    return value < 10 ? "0" + value : String(value);
  }

  // JavaScriptCore in some embedded runtimes does not ship a full Intl
  // implementation. The app only needs Pacific time, so keep a small,
  // DST-aware fallback instead of silently switching to UTC.
  function utcSunday(year, monthIndex, nth) {
    var first = new Date(Date.UTC(year, monthIndex, 1));
    var day = 1 + ((7 - first.getUTCDay()) % 7) + (nth - 1) * 7;
    return Date.UTC(year, monthIndex, day);
  }

  function pacificOffsetHours(ts) {
    var date = new Date(ts * 1000);
    var year = date.getUTCFullYear();
    var starts = utcSunday(year, 2, 2) + 10 * 3600 * 1000; // 2 AM PST
    var ends = utcSunday(year, 10, 1) + 9 * 3600 * 1000; // 2 AM PDT
    var ms = ts * 1000;
    return ms >= starts && ms < ends ? -7 : -8;
  }

  function fallbackParts(ts, timeZone) {
    var tz = String(timeZone || "");
    var offset = /Los_Angeles|Pacific/i.test(tz) ? pacificOffsetHours(ts) : 0;
    var date = new Date((ts + offset * 3600) * 1000);
    var year = date.getUTCFullYear();
    var month = date.getUTCMonth() + 1;
    var day = date.getUTCDate();
    return {
      year: year,
      month: month,
      day: day,
      hour: date.getUTCHours(),
      minute: date.getUTCMinutes(),
      date: year + "-" + pad2(month) + "-" + pad2(day)
    };
  }

  function formatter(timeZone, options) {
    var key = timeZone + "|" + JSON.stringify(options);
    if (!formatterCache[key]) {
      formatterCache[key] = new Intl.DateTimeFormat("en-US", Object.assign({ timeZone: timeZone }, options));
    }
    return formatterCache[key];
  }

  function zonedParts(ts, timeZone) {
    var tz = timeZone || DEFAULT_TIMEZONE;
    try {
      var parts = formatter(tz, {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23"
      }).formatToParts(new Date(ts * 1000));
      var out = {};
      for (var i = 0; i < parts.length; i++) out[parts[i].type] = parts[i].value;
      var hour = parseInt(out.hour, 10);
      if (hour === 24) hour = 0;
      return {
        year: parseInt(out.year, 10),
        month: parseInt(out.month, 10),
        day: parseInt(out.day, 10),
        hour: hour,
        minute: parseInt(out.minute, 10),
        date: out.year + "-" + out.month + "-" + out.day
      };
    } catch (e) {
      // Scriptable and very old WebKit builds may not ship a complete Intl.
      return fallbackParts(ts, tz);
    }
  }

  function localDate(ts, timeZone) {
    return zonedParts(ts, timeZone).date;
  }

  function localHour(ts, timeZone) {
    return zonedParts(ts, timeZone).hour;
  }

  function dateToUtcMs(dateString) {
    var p = String(dateString).split("-").map(Number);
    return Date.UTC(p[0], p[1] - 1, p[2], 12, 0, 0);
  }

  function addDays(dateString, days) {
    var d = new Date(dateToUtcMs(dateString) + days * 86400000);
    return d.toISOString().slice(0, 10);
  }

  function fallbackDateLabel(dateString) {
    var p = String(dateString).split("-").map(Number);
    var day = new Date(Date.UTC(p[0], p[1] - 1, p[2], 12));
    return WEEKDAYS[day.getUTCDay()] + ", " + MONTHS[p[1] - 1] + " " + p[2];
  }

  function formatTime(ts, timeZone, withMinutes) {
    var tz = timeZone || DEFAULT_TIMEZONE;
    try {
      var label = formatter(tz, {
        hour: "numeric",
        minute: withMinutes ? "2-digit" : undefined,
        hour12: true
      }).format(new Date(ts * 1000));
      // "6:00 AM" -> "6 AM" when the minutes are on the hour.
      if (!withMinutes) return label;
      return label.replace(":00", "");
    } catch (e) {
      var parts = fallbackParts(ts, tz);
      var hour = parts.hour % 12;
      if (hour === 0) hour = 12;
      var suffix = parts.hour < 12 ? "AM" : "PM";
      if (!withMinutes || parts.minute === 0) return hour + " " + suffix;
      return hour + ":" + pad2(parts.minute) + " " + suffix;
    }
  }

  function formatDayLabel(ts, timeZone, nowTs) {
    var tz = timeZone || DEFAULT_TIMEZONE;
    var date = localDate(ts, tz);
    var today = localDate(nowTs || Math.floor(Date.now() / 1000), tz);
    if (date === today) return "Today";
    if (date === addDays(today, 1)) return "Tomorrow";
    try {
      return formatter(tz, { weekday: "short", month: "short", day: "numeric" }).format(new Date(ts * 1000));
    } catch (e) {
      return fallbackDateLabel(date);
    }
  }

  function formatWindowLabel(window, timeZone, nowTs) {
    var tz = timeZone || DEFAULT_TIMEZONE;
    var now = nowTs || Math.floor(Date.now() / 1000);
    var startDay = formatDayLabel(window.startTs, tz, now);
    var endDay = formatDayLabel(window.endTs, tz, now);
    var startTime = formatTime(window.startTs, tz, true);
    var endTime = formatTime(window.endTs, tz, true);
    if (now >= window.startTs && now < window.endTs) {
      return "Now – " + endTime;
    }
    if (startDay === endDay) {
      return startDay + " · " + startTime + " – " + endTime;
    }
    return startDay + " " + startTime + " – " + endDay + " " + endTime;
  }

  function formatCountdown(seconds) {
    var s = Math.max(0, Math.round(seconds));
    if (s < 60) return "now";
    if (s < 3600) return Math.round(s / 60) + " min";
    if (s < 86400) {
      var h = Math.round(s / 3600);
      return h + " hr";
    }
    var d = Math.round(s / 86400);
    return d + " day" + (d === 1 ? "" : "s");
  }

  // ---------------------------------------------------------------------------
  // Data extraction
  // ---------------------------------------------------------------------------

  function seriesValue(series, key, index) {
    if (!series || !series[key]) return null;
    return num(series[key][index]);
  }

  function units(series) {
    return (series && series.hourly_units) || {};
  }

  function buildHour(peakSeries, valleySeries, index, timeZone, sunriseByDate, context) {
    var ts = peakSeries.hourly.time[index];
    var parts = zonedParts(ts, timeZone);
    var date = parts.date;
    var peakUnits = units(peakSeries);
    var valleyUnits = units(valleySeries);
    var valleyIndex = context.valleyIndexByTs[ts];
    if (valleyIndex == null) valleyIndex = index;

    var peak = {
      tempF: seriesValue(peakSeries.hourly, "temperature_2m", index),
      rh: seriesValue(peakSeries.hourly, "relative_humidity_2m", index),
      dewF: seriesValue(peakSeries.hourly, "dew_point_2m", index),
      low: seriesValue(peakSeries.hourly, "cloud_cover_low", index),
      mid: seriesValue(peakSeries.hourly, "cloud_cover_mid", index),
      high: seriesValue(peakSeries.hourly, "cloud_cover_high", index),
      cloud: seriesValue(peakSeries.hourly, "cloud_cover", index),
      visMi: toMiles(seriesValue(peakSeries.hourly, "visibility", index), peakUnits.visibility),
      windMph: seriesValue(peakSeries.hourly, "wind_speed_10m", index),
      gustMph: seriesValue(peakSeries.hourly, "wind_gusts_10m", index),
      wind80Mph: seriesValue(peakSeries.hourly, "wind_speed_80m", index),
      precipIn: seriesValue(peakSeries.hourly, "precipitation", index),
      blhFt: toFeet(seriesValue(peakSeries.hourly, "boundary_layer_height", index), peakUnits.boundary_layer_height),
      pressureHpa: seriesValue(peakSeries.hourly, "surface_pressure", index)
    };

    var valley = {
      tempF: seriesValue(valleySeries.hourly, "temperature_2m", valleyIndex),
      rh: seriesValue(valleySeries.hourly, "relative_humidity_2m", valleyIndex),
      dewF: seriesValue(valleySeries.hourly, "dew_point_2m", valleyIndex),
      low: seriesValue(valleySeries.hourly, "cloud_cover_low", valleyIndex),
      mid: seriesValue(valleySeries.hourly, "cloud_cover_mid", valleyIndex),
      high: seriesValue(valleySeries.hourly, "cloud_cover_high", valleyIndex),
      cloud: seriesValue(valleySeries.hourly, "cloud_cover", valleyIndex),
      visMi: toMiles(seriesValue(valleySeries.hourly, "visibility", valleyIndex), valleyUnits.visibility),
      windMph: seriesValue(valleySeries.hourly, "wind_speed_10m", valleyIndex),
      gustMph: seriesValue(valleySeries.hourly, "wind_gusts_10m", valleyIndex),
      precipIn: seriesValue(valleySeries.hourly, "precipitation", valleyIndex),
      blhFt: toFeet(seriesValue(valleySeries.hourly, "boundary_layer_height", valleyIndex), valleyUnits.boundary_layer_height)
    };

    // Rain over the current and previous two hours makes the trail muddy and
    // usually means the deck is thick. We keep the signal simple and explicit.
    var precip3h = 0;
    var havePrecip = false;
    for (var k = Math.max(0, index - 2); k <= index; k++) {
      var p = seriesValue(peakSeries.hourly, "precipitation", k);
      var v = seriesValue(valleySeries.hourly, "precipitation", context.valleyIndexByTs[peakSeries.hourly.time[k]]);
      if (p != null) { precip3h += p; havePrecip = true; }
      if (v != null) { precip3h += v; havePrecip = true; }
    }

    var sunriseTs = sunriseByDate[date] || null;

    var valleyCloud = weighted([
      [norm(valley.low, 25, 85), 0.50],
      [norm(valley.rh, 80, 98), 0.20],
      [valley.visMi == null ? null : 1 - norm(valley.visMi, 2, 12), 0.30]
    ]);

    var peakClear = weighted([
      [peak.low == null ? null : 1 - norm(peak.low, 10, 65), 0.40],
      [peak.rh == null ? null : 1 - norm(peak.rh, 70, 92), 0.30],
      [peak.visMi == null ? null : norm(peak.visMi, 5, 15), 0.30]
    ]);

    var aboveCloud = null;
    if (peak.mid != null || peak.high != null) {
      var mid = peak.mid == null ? 0 : peak.mid;
      var high = peak.high == null ? 0 : peak.high;
      aboveCloud = Math.max(mid, high) + 0.25 * Math.min(mid, high);
      aboveCloud = clamp(aboveCloud, 0, 100);
    }
    var skyClear = aboveCloud == null ? 0.6 : 1 - norm(aboveCloud, 20, 80);

    var effectiveWind = Math.max(peak.windMph == null ? 0 : peak.windMph, (peak.gustMph == null ? 0 : peak.gustMph) * 0.7);
    var calm = 1 - norm(effectiveWind, 5, 25);

    var morning;
    if (sunriseTs != null) {
      var sinceSunrise = ts - sunriseTs;
      if (sinceSunrise >= -90 * 60 && sinceSunrise <= 3.5 * HOUR) morning = 1;
      else if (sinceSunrise > 3.5 * HOUR && sinceSunrise <= 5 * HOUR) morning = 0.6;
      else if (sinceSunrise < -90 * 60) morning = 0.35;
      else morning = 0.2;
    } else {
      var h = parts.hour;
      morning = h >= 5 && h <= 10 ? 1 : h > 10 && h <= 12 ? 0.6 : h < 5 ? 0.35 : 0.2;
    }

    // Compare the peak/valley temperature difference with the normal lapse rate
    // (~3.5°F per 1,000 ft). A positive anomaly means the air aloft is warmer
    // than it should be — the "lid" that traps the marine layer.
    var peakElev = context.peakElevationFt;
    var valleyElev = context.valleyElevationFt;
    var expectedDelta = -3.5 * ((peakElev - valleyElev) / 1000);
    var inversion = null;
    if (peak.tempF != null && valley.tempF != null) {
      var anomaly = (peak.tempF - valley.tempF) - expectedDelta;
      inversion = norm(anomaly, 0, 8);
    }

    var dry = 1;
    if (havePrecip) {
      if (precip3h >= 0.02) dry = 0;
      else if (precip3h > 0.001) dry = 0.5;
    }

    var peakInCloud =
      (peak.visMi != null && peak.visMi < 2.5) ||
      (peak.rh != null && peak.rh >= 96 && peak.low != null && peak.low >= 80 && (peak.visMi == null || peak.visMi < 6));

    var cloudState;
    if (peakInCloud && valleyCloud >= 0.35) cloudState = "at";
    else if (valleyCloud >= 0.45 && peakClear >= 0.5) cloudState = "below";
    else if (valleyCloud >= 0.45 && peakClear < 0.5) cloudState = peakClear < 0.3 ? "at" : "edge";
    else if (valleyCloud < 0.45 && peakClear < 0.5) cloudState = "above";
    else cloudState = "none";

    // Estimate a deck top only when the valley boundary-layer height falls
    // between the valley and the peak. Otherwise it is safer to say "below
    // the summit" than to invent a number.
    var cloudTopFt = null;
    if (valley.blhFt != null && valley.blhFt > valleyElev + 100 && valley.blhFt < peakElev - 50) {
      cloudTopFt = Math.round(valley.blhFt / 100) * 100;
    }

    var rawScore = 100 * (
      0.30 * valleyCloud +
      0.30 * peakClear +
      0.15 * skyClear +
      0.10 * calm +
      0.10 * morning +
      0.05 * (inversion == null ? 0.5 : inversion)
    );
    if (dry === 0) rawScore = 0;
    else if (dry === 0.5) rawScore *= 0.75;

    var cap = 100;
    if (dry < 0.5) cap = Math.min(cap, 35);
    if (cloudState === "at") cap = Math.min(cap, 25);
    else if (cloudState === "none") cap = Math.min(cap, 30);
    else if (cloudState === "above") cap = Math.min(cap, 35);
    else if (cloudState === "edge") cap = Math.min(cap, 50);
    if (skyClear < 0.35) cap = Math.min(cap, 40);
    if (effectiveWind > 20 || (peak.gustMph != null && peak.gustMph > 30)) cap = Math.min(cap, 50);
    if (morning < 0.5) cap = Math.min(cap, 60);
    if (peakClear < 0.4) cap = Math.min(cap, 40);

    var score = Math.round(clamp(Math.min(rawScore, cap), 0, 100));

    var threshold = context.threshold;
    var maybeThreshold = context.maybeThreshold;
    var code;
    var label;
    var reason;

    if (dry < 0.5) {
      code = "RAIN";
      label = "NO";
      reason = "Rain is in the forecast. The trail will be wet and the view is unlikely to cooperate.";
    } else if (cloudState === "at") {
      code = "IN_CLOUD";
      label = "NO";
      reason = "The cloud deck is at your elevation — you'd be hiking in the fog, not above it.";
    } else if (cloudState === "none") {
      code = "NO_DECK";
      label = "NO";
      reason = "There is no low cloud deck below the peak, so there is no sea of clouds to stand above.";
    } else if (skyClear < 0.35) {
      code = "CLOUDY_ABOVE";
      label = "NO";
      reason = "A mid- or high-cloud ceiling will block the view above the summit.";
    } else if (cloudState === "above") {
      code = "CLOUDS_ABOVE";
      label = "NO";
      reason = "Clouds are sitting at or above the summit rather than below it.";
    } else if (peakClear < 0.4) {
      code = "SUMMIT_NOT_CLEAR";
      label = "NO";
      reason = "The summit itself does not look clear yet.";
    } else if (effectiveWind > 20 || (peak.gustMph != null && peak.gustMph > 30)) {
      code = "WINDY";
      label = "NO";
      reason = "The wind is strong enough to mix out the inversion and break up the deck.";
    } else if (morning < 0.5) {
      if ((sunriseTs != null && ts < sunriseTs - 90 * 60) || parts.hour < 5) {
        code = "NIGHT";
        label = "MAYBE";
        reason = "Before sunrise — the deck may still be forming. The best window is around sunrise.";
      } else {
        code = "LATE";
        label = "MAYBE";
        reason = "The morning window has mostly passed. Inversions usually burn off by mid-day.";
      }
    } else if (score >= threshold) {
      code = "GOOD";
      label = "GO";
      reason = "A low deck below the summit, clear sky above, and light wind.";
    } else if (score >= maybeThreshold) {
      code = "MAYBE";
      label = "MAYBE";
      reason = "Borderline — one of the ingredients is marginal. Worth a look, but don't bet the morning on it.";
    } else {
      code = "NO";
      label = "NO";
      reason = "The ingredients do not line up for a sea-of-clouds morning.";
    }

    return {
      ts: ts,
      date: date,
      hour: parts.hour,
      timeLabel: formatTime(ts, timeZone, true),
      timeZone: timeZone,
      sunriseTs: sunriseTs,
      peak: peak,
      valley: valley,
      precip3h: round(precip3h, 3),
      metrics: {
        valleyCloud: round(valleyCloud, 3),
        peakClear: round(peakClear, 3),
        skyClear: round(skyClear, 3),
        calm: round(calm, 3),
        morning: round(morning, 3),
        inversion: inversion == null ? null : round(inversion, 3),
        dry: dry,
        rawScore: Math.round(rawScore),
        cap: cap,
        score: score
      },
      effectiveWindMph: round(effectiveWind, 1),
      score: score,
      cloudState: cloudState,
      cloudTopFt: cloudTopFt,
      peakInCloud: peakInCloud,
      verdict: {
        code: code,
        label: label,
        reason: reason
      }
    };
  }

  function findWindows(hours, options) {
    options = options || {};
    var minScore = options.minScore == null ? DEFAULT_THRESHOLD : options.minScore;
    var minLength = options.minLength == null ? 2 : options.minLength;
    var gapTolerance = options.gapTolerance == null ? 1 : options.gapTolerance;
    var timeZone = options.timeZone || (hours[0] && hours[0].timeZone) || DEFAULT_TIMEZONE;
    var now = options.now == null ? Math.floor(Date.now() / 1000) : options.now;

    var runs = [];
    var run = null;
    for (var i = 0; i < hours.length; i++) {
      var h = hours[i];
      var good = h.score >= minScore && h.verdict.code === "GOOD";
      if (good) {
        if (!run) run = { startIndex: i, endIndex: i, hours: [h] };
        else {
          run.endIndex = i;
          run.hours.push(h);
        }
      } else if (run) {
        runs.push(run);
        run = null;
      }
    }
    if (run) runs.push(run);

    var merged = [];
    for (var r = 0; r < runs.length; r++) {
      var current = runs[r];
      var last = merged[merged.length - 1];
      if (last) {
        var gap = hours.slice(last.endIndex + 1, current.startIndex);
        if (gap.length <= gapTolerance && gap.every(function (g) { return g.score >= DEFAULT_MAYBE_THRESHOLD; })) {
          last.endIndex = current.endIndex;
          last.hours = last.hours.concat(gap, current.hours);
          continue;
        }
      }
      merged.push({ startIndex: current.startIndex, endIndex: current.endIndex, hours: current.hours.slice() });
    }

    var windows = [];
    for (var m = 0; m < merged.length; m++) {
      var item = merged[m];
      if (item.hours.length < minLength) continue;
      var start = hours[item.startIndex];
      var end = hours[item.endIndex];
      var best = item.hours.reduce(function (a, b) { return b.score > a.score ? b : a; }, item.hours[0]);
      var window = {
        startTs: start.ts,
        endTs: end.ts + HOUR,
        startIndex: item.startIndex,
        endIndex: item.endIndex,
        hours: item.hours,
        score: best.score,
        avgScore: Math.round(item.hours.reduce(function (s, h) { return s + h.score; }, 0) / item.hours.length),
        verdict: best.verdict,
        date: start.date,
        timeZone: timeZone
      };
      window.label = formatWindowLabel(window, timeZone, now);
      windows.push(window);
    }
    return windows;
  }

  function evaluateForecast(input) {
    if (!input || !input.peak || !input.valley) throw new Error("evaluateForecast needs peak and valley weather series");
    var peakSeries = input.peak;
    var valleySeries = input.valley;
    if (!peakSeries.hourly || !peakSeries.hourly.time) throw new Error("Peak weather series has no hourly data");
    if (!valleySeries.hourly || !valleySeries.hourly.time) throw new Error("Valley weather series has no hourly data");

    var location = input.location || {};
    var timeZone = input.timezone || peakSeries.timezone || DEFAULT_TIMEZONE;
    var now = input.now == null ? Math.floor(Date.now() / 1000) : input.now;
    if (now instanceof Date) now = Math.floor(now.getTime() / 1000);
    if (now > 1e12) now = Math.floor(now / 1000); // tolerate milliseconds

    var threshold = input.threshold == null ? DEFAULT_THRESHOLD : input.threshold;
    var maybeThreshold = input.maybeThreshold == null ? Math.min(DEFAULT_MAYBE_THRESHOLD, threshold - 10) : input.maybeThreshold;

    var valleyIndexByTs = Object.create(null);
    for (var vi = 0; vi < valleySeries.hourly.time.length; vi++) {
      valleyIndexByTs[valleySeries.hourly.time[vi]] = vi;
    }

    var sunriseByDate = Object.create(null);
    if (peakSeries.daily && peakSeries.daily.time && peakSeries.daily.sunrise) {
      for (var di = 0; di < peakSeries.daily.time.length; di++) {
        var sunrise = num(peakSeries.daily.sunrise[di]);
        if (sunrise == null) continue;
        sunriseByDate[localDate(sunrise, timeZone)] = sunrise;
      }
    }

    var peakElevationFt = location.peak && location.peak.elevationFt != null
      ? location.peak.elevationFt
      : (peakSeries.elevation != null ? Math.round(peakSeries.elevation * 3.280839895) : 1900);
    var valleyElevationFt = location.valley && location.valley.elevationFt != null
      ? location.valley.elevationFt
      : 100;

    var context = {
      valleyIndexByTs: valleyIndexByTs,
      peakElevationFt: peakElevationFt,
      valleyElevationFt: valleyElevationFt,
      threshold: threshold,
      maybeThreshold: maybeThreshold
    };

    var hours = [];
    for (var i = 0; i < peakSeries.hourly.time.length; i++) {
      hours.push(buildHour(peakSeries, valleySeries, i, timeZone, sunriseByDate, context));
    }

    var currentIndex = 0;
    for (var j = 0; j < hours.length; j++) {
      if (hours[j].ts <= now) currentIndex = j;
      else break;
    }
    var current = hours[currentIndex];

    var windows = findWindows(hours, {
      minScore: threshold,
      minLength: 2,
      gapTolerance: 1,
      timeZone: timeZone,
      now: now
    });

    var nextWindow = null;
    for (var w = 0; w < windows.length; w++) {
      if (windows[w].endTs > now) {
        nextWindow = windows[w];
        break;
      }
    }

    var upcomingWindows = windows.filter(function (win) { return win.startTs > now; });
    var currentWindow = windows.find(function (win) { return now >= win.startTs && now < win.endTs; }) || null;

    var horizon = hours.filter(function (h) { return h.ts >= now && h.ts <= now + 48 * HOUR; });
    var bestHour = horizon.reduce(function (a, b) { return b.score > a.score ? b : a; }, horizon[0] || current);

    var days = [];
    var byDate = Object.create(null);
    for (var k = 0; k < hours.length; k++) {
      if (!byDate[hours[k].date]) byDate[hours[k].date] = [];
      byDate[hours[k].date].push(hours[k]);
    }
    var todayDate = localDate(now, timeZone);
    Object.keys(byDate).filter(function (date) { return date >= todayDate; }).forEach(function (date) {
      var dayHours = byDate[date];
      var dayWindows = findWindows(dayHours, {
        minScore: threshold,
        minLength: 2,
        gapTolerance: 1,
        timeZone: timeZone,
        now: now
      });
      var dayBest = dayHours.reduce(function (a, b) { return b.score > a.score ? b : a; }, dayHours[0]);
      days.push({
        date: date,
        label: formatDayLabel(dayHours[0].ts, timeZone, now),
        hours: dayHours,
        windows: dayWindows,
        bestWindow: dayWindows[0] || null,
        bestHour: dayBest,
        sunriseTs: dayHours[0].sunriseTs
      });
    });

    return {
      version: VERSION,
      timezone: timeZone,
      generatedAt: now,
      location: location,
      peakElevationFt: peakElevationFt,
      valleyElevationFt: valleyElevationFt,
      threshold: threshold,
      maybeThreshold: maybeThreshold,
      hours: hours,
      current: current,
      currentWindow: currentWindow,
      nextWindow: nextWindow,
      upcomingWindows: upcomingWindows,
      windows: windows,
      bestHour: bestHour,
      days: days
    };
  }

  // ---------------------------------------------------------------------------
  // Presentation helpers shared by the PWA and the widget
  // ---------------------------------------------------------------------------

  function cloudStateLabel(state) {
    switch (state) {
      case "below": return "Below you";
      case "at": return "At your level";
      case "above": return "Above you";
      case "edge": return "Right at the edge";
      default: return "No deck";
    }
  }

  function cloudStateDetail(hour, peakElevationFt) {
    var elev = peakElevationFt || 1900;
    switch (hour.cloudState) {
      case "below":
        if (hour.cloudTopFt) return "Deck top ~" + hour.cloudTopFt.toLocaleString() + " ft";
        return "Deck top below " + elev.toLocaleString() + " ft";
      case "at":
        return "You'd be inside the cloud layer";
      case "above":
        return "Clouds are sitting above the summit";
      case "edge":
        return "Summit is near the top of the deck";
      default:
        return "No low cloud layer below the peak";
    }
  }

  function verdictTone(code) {
    if (code === "GOOD") return "good";
    if (code === "MAYBE" || code === "LATE" || code === "NIGHT") return "maybe";
    return "no";
  }

  function verdictHeadline(code) {
    switch (code) {
      case "GOOD": return "GO";
      case "MAYBE": return "MAYBE";
      case "LATE": return "MAYBE";
      case "NIGHT": return "MAYBE";
      case "IN_CLOUD": return "FOG";
      case "NO_DECK": return "NO DECK";
      case "CLOUDY_ABOVE": return "CLOUDY";
      case "CLOUDS_ABOVE": return "CLOUDY";
      case "SUMMIT_NOT_CLEAR": return "FOGGED IN";
      case "WINDY": return "WINDY";
      case "RAIN": return "RAIN";
      default: return "NO";
    }
  }

  return {
    version: VERSION,
    evaluateForecast: evaluateForecast,
    findWindows: findWindows,
    formatTime: formatTime,
    formatDayLabel: formatDayLabel,
    formatWindowLabel: formatWindowLabel,
    formatCountdown: formatCountdown,
    cloudStateLabel: cloudStateLabel,
    cloudStateDetail: cloudStateDetail,
    verdictTone: verdictTone,
    verdictHeadline: verdictHeadline,
    toFeet: toFeet,
    toMiles: toMiles
  };
});
