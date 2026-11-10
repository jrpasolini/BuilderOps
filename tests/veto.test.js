import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_PROFILE } from "../src/shared.js";
import {
  CIBA_GRANT, TOKEN_EXCHANGE_GRANT, VETO_SCHEMA, bindingMessage, classifyCalendarCommand,
  isCalendarCommand, pollCalendarApproval, processCalendarTurn, vetoConfig
} from "../src/veto.js";

const profile = {...DEFAULT_PROFILE, city_name: "Vitória, ES"};
const now = new Date("2026-11-10T15:00:00Z");
const sub = "auth0|user-a";
const conversationId = "11111111-1111-4111-8111-111111111111";
const userToken = "user-api-access-token";
const googleToken = "ya29.google-test-token";
const cibaToken = "ciba-approved-token";
const authReqId = "authreq.test.value";
const vaultSecret = "vault-secret-value-123456";
const cibaSecret = "ciba-secret-value-123456";

function createMemoryDb() {
  const db = new DatabaseSync(":memory:");
  return {
    prepare(sql) {
      return {
        bind(...params) {
          return {
            async run() {
              const info = db.prepare(sql).run(...params);
              return {meta: {changes: Number(info.changes || 0)}};
            },
            async first() {
              return db.prepare(sql).get(...params) ?? null;
            },
            async all() {
              return {results: db.prepare(sql).all(...params)};
            }
          };
        }
      };
    },
    dump(sql) {
      return db.prepare(sql).all();
    }
  };
}
function enabledEnv(db, overrides = {}) {
  return {
    DB: db,
    AUTH0_DOMAIN: "tenant.auth0.com",
    AUTH0_VAULT_CLIENT_ID: "vaultclientid12345678901234",
    AUTH0_VAULT_CLIENT_SECRET: vaultSecret,
    AUTH0_CIBA_CLIENT_ID: "cibaclientid123456789012345",
    AUTH0_CIBA_CLIENT_SECRET: cibaSecret,
    AUTH0_CIBA_CHANNEL: "guardian",
    AUTH0_GOOGLE_CONNECTION: "google-oauth2",
    VETO_AGENT: "auto",
    ...overrides
  };
}
function grantType(call) {
  if (call.body.startsWith("{")) return JSON.parse(call.body).grant_type;
  return new URLSearchParams(call.body).get("grant_type");
}
function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {"content-type": "application/json", ...headers}
  });
}
function router(handler) {
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    const url = input instanceof URL ? input.href : String(input);
    const body = init.body instanceof URLSearchParams
      ? init.body.toString()
      : typeof init.body === "string" ? init.body : "";
    const call = {url, method: init.method || "GET", body, headers: init.headers || {}};
    calls.push(call);
    return handler(call, calls);
  };
  return {fetchImpl, calls};
}
function forecastBody() {
  const time = [];
  for (let day = 0; day < 16; day += 1) {
    const date = new Date(Date.parse("2026-11-10T00:00:00Z") + day * 86400000).toISOString().slice(0, 10);
    time.push(date);
  }
  return {
    daily: {
      time,
      temperature_2m_max: time.map((_, index) => 28 + index),
      temperature_2m_min: time.map((_, index) => 20 + index),
      precipitation_probability_max: time.map((_, index) => index === 1 ? 70 : 10)
    }
  };
}
function calendarItems() {
  return [
    {
      id: "evt_primary_1",
      summary: "Reunião",
      status: "confirmed",
      start: {dateTime: "2026-11-12T10:00:00-03:00"},
      end: {dateTime: "2026-11-12T11:00:00-03:00"}
    },
    {
      id: "alldayevt1",
      summary: "Feriado",
      start: {date: "2026-11-13"},
      end: {date: "2026-11-14"}
    },
    {
      id: "evt_later_1",
      summary: "Viagem",
      start: {dateTime: "2026-12-20T09:00:00-03:00"},
      end: {dateTime: "2026-12-20T10:00:00-03:00"}
    },
    {id: "../admin", summary: "Injeção", start: {dateTime: "2026-11-12T12:00:00Z"}, end: {dateTime: "2026-11-12T13:00:00Z"}}
  ];
}
function leaked(value) {
  const text = JSON.stringify(value);
  for (const secret of [googleToken, cibaToken, vaultSecret, cibaSecret, authReqId, userToken]) {
    assert.equal(text.includes(secret), false, secret);
  }
}
async function turn(env, fetchImpl, question, clock = now) {
  return processCalendarTurn({
    env, sub, bearer: userToken, profile, question, conversationId, fetchImpl, now: clock
  });
}

