import test from "node:test";
import assert from "node:assert/strict";
import { CITIES, DEFAULT_PROFILE, OPEN_METEO_FORECAST_DAYS, validSettings, weatherUrl, forecastUrl, forecastReach, formatWeather } from "../src/shared.js";

test("profile validation rejects out-of-scope city",()=>{
  assert.equal(validSettings({...DEFAULT_PROFILE,preferred_city:"http://127.0.0.1"}),false);
  assert.equal(validSettings(DEFAULT_PROFILE),true);
});
test("weather URL only contains allowlisted city coordinates",()=>{
  const url=weatherUrl(DEFAULT_PROFILE);
  assert.equal(url.origin,"https://api.open-meteo.com");
  assert.equal(url.searchParams.get("latitude"),String(CITIES.vitoria.latitude));
  assert.equal(url.searchParams.get("forecast_days"),"2");
});
test("forecast horizon keeps today inside and day 16 outside",()=>{
  assert.equal(forecastReach("2026-11-10","2026-11-10").status,"ok");
  assert.equal(forecastReach("2026-11-10","2026-11-25").status,"ok");
  assert.equal(forecastReach("2026-11-10","2026-11-25").offset,OPEN_METEO_FORECAST_DAYS - 1);
  assert.equal(forecastReach("2026-11-10","2026-11-26").status,"beyond");
  assert.equal(forecastReach("2026-11-10","2026-11-09").status,"past");
  const forecast=forecastUrl(DEFAULT_PROFILE, OPEN_METEO_FORECAST_DAYS);
  assert.equal(forecast.origin,"https://api.open-meteo.com");
  assert.equal(forecast.searchParams.get("forecast_days"),"16");
  assert.equal(forecast.searchParams.get("latitude"),String(CITIES.vitoria.latitude));
});
test("weather answer uses language and saved unit",()=>{
  const weather={current:{temperature_2m:26,relative_humidity_2m:75,wind_speed_10m:13}};
  assert.match(formatWeather(DEFAULT_PROFILE,weather),/Vitória, ES/);
  assert.match(formatWeather({...DEFAULT_PROFILE, response_language:"en-US",temperature_unit:"fahrenheit"},weather),/26°F/);
});
test("reject malformed weather response",()=>{
  assert.throws(()=>formatWeather(DEFAULT_PROFILE,{current:{}}),/Unexpected/);
});
