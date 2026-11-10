// Public constants shared by the Worker and node:test; never derive weather coordinates from user-controlled URLs.
export const CITIES = Object.freeze({
  vitoria: Object.freeze({name: "Vitória, ES", latitude: -20.3155, longitude: -40.3128, timezone: "America/Sao_Paulo"}),
  "sao-paulo": Object.freeze({name: "São Paulo, SP", latitude: -23.5505, longitude: -46.6333, timezone: "America/Sao_Paulo"}),
  lisboa: Object.freeze({name: "Lisboa, Portugal", latitude: 38.7223, longitude: -9.1393, timezone: "Europe/Lisbon"}),
});
export const DEFAULT_PROFILE = Object.freeze({
  preferred_city: "vitoria",
  temperature_unit: "celsius",
  response_language: "pt-BR",
});
export function validSettings(value) {
  return Boolean(value && typeof value === "object" &&
    Object.hasOwn(CITIES, value.preferred_city) &&
    ["celsius", "fahrenheit"].includes(value.temperature_unit) &&
    ["pt-BR", "en-US"].includes(value.response_language));
}
// Open-Meteo accepts forecast_days 1–16 and the first daily entry is today.
export const OPEN_METEO_FORECAST_DAYS = 16;
export function isoDateInTimeZone(date, timeZone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit"
  }).format(date);
}
export function addIsoDays(isoDate, days) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate) || !Number.isInteger(days)) return null;
  const parsed = Date.parse(isoDate + "T00:00:00Z");
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed + days * 86400000).toISOString().slice(0, 10);
}
export function daysBetweenIsoDates(todayIso, targetIso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(todayIso) || !/^\d{4}-\d{2}-\d{2}$/.test(targetIso)) return null;
  const start = Date.parse(todayIso + "T00:00:00Z");
  const end = Date.parse(targetIso + "T00:00:00Z");
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return Math.round((end - start) / 86400000);
}
export function forecastReach(todayIso, targetIso) {
  const offset = daysBetweenIsoDates(todayIso, targetIso);
  if (offset === null) return {offset: null, status: "invalid"};
  if (offset < 0) return {offset, status: "past"};
  if (offset >= OPEN_METEO_FORECAST_DAYS) return {offset, status: "beyond"};
  return {offset, status: "ok"};
}
export function forecastUrl(profile, forecastDays) {
  const city = CITIES[profile.preferred_city];
  if (!city || !validSettings(profile)) throw new Error("Invalid profile");
  const days = Number(forecastDays);
  if (!Number.isInteger(days) || days < 1 || days > OPEN_METEO_FORECAST_DAYS) {
    throw new Error("Invalid forecast window");
  }
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  for (const [k, v] of Object.entries({
    latitude: city.latitude, longitude: city.longitude,
    daily: "temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code",
    forecast_days: days,
    temperature_unit: profile.temperature_unit, timezone: city.timezone
  })) url.searchParams.set(k, String(v));
  return url;
}
export function weatherUrl(profile) {
  const city = CITIES[profile.preferred_city];
  if (!city || !validSettings(profile)) throw new Error("Invalid profile");
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  for (const [k, v] of Object.entries({
    latitude: city.latitude, longitude: city.longitude,
    current: "temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m",
    daily: "temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code",
    forecast_days: 2,
    temperature_unit: profile.temperature_unit, timezone: city.timezone
  })) url.searchParams.set(k, String(v));
  return url;
}
export function formatWeather(profile, weather) {
  const name = CITIES[profile.preferred_city].name;
  const unit = profile.temperature_unit === "fahrenheit" ? "°F" : "°C";
  const c = weather?.current;
  if (typeof c?.temperature_2m !== "number" || typeof c?.relative_humidity_2m !== "number") {
    throw new Error("Unexpected weather response");
  }
  const d = weather?.daily;
  let forecast = "";
  if (d && Array.isArray(d.time) && d.time.length > 1) {
    const max = d.temperature_2m_max?.[1], min = d.temperature_2m_min?.[1], rain = d.precipitation_probability_max?.[1];
    if (typeof max === "number" && typeof min === "number") {
      const rainTxt = typeof rain === "number" ? rain + "%" : null;
      forecast = profile.response_language === "en-US"
        ? " Tomorrow: high " + max + unit + ", low " + min + unit + (rainTxt ? " and " + rainTxt + " chance of rain." : ".")
        : " Amanhã: máxima de " + max + unit + ", mínima de " + min + unit + (rainTxt ? " e " + rainTxt + " de chance de chuva." : ".");
    }
  }
  if (profile.response_language === "en-US") return "Your saved city is " + name + ". Open-Meteo reports " + c.temperature_2m + unit + ", humidity " + c.relative_humidity_2m + "% and wind " + c.wind_speed_10m + " km/h." + forecast;
  return "Sua cidade preferida é " + name + ". A Open-Meteo informa " + c.temperature_2m + unit + ", umidade " + c.relative_humidity_2m + "% e vento de " + c.wind_speed_10m + " km/h." + forecast;
}