test("the checked-in migration matches the runtime schema", () => {
  const file = fs.readFileSync(new URL("../db/002_veto.sql", import.meta.url), "utf8");
  const compact = value => value.replace(/\s+/g, " ").trim();
  const migration = compact(file);
  for (const statement of VETO_SCHEMA) assert.equal(migration.includes(compact(statement)), true);
  assert.equal(file.toLowerCase().includes("access_token"), false);
});
test("ordinary weather questions stay out of the calendar agent", () => {
  assert.equal(isCalendarCommand("Como está o tempo na minha cidade?"), false);
  assert.equal(classifyCalendarCommand("tempo amanhã em Lisboa"), null);
  assert.equal(classifyCalendarCommand("agenda").type, "list");
  assert.equal(classifyCalendarCommand("criar lembrete de chuva em 2026-11-11").type, "create-rain-alert");
  assert.deepEqual(classifyCalendarCommand("reagendar 2 para 2026-11-20T15:30"), {
    type: "reschedule", index: 2, localStart: "2026-11-20T15:30"
  });
  assert.equal(classifyCalendarCommand("reagendar 9 para 2026-11-20T15:30").type, "invalid");
});
test("binding messages stay inside Auth0's CIBA character set", () => {
  const message = bindingMessage("criar", "Alerta de chuva — Vitória");
  assert.match(message, /^[A-Za-z0-9+\-_.,:#]{1,64}$/);
  assert.ok(message.length <= 64);
});
test("veto stays disabled until every secret is present", () => {
  assert.equal(vetoConfig({AUTH0_DOMAIN: "tenant.auth0.com"}).enabled, false);
  assert.equal(vetoConfig({...enabledEnv(null), AUTH0_DOMAIN: "evil.example"}).enabled, false);
  assert.equal(vetoConfig({...enabledEnv(null), AUTH0_VAULT_CLIENT_SECRET: "short"}).enabled, false);
  assert.equal(vetoConfig({...enabledEnv(null), VETO_AGENT: "off"}).enabled, false);
  const guardian = vetoConfig(enabledEnv(null));
  assert.equal(guardian.enabled, true);
  assert.equal(guardian.requestedExpiry, 300);
  assert.equal(vetoConfig({...enabledEnv(null), AUTH0_CIBA_CHANNEL: "email"}).requestedExpiry, 3600);
});
test("disabled calendar commands do not call Google or Auth0", async () => {
  const db = createMemoryDb();
  const outcome = await turn({DB: db, AUTH0_DOMAIN: "tenant.auth0.com"}, () => {
    throw new Error("network should stay idle");
  }, "agenda");
  assert.equal(outcome.mode, "veto-disabled");
  assert.match(outcome.answer, /não está configurada|not configured/i);
  assert.equal(db.dump("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'calendar%'").length, 0);
});
test("agenda reads Token Vault events and skips dates Open-Meteo cannot forecast", async () => {
  const db = createMemoryDb();
  const {fetchImpl, calls} = router(call => {
    if (call.url === "https://tenant.auth0.com/oauth/token" && call.body.includes(TOKEN_EXCHANGE_GRANT)) {
      const body = JSON.parse(call.body);
      assert.equal(body.subject_token, userToken);
      assert.equal(body.connection, "google-oauth2");
      assert.equal(body.client_secret, vaultSecret);
      return jsonResponse({access_token: googleToken, token_type: "Bearer", expires_in: 300});
    }
    if (call.url.startsWith("https://www.googleapis.com/calendar/v3/calendars/primary/events")) {
      assert.equal(call.headers.authorization, "Bearer " + googleToken);
      assert.equal(call.body.includes(vaultSecret), false);
      return jsonResponse({items: calendarItems()});
    }
    if (call.url.startsWith("https://api.open-meteo.com/v1/forecast")) {
      assert.equal(new URL(call.url).searchParams.get("forecast_days"), "16");
      return jsonResponse(forecastBody());
    }
    throw new Error("unexpected " + call.url);
  });
  const outcome = await turn(enabledEnv(db), fetchImpl, "agenda");
  assert.equal(outcome.mode, "calendar-read");
  assert.match(outcome.answer, /Reunião/);
  assert.match(outcome.answer, /Open-Meteo/);
  assert.match(outcome.answer, /16 dias|16 days/);
  assert.equal(outcome.answer.includes("Injeção"), false);
  leaked(outcome);
  const stored = db.dump("SELECT events_json FROM calendar_snapshots")[0].events_json;
  leaked(stored);
  assert.equal(calls.some(call => call.method === "POST" && call.url.includes("googleapis")), false);
});
test("a rain reminder pauses on CIBA and writes to Google only after approval", async () => {
  const db = createMemoryDb();
  let approved = false;
  const {fetchImpl, calls} = router(call => {
    if (call.url.startsWith("https://api.open-meteo.com/")) return jsonResponse(forecastBody());
    if (call.url === "https://tenant.auth0.com/bc-authorize") {
      const params = new URLSearchParams(call.body);
      assert.equal(params.get("scope"), "openid");
      assert.match(params.get("login_hint"), /iss_sub/);
      assert.match(params.get("login_hint"), /auth0\|user-a/);
      assert.match(params.get("binding_message"), /^[A-Za-z0-9+\-_.,:#]{1,64}$/);
      assert.equal(params.get("requested_expiry"), "300");
      return jsonResponse({auth_req_id: authReqId, expires_in: 300, interval: 5});
    }
    if (call.url === "https://tenant.auth0.com/oauth/token" && grantType(call) === CIBA_GRANT) {
      if (!approved) return jsonResponse({error: "authorization_pending"}, 400);
      return jsonResponse({access_token: cibaToken, id_token: "id-token-should-not-leak", expires_in: 300, token_type: "Bearer"});
    }
    if (call.url === "https://tenant.auth0.com/oauth/token") {
      return jsonResponse({access_token: googleToken, token_type: "Bearer", expires_in: 300});
    }
    if (call.url === "https://www.googleapis.com/calendar/v3/calendars/primary/events" && call.method === "POST") {
      const body = JSON.parse(call.body);
      assert.equal(body.summary, "Alerta de chuva");
      assert.equal(body.start.dateTime, "2026-11-11T08:00:00");
      assert.equal(body.start.timeZone, "America/Sao_Paulo");
      assert.equal(JSON.stringify(body).includes(googleToken), false);
      return jsonResponse({id: "created_evt_1"});
    }
    throw new Error("unexpected " + call.method + " " + call.url);
  });
  const pending = await turn(enabledEnv(db), fetchImpl, "criar lembrete de chuva");
  assert.equal(pending.mode, "ciba-pending");
  assert.equal(pending.approval.status, "pending");
  assert.match(pending.answer, /não foi alterado|was not changed/i);
  leaked(pending);
  assert.equal(calls.some(call => call.url.includes("googleapis")), false);
  const early = await pollCalendarApproval({
    env: enabledEnv(db), sub, bearer: userToken, profile, approvalId: pending.approval.id,
    fetchImpl, now: new Date(now.getTime() + 1000)
  });
  assert.equal(early.body.status, "pending");
  assert.equal(calls.some(call => grantType(call) === CIBA_GRANT), false);
  const waiting = await pollCalendarApproval({
    env: enabledEnv(db), sub, bearer: userToken, profile, approvalId: pending.approval.id,
    fetchImpl, now: new Date(now.getTime() + 6000)
  });
  assert.equal(waiting.body.status, "pending");
  assert.equal(calls.some(call => call.url.includes("googleapis")), false);
  approved = true;
  const done = await pollCalendarApproval({
    env: enabledEnv(db), sub, bearer: userToken, profile, approvalId: pending.approval.id,
    fetchImpl, now: new Date(now.getTime() + 12000)
  });
  assert.equal(done.body.status, "approved");
  assert.equal(done.persist.conversationId, conversationId);
  assert.match(done.body.answer, /Aprovado fora do chat|Approved outside the chat/);
  leaked(done.body);
  const row = db.dump("SELECT status, payload_json, result_text, auth_req_id FROM calendar_approvals")[0];
  assert.equal(row.status, "approved");
  assert.equal(row.auth_req_id, authReqId);
  leaked(row.payload_json);
  leaked(row.result_text);
  const again = await pollCalendarApproval({
    env: enabledEnv(db), sub, bearer: userToken, profile, approvalId: pending.approval.id,
    fetchImpl, now: new Date(now.getTime() + 20000)
  });
  assert.equal(again.body.status, "approved");
  assert.equal(calls.filter(call => call.method === "POST" && call.url.endsWith("/events")).length, 1);
});
test("denial and a far-away date abort without a calendar write", async () => {
  const db = createMemoryDb();
  const {fetchImpl, calls} = router(call => {
    if (call.url === "https://tenant.auth0.com/bc-authorize") {
      return jsonResponse({auth_req_id: authReqId, expires_in: 300, interval: 5});
    }
    if (call.url.includes("/oauth/token") && grantType(call) === CIBA_GRANT) {
      return jsonResponse({error: "access_denied", error_description: "denied"}, 403);
    }
    if (call.url.startsWith("https://api.open-meteo.com/")) return jsonResponse(forecastBody());
    throw new Error("unexpected " + call.url);
  });
  const far = await turn(enabledEnv(db), fetchImpl, "criar lembrete de chuva em 2027-01-01");
  assert.match(far.answer, /16/);
  assert.equal(far.approval, null);
  assert.equal(calls.some(call => call.url.includes("bc-authorize")), false);
  const pending = await turn(enabledEnv(db), fetchImpl, "criar lembrete de chuva em 2026-11-12");
  assert.equal(pending.mode, "ciba-pending");
  const denied = await pollCalendarApproval({
    env: enabledEnv(db), sub, bearer: userToken, profile, approvalId: pending.approval.id,
    fetchImpl, now: new Date(now.getTime() + 6000)
  });
  assert.equal(denied.body.status, "denied");
  assert.match(denied.body.answer, /recusada|denied/i);
  assert.equal(calls.some(call => call.url.includes("googleapis")), false);
  leaked(denied.body);
});
test("reschedule refuses all-day events and patches a timed event only after approval", async () => {
  const db = createMemoryDb();
  let phase = "list";
  const {fetchImpl, calls} = router(call => {
    if (call.url.includes("/oauth/token") && grantType(call) === TOKEN_EXCHANGE_GRANT) {
      return jsonResponse({access_token: googleToken, token_type: "Bearer", expires_in: 300});
    }
    if (call.url.startsWith("https://www.googleapis.com/calendar/v3/calendars/primary/events?")) {
      return jsonResponse({items: calendarItems()});
    }
    if (call.url.startsWith("https://api.open-meteo.com/")) return jsonResponse(forecastBody());
    if (call.url === "https://tenant.auth0.com/bc-authorize") {
      return jsonResponse({auth_req_id: authReqId, expires_in: 300, interval: 5});
    }
    if (call.url.includes("/oauth/token") && grantType(call) === CIBA_GRANT) {
      return jsonResponse({access_token: cibaToken, expires_in: 300, token_type: "Bearer"});
    }
    if (call.method === "PATCH" && call.url.endsWith("/events/evt_primary_1")) {
      const body = JSON.parse(call.body);
      assert.equal(body.start.dateTime, "2026-11-20T16:45:00");
      assert.equal(body.end.dateTime, "2026-11-20T17:45:00");
      phase = "patched";
      return jsonResponse({id: "evt_primary_1"});
    }
    throw new Error("unexpected " + call.method + " " + call.url);
  });
  await turn(enabledEnv(db), fetchImpl, "agenda");
  const allDay = await turn(enabledEnv(db), fetchImpl, "reagendar 2 para 2026-11-20T16:45");
  assert.match(allDay.answer, /dia inteiro|all-day/i);
  assert.equal(calls.some(call => call.url.includes("bc-authorize")), false);
  const pending = await turn(enabledEnv(db), fetchImpl, "reagendar 1 para 2026-11-20T16:45");
  assert.equal(pending.mode, "ciba-pending");
  assert.equal(phase, "list");
  const done = await pollCalendarApproval({
    env: enabledEnv(db), sub, bearer: userToken, profile, approvalId: pending.approval.id,
    fetchImpl, now: new Date(now.getTime() + 6000)
  });
  assert.equal(done.body.status, "approved");
  assert.equal(phase, "patched");
  leaked(done.body);
});
test("a low rain probability still needs approval before creating the reminder", async () => {
  const db = createMemoryDb();
  const {fetchImpl} = router(call => {
    if (call.url.startsWith("https://api.open-meteo.com/")) {
      const body = forecastBody();
      body.daily.precipitation_probability_max = body.daily.time.map(() => 10);
      return jsonResponse(body);
    }
    if (call.url === "https://tenant.auth0.com/bc-authorize") {
      return jsonResponse({auth_req_id: authReqId, expires_in: 300, interval: 5});
    }
    throw new Error("unexpected " + call.url);
  });
  const pending = await turn(enabledEnv(db), fetchImpl, "create rain reminder on 2026-11-11");
  assert.equal(pending.mode, "ciba-pending");
  const payload = db.dump("SELECT payload_json FROM calendar_approvals")[0].payload_json;
  assert.match(payload, /Lembrete de tempo|Weather reminder/);
  assert.equal(payload.includes(googleToken), false);
});
