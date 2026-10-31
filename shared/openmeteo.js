/*
 * Above the Clouds — Open-Meteo client
 * ------------------------------------
 * Fetches two points in one request:
 *   1. the summit (peak conditions)
 *   2. a nearby lowland town (valley cloud/fog conditions)
 *
 * No API key is required. Works in the browser, Node 18+, and can be used by
 * Scriptable via buildUrl().
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.CloudWeather = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var DEFAULT_TIMEZONE = "America/Los_Angeles";
  var API_BASE = "https://api.open-meteo.com/v1/gfs";

  var HOURLY = [
    "temperature_2m",
    "relative_humidity_2m",
    "dew_point_2m",
    "precipitation",
    "weather_code",
    "cloud_cover",
    "cloud_cover_low",
    "cloud_cover_mid",
    "cloud_cover_high",
    "visibility",
    "wind_speed_10m",
    "wind_gusts_10m",
    "wind_speed_80m",
    "boundary_layer_height",
    "surface_pressure",
    "pressure_msl"
  ];

  var DAILY = ["sunrise", "sunset"];

  function buildUrl(location, options) {
    options = options || {};
    if (!location || !location.peak || !location.valley) {
      throw new Error("buildUrl needs a location with peak and valley coordinates");
    }
    var days = options.days == null ? 4 : options.days;
    var timezone = options.timezone || location.timezone || DEFAULT_TIMEZONE;
    var lat = location.peak.lat + "," + location.valley.lat;
    var lon = location.peak.lon + "," + location.valley.lon;
    var params = [
      "latitude=" + encodeURIComponent(lat),
      "longitude=" + encodeURIComponent(lon),
      "hourly=" + encodeURIComponent(HOURLY.join(",")),
      "daily=" + encodeURIComponent(DAILY.join(",")),
      "models=ncep_gfs_seamless",
      "temperature_unit=fahrenheit",
      "wind_speed_unit=mph",
      "precipitation_unit=inch",
      "timezone=" + encodeURIComponent(timezone),
      "timeformat=unixtime",
      // forecast_days isn't honored when past_hours is set, so ask for an
      // explicit number of forecast hours instead.
      "forecast_hours=" + days * 24
    ];
    // A few past hours let the engine look back at recent rain without
    // returning a whole extra day of forecast data.
    if (options.pastHours !== false) params.push("past_hours=" + (options.pastHours || 3));
    return API_BASE + "?" + params.join("&");
  }

  async function fetchForecast(location, options) {
    options = options || {};
    var url = buildUrl(location, options);
    var fetchImpl = options.fetchImpl || (typeof fetch !== "undefined" ? fetch : null);
    if (!fetchImpl) throw new Error("No fetch implementation available");

    var controller = null;
    var timer = null;
    var fetchOptions = {};
    if (typeof AbortController !== "undefined" && options.timeoutMs !== false) {
      controller = new AbortController();
      fetchOptions.signal = controller.signal;
      timer = setTimeout(function () { controller.abort(); }, options.timeoutMs || 20000);
    }
    if (options.headers) fetchOptions.headers = options.headers;

    var response;
    try {
      response = await fetchImpl(url, fetchOptions);
    } finally {
      if (timer) clearTimeout(timer);
    }

    if (!response || !response.ok) {
      var status = response ? response.status : "unknown";
      throw new Error("Weather request failed (HTTP " + status + ")");
    }

    var data = await response.json();
    if (data && data.error) throw new Error(data.reason || "Weather API error");

    var series = Array.isArray(data) ? data : [data];
    if (!series[0] || !series[0].hourly) throw new Error("Weather API returned no hourly data");
    if (!series[1] || !series[1].hourly) throw new Error("Weather API returned only one location");

    return {
      peak: series[0],
      valley: series[1],
      url: url,
      fetchedAt: Math.floor(Date.now() / 1000)
    };
  }

  return {
    API_BASE: API_BASE,
    HOURLY: HOURLY,
    DAILY: DAILY,
    DEFAULT_TIMEZONE: DEFAULT_TIMEZONE,
    buildUrl: buildUrl,
    fetchForecast: fetchForecast
  };
});
