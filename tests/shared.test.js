import test from "node:test";
import assert from "node:assert/strict";
import { CITIES, DEFAULT_PROFILE, validSettings, weatherUrl, formatWeather } from "../src/shared.js";

test("profile validation rejects out-of-scope city",()=>{
  assert.equal(validSettings({...DEFAULT_PROFILE,preferred_city:"http://127.0.0.1"}),false);
  assert.equal(validSettings(DEFAULT_PROFILE),true);
});
test("weather URL only contains allowlisted city coordinates",()=>{
  const url=weatherUrl(DEFAULT_PROFILE);
  assert.equal(url.origin,"https://api.open-meteo.com");
  assert.equal(url.searchParams.get("latitude"),String(CITIES.vitoria.latitude));
});
test("weather answer uses language and saved unit",()=>{
  const weather={current:{temperature_2m:26,relative_humidity_2m:75,wind_speed_10m:13}};
  assert.match(formatWeather(DEFAULT_PROFILE,weather),/Vitória, ES/);
  assert.match(formatWeather({...DEFAULT_PROFILE, response_language:"en-US",temperature_unit:"fahrenheit"},weather),/26°F/);
});
test("reject malformed weather response",()=>{
  assert.throws(()=>formatWeather(DEFAULT_PROFILE,{current:{}}),/Unexpected/);
});
