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
export function weatherUrl(profile) {
  const city = CITIES[profile.preferred_city];
  if (!city || !validSettings(profile)) throw new Error("Invalid profile");
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  for (const [k, v] of Object.entries({
    latitude: city.latitude, longitude: city.longitude,
    current: "temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m",
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
  if (profile.response_language === "en-US") return "Your saved city is " + name + ". Open-Meteo reports " + c.temperature_2m + unit + ", humidity " + c.relative_humidity_2m + "% and wind " + c.wind_speed_10m + " km/h.";
  return "Sua cidade preferida é " + name + ". A Open-Meteo informa " + c.temperature_2m + unit + ", umidade " + c.relative_humidity_2m + "% e vento de " + c.wind_speed_10m + " km/h.";
}
