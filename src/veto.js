// Google Calendar via Auth0 Token Vault, with CIBA gating for writes.
// Google access tokens exist only for the duration of a fetch. They are never
// written to D1, logs, or the chat response. Auth0 CIBA auth_req_id is stored
// so the Worker can poll, and it is not returned to the browser.

import { CITIES, OPEN_METEO_FORECAST_DAYS, addIsoDays, forecastReach, forecastUrl, isoDateInTimeZone } from "./shared.js";

export const RAIN_ALERT_PERCENT = 40;
export const CALENDAR_SCOPES = Object.freeze([
  "openid",
  "profile",
  "email",
  "https://www.googleapis.com/auth/calendar.events"
]);
export const TOKEN_EXCHANGE_GRANT = "urn:auth0:params:oauth:grant-type:token-exchange:federated-connection-access-token";
export const FEDERATED_TOKEN_TYPE = "http://auth0.com/oauth/token-type/federated-connection-access-token";
export const ACCESS_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token";
export const CIBA_GRANT = "urn:openid:params:grant-type:ciba";

const OAUTH_ERRORS = new Set([
  "invalid_request", "invalid_grant", "invalid_client", "unauthorized_client",
  "access_denied", "server_error", "temporarily_unavailable", "authorization_pending",
  "slow_down", "expired_token", "consent_required", "login_required"
]);
const CLIENT_ID = /^[A-Za-z0-9_-]{16,64}$/;
const CONNECTION_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const EVENT_ID = /^[A-Za-z0-9_-]{1,1024}$/;
const LOCAL_DATE_TIME = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})$/;

export const VETO_SCHEMA = Object.freeze([
  `CREATE TABLE IF NOT EXISTS calendar_snapshots (
    user_sub TEXT PRIMARY KEY,
    events_json TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS calendar_approvals (
    id TEXT PRIMARY KEY,
    user_sub TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    action TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    binding_message TEXT NOT NULL,
    auth_req_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending','executing','approved','denied','expired','error')),
    interval_seconds INTEGER NOT NULL DEFAULT 5,
    result_text TEXT,
    expires_at TEXT NOT NULL,
    next_poll_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_calendar_approvals_owner ON calendar_approvals(user_sub, status, created_at)`
]);

export class VetoError extends Error {
  constructor(code, extra = {}) {
    super(code);
    this.name = "VetoError";
    this.code = code;
    this.httpStatus = extra.httpStatus || 0;
    this.oauth = extra.oauth || "";
    this.reason = extra.reason || "";
  }
}

function english(profile) {
  return profile?.response_language === "en-US";
}
function cityOf(profile) {
  return CITIES[profile.preferred_city];
}
function clip(value, max) {
  return String(value ?? "").replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}
export function validIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return false;
  const [year, month, day] = value.split("-").map(Number);
  if (year < 2020 || year > 2100) return false;
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}
function oauthErrorCode(data) {
  const code = data && typeof data.error === "string" ? data.error : "";
  return OAUTH_ERRORS.has(code) ? code : "";
}
function explicitlyOff(env) {
  const flag = String(env?.VETO_AGENT || "auto").trim().toLowerCase();
  return flag === "off" || flag === "false" || flag === "0";
}

export function vetoConfig(env) {
  const domain = String(env?.AUTH0_DOMAIN || "");
  const vaultClientId = String(env?.AUTH0_VAULT_CLIENT_ID || "");
  const vaultClientSecret = String(env?.AUTH0_VAULT_CLIENT_SECRET || "");
  const cibaClientId = String(env?.AUTH0_CIBA_CLIENT_ID || "");
  const cibaClientSecret = String(env?.AUTH0_CIBA_CLIENT_SECRET || "");
  const channel = String(env?.AUTH0_CIBA_CHANNEL || "guardian").trim().toLowerCase();
  const connection = String(env?.AUTH0_GOOGLE_CONNECTION || "google-oauth2").trim();
  const domainOk = /^[a-z0-9][a-z0-9.-]*\.auth0\.com$/i.test(domain) && !domain.includes("REPLACE");
  const secretsOk = [vaultClientId, cibaClientId].every(value => CLIENT_ID.test(value)) &&
    [vaultClientSecret, cibaClientSecret].every(value => value.length >= 16 && !/replace|your_|changeme/i.test(value));
  const enabled = !explicitlyOff(env) && domainOk && secretsOk &&
    (channel === "guardian" || channel === "email") && CONNECTION_NAME.test(connection);
  if (!enabled) return {enabled: false};
  return {
    enabled: true,
    domain,
    issuer: "https://" + domain + "/",
    connection,
    channel,
    requestedExpiry: channel === "email" ? 3600 : 300,
    vaultClientId,
    vaultClientSecret,
    cibaClientId,
    cibaClientSecret
  };
}
export function vetoPublicConfig(env) {
  const config = vetoConfig(env);
  return config.enabled ? {enabled: true, connection: config.connection} : {enabled: false};
}

export function bindingMessage(action, detail) {
  const cleaned = (action + "-" + detail)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9+\-_.,:#]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
  return /^[A-Za-z0-9+\-_.,:#]{1,64}$/.test(cleaned) ? cleaned : "BuilderOps-calendar";
}

export function classifyCalendarCommand(message) {
  const text = String(message || "").trim().replace(/\s+/g, " ").replace(/[.!?]+$/, "");
  if (/^(agenda|meus eventos|minha agenda|listar agenda|list events|my calendar|upcoming events|tempo da agenda|previsão da agenda|previsao da agenda|clima da agenda|weather for my events)$/i.test(text)) {
    return {type: "list"};
  }
  if (/^(status da aprovação|status da aprovacao|approval status)$/i.test(text)) {
    return {type: "status"};
  }
  const rain = text.match(/^(criar lembrete de chuva|lembrete de chuva|alerta de chuva|create rain reminder|rain alert)(?: (?:em|on|para) (\d{4}-\d{2}-\d{2}))?$/i);
  if (rain) {
    if (rain[2] && !validIsoDate(rain[2])) return {type: "invalid"};
    return {type: "create-rain-alert", date: rain[2] || null};
  }
  const move = text.match(/^(?:reagendar|mover evento|reschedule|move event) (\d+) (?:para|to) (\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/i);
  if (move) {
    const index = Number(move[1]);
    const hour = Number(move[3]);
    const minute = Number(move[4]);
    if (index < 1 || index > 8 || hour > 23 || minute > 59 || !validIsoDate(move[2])) return {type: "invalid"};
    return {type: "reschedule", index, localStart: move[2] + "T" + move[3] + ":" + move[4]};
  }
  return null;
}
export function isCalendarCommand(message) {
  return classifyCalendarCommand(message) !== null;
}

function usage(profile) {
  return english(profile)
    ? "Calendar commands are exact: agenda | create rain reminder | create rain reminder on YYYY-MM-DD | reschedule N to YYYY-MM-DDTHH:MM | approval status. Writes wait for out-of-band approval."
    : "Os comandos de agenda são exatos: agenda | criar lembrete de chuva | criar lembrete de chuva em AAAA-MM-DD | reagendar N para AAAA-MM-DDTHH:MM | status da aprovação. Gravações esperam aprovação fora do chat.";
}
function disabledAnswer(profile) {
  return english(profile)
    ? "Google Calendar is not configured on this Worker. Weather questions still use your saved profile and Open-Meteo. Try: How is the weather in my city?"
    : "A agenda com Google Calendar ainda não está configurada neste Worker. As perguntas sobre o tempo continuam usando seu perfil e a Open-Meteo. Tente: Como está o tempo na minha cidade?";
}
function outcome(answer, mode, thirdParty, approval = null) {
  return {answer: clip(answer, 2400), mode, thirdParty, approval};
}
function vaultAnswer(profile, error) {
  const code = error?.oauth ? " (" + error.oauth + ")" : "";
  if (error?.httpStatus === 401 || error?.httpStatus === 403 || ["invalid_grant", "access_denied", "consent_required", "login_required"].includes(error?.oauth)) {
    return english(profile)
      ? "Token Vault has no usable Google Calendar token for this login" + code + ". Use Connect Google Calendar and accept event access. Nothing was written."
      : "O Token Vault não tem um token utilizável do Google Calendar para este login" + code + ". Use Conectar Google Calendar e aceite o acesso aos eventos. Nada foi gravado.";
  }
  return english(profile)
    ? "Could not exchange your Auth0 token for a Google Calendar token" + code + ". Nothing was written."
    : "Não foi possível trocar seu token Auth0 por um token do Google Calendar" + code + ". Nada foi gravado.";
}
function googleAnswer(profile, error) {
  const reason = error?.reason ? " (" + error.reason + ")" : "";
  if (error?.httpStatus === 403) {
    return english(profile)
      ? "Google Calendar refused this call" + reason + ". Reconnect and grant the calendar events scope. Nothing further will be retried."
      : "O Google Calendar recusou esta chamada" + reason + ". Reconecte e conceda o escopo de eventos. Nenhuma nova tentativa automática será feita.";
  }
  if (error?.httpStatus === 404) {
    return english(profile)
      ? "That Google Calendar event was not found. List the agenda again. Nothing was changed."
      : "Esse evento não foi encontrado no Google Calendar. Liste a agenda de novo. Nada foi alterado.";
  }
  return english(profile)
    ? "Google Calendar returned an error" + reason + ". Nothing further will be retried."
    : "O Google Calendar devolveu um erro" + reason + ". Nenhuma nova tentativa automática será feita.";
}
function channelLabel(profile, channel) {
  if (channel === "email") return english(profile) ? "approval email" : "e-mail de aprovação";
  return english(profile) ? "Auth0 Guardian push" : "push do Auth0 Guardian";
}

async function ensureSchema(env) {
  for (const statement of VETO_SCHEMA) await env.DB.prepare(statement).bind().run();
}
async function readJson(response, limit) {
  const text = await response.text();
  if (text.length > limit) throw new VetoError("RESPONSE_TOO_LARGE", {httpStatus: response.status});
  if (!text) return {};
  try { return JSON.parse(text); } catch { return {}; }
}
async function postJson(fetchImpl, url, body) {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {"content-type": "application/json", accept: "application/json"},
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000)
  });
  return {ok: response.ok, status: response.status, data: await readJson(response, 20000)};
}
async function postForm(fetchImpl, url, params) {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {"content-type": "application/x-www-form-urlencoded", accept: "application/json"},
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(8000)
  });
  const retryAfter = Number(response.headers.get("retry-after"));
  return {
    ok: response.ok,
    status: response.status,
    retryAfter: Number.isFinite(retryAfter) ? retryAfter : 0,
    data: await readJson(response, 20000)
  };
}
function authUrl(config, path) {
  const url = new URL("https://" + config.domain + path);
  if (url.hostname !== config.domain) throw new VetoError("BAD_AUTH_URL");
  return url;
}
function calendarEndpoint(suffix) {
  const url = new URL("https://www.googleapis.com/calendar/v3/calendars/primary/" + suffix);
  if (url.origin !== "https://www.googleapis.com" || !url.pathname.startsWith("/calendar/v3/calendars/primary/")) {
    throw new VetoError("BAD_CALENDAR_URL");
  }
  return url;
}

async function withGoogle(config, subjectToken, fetchImpl, fn) {
  const exchanged = await postJson(fetchImpl, authUrl(config, "/oauth/token"), {
    client_id: config.vaultClientId,
    client_secret: config.vaultClientSecret,
    subject_token: subjectToken,
    grant_type: TOKEN_EXCHANGE_GRANT,
    subject_token_type: ACCESS_TOKEN_TYPE,
    requested_token_type: FEDERATED_TOKEN_TYPE,
    connection: config.connection
  });
  const oauth = oauthErrorCode(exchanged.data);
  const token = exchanged.data?.access_token;
  if (exchanged.data) exchanged.data.access_token = "";
  if (!exchanged.ok || typeof token !== "string" || token.length < 8) {
    throw new VetoError("VAULT_EXCHANGE_FAILED", {httpStatus: exchanged.status, oauth});
  }
  return fn(token);
}
async function googleCall(fetchImpl, url, token, init) {
  const headers = {
    authorization: "Bearer " + token,
    accept: "application/json",
    ...(init.body ? {"content-type": "application/json"} : {})
  };
  const response = await fetchImpl(url, {...init, headers, signal: AbortSignal.timeout(8000)});
  const data = await readJson(response, 100000);
  if (!response.ok) {
    const rawReason = data?.error?.errors?.[0]?.reason || data?.error?.status || "";
    const reason = String(rawReason).replace(/[^A-Za-z0-9_]/g, "").slice(0, 40);
    throw new VetoError("GOOGLE_CALENDAR_FAILED", {httpStatus: response.status, reason});
  }
  return data;
}
async function loadForecast(profile, fetchImpl) {
  try {
    const response = await fetchImpl(forecastUrl(profile, OPEN_METEO_FORECAST_DAYS), {
      headers: {accept: "application/json"},
      signal: AbortSignal.timeout(6500)
    });
    const data = await readJson(response, 100000);
    if (!response.ok || !Array.isArray(data?.daily?.time)) return null;
    return data.daily;
  } catch {
    return null;
  }
}
function dayForecast(profile, daily, targetIso, todayIso) {
  const reach = forecastReach(todayIso, targetIso);
  const en = english(profile);
  const unit = profile.temperature_unit === "fahrenheit" ? "°F" : "°C";
  if (reach.status === "past") {
    return {reach, text: en ? "The event date is in the past, so Open-Meteo has no forecast." : "A data do evento já passou, então a Open-Meteo não tem previsão."};
  }
  if (reach.status !== "ok") {
    const last = addIsoDays(todayIso, OPEN_METEO_FORECAST_DAYS - 1);
    return {
      reach,
      text: en
        ? "Open-Meteo forecasts only " + OPEN_METEO_FORECAST_DAYS + " days (through " + last + "). This date is " + reach.offset + " days out, so there is no forecast yet."
        : "A Open-Meteo só prevê " + OPEN_METEO_FORECAST_DAYS + " dias (até " + last + "). Esta data está a " + reach.offset + " dias, então ainda não há previsão."
    };
  }
  if (!daily) return {reach, text: en ? "The Open-Meteo forecast is unavailable right now." : "A previsão da Open-Meteo está indisponível agora."};
  const index = daily.time.indexOf(targetIso);
  if (index < 0) return {reach, text: en ? "Open-Meteo did not return this date." : "A Open-Meteo não devolveu essa data."};
  const max = daily.temperature_2m_max?.[index];
  const min = daily.temperature_2m_min?.[index];
  const rain = daily.precipitation_probability_max?.[index];
  const rainText = typeof rain === "number" ? rain + "%" : (en ? "n/a" : "s/d");
  const temps = typeof max === "number" && typeof min === "number" ? (en ? "high " + max + unit + ", low " + min + unit : "máxima " + max + unit + ", mínima " + min + unit) : "";
  return {
    reach,
    rain: typeof rain === "number" ? rain : null,
    text: en
      ? "Open-Meteo: " + [temps, "precipitation probability " + rainText].filter(Boolean).join(", ") + "."
      : "Open-Meteo: " + [temps, "probabilidade de chuva " + rainText].filter(Boolean).join(", ") + "."
  };
}
function eventDate(start, allDay, timeZone) {
  if (!start) return null;
  if (allDay && validIsoDate(start)) return start;
  const parsed = new Date(start);
  if (Number.isNaN(parsed.getTime())) return null;
  const local = isoDateInTimeZone(parsed, timeZone);
  return validIsoDate(local) ? local : null;
}
function formatWhen(event, timeZone) {
  if (event.allDay) return event.start;
  const parsed = new Date(event.start);
  if (Number.isNaN(parsed.getTime())) return event.start;
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).format(parsed);
}
function normalizeEvents(items, timeZone) {
  const events = [];
  for (const item of items || []) {
    if (!item || item.status === "cancelled" || !EVENT_ID.test(item.id || "")) continue;
    const allDay = Boolean(item.start?.date && !item.start?.dateTime);
    const start = allDay ? item.start.date : item.start?.dateTime;
    const end = allDay ? item.end?.date : item.end?.dateTime;
    if (!start) continue;
    const date = eventDate(start, allDay, timeZone);
    events.push({
      n: events.length + 1,
      id: item.id,
      summary: clip(item.summary || "(sem título)", 140) || "(sem título)",
      start, end: end || start, allDay, date
    });
    if (events.length === 8) break;
  }
  return events;
}
async function listEvents(config, subjectToken, fetchImpl, now) {
  const timeMin = now.toISOString();
  const timeMax = new Date(now.getTime() + 30 * 86400000).toISOString();
  return withGoogle(config, subjectToken, fetchImpl, async token => {
    const url = calendarEndpoint("events");
    url.searchParams.set("singleEvents", "true");
    url.searchParams.set("orderBy", "startTime");
    url.searchParams.set("maxResults", "8");
    url.searchParams.set("timeMin", timeMin);
    url.searchParams.set("timeMax", timeMax);
    url.searchParams.set("fields", "items(id,summary,status,start,end)");
    const data = await googleCall(fetchImpl, url, token, {method: "GET"});
    return Array.isArray(data.items) ? data.items : [];
  });
}
async function saveSnapshot(env, sub, events) {
  await env.DB.prepare(
    "INSERT INTO calendar_snapshots (user_sub, events_json, updated_at) VALUES (?,?,CURRENT_TIMESTAMP) " +
    "ON CONFLICT(user_sub) DO UPDATE SET events_json=excluded.events_json, updated_at=CURRENT_TIMESTAMP"
  ).bind(sub, JSON.stringify(events)).run();
}
async function loadSnapshot(env, sub) {
  const row = await env.DB.prepare("SELECT events_json FROM calendar_snapshots WHERE user_sub=?").bind(sub).first();
  if (!row?.events_json) return [];
  try {
    const parsed = JSON.parse(row.events_json);
    return Array.isArray(parsed) ? parsed.filter(event => event && EVENT_ID.test(event.id || "")) : [];
  } catch {
    return [];
  }
}
function formatAgenda(profile, events, daily, todayIso) {
  const en = english(profile);
  const city = cityOf(profile).name;
  if (!events.length) {
    return en
      ? "Google Calendar has no upcoming events in the next 30 days."
      : "O Google Calendar não tem eventos nos próximos 30 dias.";
  }
  const lines = events.map(event => {
    const when = formatWhen(event, cityOf(profile).timezone);
    const forecast = event.date ? dayForecast(profile, daily, event.date, todayIso).text : (en ? "The event date could not be read." : "Não foi possível ler a data do evento.");
    return event.n + ". " + event.summary + " — " + when + ". " + forecast;
  });
  const head = en
    ? "Upcoming Google Calendar events via Token Vault. Forecasts use Open-Meteo for " + city + "."
    : "Próximos eventos do Google Calendar via Token Vault. A previsão usa a Open-Meteo para " + city + ".";
  const foot = en
    ? "Writes stay paused until you approve them outside the chat: create rain reminder, or reschedule N to YYYY-MM-DDTHH:MM."
    : "Gravações ficam pausadas até você aprovar fora do chat: criar lembrete de chuva, ou reagendar N para AAAA-MM-DDTHH:MM.";
  return [head, ...lines, foot].join("\n");
}

function addMinutes(localDateTime, minutes) {
  const match = LOCAL_DATE_TIME.exec(localDateTime);
  if (!match || !Number.isInteger(minutes)) return null;
  const total = Number(match[2]) * 60 + Number(match[3]) + minutes;
  const shift = Math.floor(total / 1440);
  const minuteOfDay = ((total % 1440) + 1440) % 1440;
  const date = addIsoDays(match[1], shift);
  if (!date) return null;
  const hour = String(Math.floor(minuteOfDay / 60)).padStart(2, "0");
  const minute = String(minuteOfDay % 60).padStart(2, "0");
  return date + "T" + hour + ":" + minute + ":" + match[4];
}
function durationMinutes(start, end) {
  const from = Date.parse(start);
  const to = Date.parse(end);
  if (Number.isNaN(from) || Number.isNaN(to)) return 60;
  const minutes = Math.round((to - from) / 60000);
  if (minutes < 15 || minutes > 480) return 60;
  return minutes;
}
function localStamp(dateIso, hourMinute) {
  return dateIso + "T" + hourMinute + ":00";
}

async function openPending(env, sub, now) {
  const row = await env.DB.prepare(
    "SELECT id, status, expires_at, interval_seconds, conversation_id FROM calendar_approvals " +
    "WHERE user_sub=? AND status='pending' ORDER BY created_at DESC, rowid DESC LIMIT 1"
  ).bind(sub).first();
  if (!row) return null;
  if (Date.parse(row.expires_at) <= now.getTime()) {
    await env.DB.prepare(
      "UPDATE calendar_approvals SET status='expired', updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_sub=? AND status='pending'"
    ).bind(row.id, sub).run();
    return null;
  }
  return row;
}
function pendingPayload(row, now) {
  const remaining = Math.max(1, Math.ceil((Date.parse(row.expires_at) - now.getTime()) / 1000));
  return {
    id: row.id,
    status: "pending",
    retryAfterSeconds: Math.max(5, Number(row.interval_seconds) || 5),
    expiresInSeconds: remaining
  };
}
async function beginApproval(env, config, sub, conversationId, profile, action, payload, binding, fetchImpl, now) {
  const existing = await openPending(env, sub, now);
  if (existing) {
    return outcome(
      english(profile)
        ? "An approval request is already waiting outside the chat. Nothing new was sent. You can wait, or send: approval status."
        : "Já existe um pedido de aprovação esperando fora do chat. Nada novo foi enviado. Espere, ou envie: status da aprovação.",
      "ciba-pending",
      "Auth0 CIBA",
      pendingPayload(existing, now)
    );
  }
  const started = await postForm(fetchImpl, authUrl(config, "/bc-authorize"), {
    client_id: config.cibaClientId,
    client_secret: config.cibaClientSecret,
    scope: "openid",
    login_hint: JSON.stringify({format: "iss_sub", iss: config.issuer, sub}),
    binding_message: binding,
    requested_expiry: String(config.requestedExpiry)
  });
  const authReqId = typeof started.data?.auth_req_id === "string" ? started.data.auth_req_id : "";
  if (!started.ok || !authReqId || authReqId.length > 2000) {
    const code = oauthErrorCode(started.data);
    console.error(JSON.stringify({event: "ciba_start_failed", oauth: code || "unknown", http: started.status}));
    return outcome(
      english(profile)
        ? "Could not send the out-of-band approval request" + (code ? " (" + code + ")" : "") + ". Nothing was written to Google Calendar. CIBA is not on the Auth0 Free plan; Guardian push needs an Enterprise plan or add-on, and email needs the Auth0 for AI Agents add-on."
        : "Não foi possível enviar o pedido de aprovação fora do chat" + (code ? " (" + code + ")" : "") + ". Nada foi gravado no Google Calendar. CIBA não existe no plano Free da Auth0; o push do Guardian exige plano Enterprise ou add-on, e o e-mail exige o add-on Auth0 for AI Agents.",
      "calendar-error",
      "Auth0 CIBA"
    );
  }
  const interval = Math.max(5, Number(started.data.interval) || 5);
  const expiresIn = Math.max(30, Number(started.data.expires_in) || config.requestedExpiry);
  const expiresAt = new Date(now.getTime() + expiresIn * 1000).toISOString();
  const nextPoll = new Date(now.getTime() + interval * 1000).toISOString();
  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO calendar_approvals (id,user_sub,conversation_id,action,payload_json,binding_message,auth_req_id,status,interval_seconds,expires_at,next_poll_at) " +
    "VALUES (?,?,?,?,?,?,?,'pending',?,?,?)"
  ).bind(id, sub, conversationId, action, JSON.stringify(payload), binding, authReqId, interval, expiresAt, nextPoll).run();
  console.log(JSON.stringify({event: "ciba_started", channel: config.channel, action}));
  const summary = clip(payload.summary || action, 80);
  return outcome(
    english(profile)
      ? "Approval requested outside the chat via " + channelLabel(profile, config.channel) + ". Paused action: " + summary + " on " + payload.date + ". Binding message: " + binding + ". Google Calendar was not changed. Approve or deny the request and I will continue from here."
      : "Pedi aprovação fora do chat por " + channelLabel(profile, config.channel) + ". Ação pausada: " + summary + " em " + payload.date + ". Mensagem de conferência: " + binding + ". O Google Calendar não foi alterado. Aprove ou recuse o pedido e eu continuo daqui.",
    "ciba-pending",
    "Auth0 CIBA",
    {id, status: "pending", retryAfterSeconds: interval, expiresInSeconds: expiresIn}
  );
}

async function handleList(env, config, sub, bearer, profile, fetchImpl, now) {
  const todayIso = isoDateInTimeZone(now, cityOf(profile).timezone);
  let items;
  try {
    items = await listEvents(config, bearer, fetchImpl, now);
  } catch (error) {
    if (error instanceof VetoError && error.code === "VAULT_EXCHANGE_FAILED") return outcome(vaultAnswer(profile, error), "calendar-error", "Auth0 Token Vault");
    if (error instanceof VetoError && error.code === "GOOGLE_CALENDAR_FAILED") return outcome(googleAnswer(profile, error), "calendar-error", "Google Calendar");
    throw error;
  }
  const events = normalizeEvents(items, cityOf(profile).timezone);
  await saveSnapshot(env, sub, events);
  const daily = await loadForecast(profile, fetchImpl);
  return outcome(formatAgenda(profile, events, daily, todayIso), "calendar-read", daily ? "Google Calendar + Open-Meteo" : "Google Calendar");
}
async function handleRain(env, config, sub, conversationId, profile, command, fetchImpl, now) {
  const timeZone = cityOf(profile).timezone;
  const todayIso = isoDateInTimeZone(now, timeZone);
  const date = command.date || addIsoDays(todayIso, 1);
  const reachOnly = dayForecast(profile, null, date, todayIso);
  if (reachOnly.reach.status !== "ok") {
    return outcome(
      (english(profile) ? "I did not create a reminder. " : "Não criei o lembrete. ") + reachOnly.text,
      "calendar-read",
      "Open-Meteo"
    );
  }
  const forecast = dayForecast(profile, await loadForecast(profile, fetchImpl), date, todayIso);
  if (forecast.reach.status !== "ok") {
    return outcome(
      (english(profile) ? "I did not create a reminder. " : "Não criei o lembrete. ") + forecast.text,
      "calendar-read",
      "Open-Meteo"
    );
  }
  const copy = rainCopy(profile, date, forecast.rain);
  const payload = {
    type: "create-rain-alert",
    summary: copy.summary,
    description: copy.description,
    date,
    rain: forecast.rain,
    start: {dateTime: localStamp(date, "08:00"), timeZone},
    end: {dateTime: localStamp(date, "08:30"), timeZone}
  };
  const pct = typeof forecast.rain === "number" ? "p" + forecast.rain : "p-na";
  return beginApproval(env, config, sub, conversationId, profile, "create-rain-alert", payload, bindingMessage("Rain-alert", date + "-" + pct), fetchImpl, now);
}
function rainCopy(profile, date, rain) {
  const en = english(profile);
  const city = cityOf(profile).name;
  const alert = typeof rain === "number" && rain >= RAIN_ALERT_PERCENT;
  const summary = alert ? (en ? "Rain alert" : "Alerta de chuva") : (en ? "Weather reminder" : "Lembrete de tempo");
  const pct = typeof rain === "number" ? rain + "%" : (en ? "unavailable" : "indisponível");
  const description = en
    ? "Created by BuilderOps after out-of-band CIBA approval. " + city + " on " + date + ". Open-Meteo precipitation probability: " + pct + ". Rain-alert threshold: " + RAIN_ALERT_PERCENT + "%."
    : "Criado pelo BuilderOps depois da aprovação CIBA fora do chat. " + city + " em " + date + ". Probabilidade de chuva na Open-Meteo: " + pct + ". Limite de alerta de chuva: " + RAIN_ALERT_PERCENT + "%.";
  return {summary, description: clip(description, 500)};
}
async function handleReschedule(env, config, sub, conversationId, profile, command, fetchImpl, now) {
  const events = await loadSnapshot(env, sub);
  const event = events.find(item => item.n === command.index);
  if (!event) {
    return outcome(
      english(profile)
        ? "I need a fresh agenda list before moving an event. Send: agenda. Nothing was changed."
        : "Preciso de uma agenda recente antes de mover um evento. Envie: agenda. Nada foi alterado.",
      "calendar-error",
      "Google Calendar"
    );
  }
  if (event.allDay) {
    return outcome(
      english(profile)
        ? "Event " + event.n + " is all-day, and this demo does not move all-day events. Nothing was changed."
        : "O evento " + event.n + " dura o dia inteiro, e esta demonstração não move eventos de dia inteiro. Nada foi alterado.",
      "calendar-error",
      "Google Calendar"
    );
  }
  const timeZone = cityOf(profile).timezone;
  const start = command.localStart + ":00";
  const end = addMinutes(start, durationMinutes(event.start, event.end));
  if (!end) return outcome(usage(profile), "calendar-error", "Google Calendar");
  const payload = {
    type: "reschedule",
    eventId: event.id,
    summary: event.summary,
    date: command.localStart.slice(0, 10),
    from: event.start,
    start: {dateTime: start, timeZone},
    end: {dateTime: end, timeZone}
  };
  return beginApproval(
    env, config, sub, conversationId, profile, "reschedule", payload,
    bindingMessage("Move-" + command.index, command.localStart),
    fetchImpl, now
  );
}
async function handleStatus(env, sub, profile, now) {
  const row = await env.DB.prepare(
    "SELECT id, status, result_text, interval_seconds, expires_at FROM calendar_approvals WHERE user_sub=? ORDER BY created_at DESC, rowid DESC LIMIT 1"
  ).bind(sub).first();
  if (!row) {
    return outcome(english(profile) ? "There is no calendar approval request yet." : "Ainda não há pedido de aprovação da agenda.", "calendar-read", "Auth0 CIBA");
  }
  if (row.status === "pending") {
    if (Date.parse(row.expires_at) <= now.getTime()) {
      await env.DB.prepare(
        "UPDATE calendar_approvals SET status='expired', updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_sub=? AND status='pending'"
      ).bind(row.id, sub).run();
      return outcome(expiredText(profile), "ciba-denied", "Auth0 CIBA");
    }
    return outcome(
      english(profile) ? "The approval request is still waiting outside the chat. Google Calendar has not been changed." : "O pedido de aprovação ainda espera fora do chat. O Google Calendar não foi alterado.",
      "ciba-pending",
      "Auth0 CIBA",
      pendingPayload(row, now)
    );
  }
  if (row.status === "executing") {
    return outcome(
      english(profile) ? "The approval was received and the calendar write is still finishing. Check Google Calendar before trying again." : "A aprovação chegou e a gravação no calendário ainda está terminando. Confira o Google Calendar antes de tentar de novo.",
      "ciba-pending",
      "Google Calendar"
    );
  }
  return outcome(row.result_text || terminalFallback(profile, row.status), modeFor(row.status), "Auth0 CIBA");
}
function modeFor(status) {
  if (status === "approved") return "ciba-approved";
  if (status === "denied" || status === "expired") return "ciba-denied";
  return "calendar-error";
}
function expiredText(profile) {
  return english(profile)
    ? "The approval request expired with no response. The action was cancelled and Google Calendar was not changed."
    : "O pedido de aprovação expirou sem resposta. A ação foi cancelada e o Google Calendar não foi alterado.";
}
function deniedText(profile) {
  return english(profile)
    ? "The approval was denied or it expired. The action was cancelled and Google Calendar was not changed."
    : "A aprovação foi recusada ou expirou. A ação foi cancelada e o Google Calendar não foi alterado.";
}
function terminalFallback(profile, status) {
  if (status === "expired") return expiredText(profile);
  if (status === "denied") return deniedText(profile);
  if (status === "approved") return english(profile) ? "The approved calendar action finished." : "A ação aprovada no calendário terminou.";
  return english(profile) ? "The calendar action stopped. Check Google Calendar before trying again." : "A ação no calendário parou. Confira o Google Calendar antes de tentar de novo.";
}

function storedPayload(raw) {
  let payload;
  try { payload = JSON.parse(raw); } catch { return null; }
  if (!payload || (payload.type !== "create-rain-alert" && payload.type !== "reschedule")) return null;
  const start = payload.start;
  const end = payload.end;
  if (!start || !end || !validLocal(start.dateTime) || !validLocal(end.dateTime) || !cityZone(start.timeZone) || start.timeZone !== end.timeZone) return null;
  if (payload.type === "reschedule" && !EVENT_ID.test(payload.eventId || "")) return null;
  if (payload.type === "create-rain-alert" && !clip(payload.summary, 140)) return null;
  return {
    type: payload.type,
    eventId: payload.eventId,
    summary: clip(payload.summary, 140),
    description: clip(payload.description, 500),
    date: validIsoDate(payload.date) ? payload.date : start.dateTime.slice(0, 10),
    start: {dateTime: start.dateTime, timeZone: start.timeZone},
    end: {dateTime: end.dateTime, timeZone: end.timeZone}
  };
}
function validLocal(value) {
  return LOCAL_DATE_TIME.test(value || "");
}
function cityZone(value) {
  return Object.values(CITIES).some(city => city.timezone === value);
}
async function executePayload(config, bearer, payload, fetchImpl) {
  return withGoogle(config, bearer, fetchImpl, async token => {
    if (payload.type === "create-rain-alert") {
      const created = await googleCall(fetchImpl, calendarEndpoint("events"), token, {
        method: "POST",
        body: JSON.stringify({
          summary: payload.summary,
          description: payload.description,
          start: payload.start,
          end: payload.end
        })
      });
      console.log(JSON.stringify({event: "calendar_write", action: "create-rain-alert", http: 200}));
      return created?.id && EVENT_ID.test(created.id) ? created.id : "";
    }
    await googleCall(fetchImpl, calendarEndpoint("events/" + payload.eventId), token, {
      method: "PATCH",
      body: JSON.stringify({start: payload.start, end: payload.end})
    });
    console.log(JSON.stringify({event: "calendar_write", action: "reschedule", http: 200}));
    return payload.eventId;
  });
}
function approvedText(profile, payload) {
  const when = payload.start.dateTime.slice(0, 16).replace("T", " ");
  return english(profile)
    ? "Approved outside the chat. Google Calendar now has \"" + payload.summary + "\" at " + when + " (" + payload.start.timeZone + ")."
    : "Aprovado fora do chat. O Google Calendar agora tem \"" + payload.summary + "\" em " + when + " (" + payload.start.timeZone + ").";
}

export async function processCalendarTurn({env, sub, bearer, profile, question, conversationId, fetchImpl = fetch, now = new Date()}) {
  const command = classifyCalendarCommand(question);
  if (!command) return null;
  const config = vetoConfig(env);
  if (!config.enabled) return outcome(disabledAnswer(profile), "veto-disabled", "unavailable");
  if (!bearer) {
    return outcome(
      english(profile) ? "The calendar agent did not receive an access token. Nothing was written." : "O agente de agenda não recebeu um token de acesso. Nada foi gravado.",
      "calendar-error",
      "unavailable"
    );
  }
  await ensureSchema(env);
  if (command.type === "invalid") return outcome(usage(profile), "calendar-error", "Google Calendar");
  if (command.type === "status") return handleStatus(env, sub, profile, now);
  if (command.type === "list") return handleList(env, config, sub, bearer, profile, fetchImpl, now);
  if (command.type === "create-rain-alert") {
    return handleRain(env, config, sub, conversationId, profile, command, fetchImpl, now);
  }
  if (command.type === "reschedule") {
    return handleReschedule(env, config, sub, conversationId, profile, command, fetchImpl, now);
  }
  return outcome(usage(profile), "calendar-error", "Google Calendar");
}

async function finish(env, sub, id, status, text) {
  await env.DB.prepare(
    "UPDATE calendar_approvals SET status=?, result_text=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_sub=?"
  ).bind(status, clip(text, 2000), id, sub).run();
}
export async function pollCalendarApproval({env, sub, bearer, profile, approvalId, fetchImpl = fetch, now = new Date()}) {
  const config = vetoConfig(env);
  if (!config.enabled) {
    return {httpStatus: 503, body: {error: english(profile) ? "Calendar agent is not configured." : "O agente de agenda não está configurado."}, persist: null};
  }
  await ensureSchema(env);
  const row = await env.DB.prepare(
    "SELECT id, conversation_id, status, payload_json, auth_req_id, interval_seconds, expires_at, next_poll_at, result_text " +
    "FROM calendar_approvals WHERE id=? AND user_sub=?"
  ).bind(approvalId, sub).first();
  if (!row) return {httpStatus: 404, body: {error: english(profile) ? "Approval request not found." : "Pedido de aprovação não encontrado."}, persist: null};
  if (row.status !== "pending") {
    return {
      httpStatus: 200,
      persist: null,
      body: {
        status: row.status === "executing" ? "pending" : row.status,
        answer: row.result_text || terminalFallback(profile, row.status),
        mode: row.status === "executing" ? "ciba-pending" : modeFor(row.status),
        retryAfterSeconds: Math.max(5, Number(row.interval_seconds) || 5)
      }
    };
  }
  if (Date.parse(row.expires_at) <= now.getTime()) {
    const answer = expiredText(profile);
    await finish(env, sub, row.id, "expired", answer);
    return {httpStatus: 200, persist: {conversationId: row.conversation_id, answer}, body: {status: "expired", answer, mode: "ciba-denied"}};
  }
  if (Date.parse(row.next_poll_at) > now.getTime()) {
    const retryAfterSeconds = Math.max(5, Math.ceil((Date.parse(row.next_poll_at) - now.getTime()) / 1000));
    return {
      httpStatus: 200,
      persist: null,
      body: {status: "pending", answer: english(profile) ? "Still waiting for approval outside the chat." : "Ainda aguardando aprovação fora do chat.", mode: "ciba-pending", retryAfterSeconds}
    };
  }
  const polled = await postForm(fetchImpl, authUrl(config, "/oauth/token"), {
    client_id: config.cibaClientId,
    client_secret: config.cibaClientSecret,
    grant_type: CIBA_GRANT,
    auth_req_id: row.auth_req_id
  });
  const cibaApproved = typeof polled.data?.access_token === "string" && polled.data.access_token.length >= 8;
  if (polled.data) {
    polled.data.access_token = "";
    polled.data.id_token = "";
    polled.data.refresh_token = "";
  }
  const code = oauthErrorCode(polled.data);
  if (code === "authorization_pending" || code === "slow_down" || (!polled.ok && !code)) {
    const interval = Math.max(5, Number(polled.data?.interval) || polled.retryAfter || Number(row.interval_seconds) || 5);
    const nextPoll = new Date(now.getTime() + interval * 1000).toISOString();
    await env.DB.prepare(
      "UPDATE calendar_approvals SET interval_seconds=?, next_poll_at=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_sub=? AND status='pending'"
    ).bind(interval, nextPoll, row.id, sub).run();
    console.log(JSON.stringify({event: "ciba_poll", result: code || "pending"}));
    return {
      httpStatus: 200,
      persist: null,
      body: {
        status: "pending",
        answer: english(profile) ? "Still waiting for approval outside the chat. Google Calendar was not changed." : "Ainda aguardando aprovação fora do chat. O Google Calendar não foi alterado.",
        mode: "ciba-pending",
        retryAfterSeconds: interval
      }
    };
  }
  if (code === "access_denied" || code === "expired_token") {
    const answer = code === "expired_token" ? expiredText(profile) : deniedText(profile);
    const status = code === "expired_token" ? "expired" : "denied";
    await finish(env, sub, row.id, status, answer);
    console.log(JSON.stringify({event: "ciba_poll", result: status}));
    return {httpStatus: 200, persist: {conversationId: row.conversation_id, answer}, body: {status, answer, mode: "ciba-denied"}};
  }
  if (!polled.ok || !cibaApproved) {
    console.error(JSON.stringify({event: "ciba_poll", result: "error", oauth: code || "unknown"}));
    return {
      httpStatus: 200,
      persist: null,
      body: {
        status: "pending",
        answer: english(profile) ? "The approval check failed temporarily. Nothing was written. Try again shortly." : "A consulta da aprovação falhou por um instante. Nada foi gravado. Tente de novo em instantes.",
        mode: "ciba-pending",
        retryAfterSeconds: Math.max(5, Number(row.interval_seconds) || 5)
      }
    };
  }
  const claimed = await env.DB.prepare(
    "UPDATE calendar_approvals SET status='executing', updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_sub=? AND status='pending'"
  ).bind(row.id, sub).run();
  if (!Number(claimed?.meta?.changes || 0)) {
    return {
      httpStatus: 200,
      persist: null,
      body: {status: "pending", answer: english(profile) ? "The approval is already being applied." : "A aprovação já está sendo aplicada.", mode: "ciba-pending", retryAfterSeconds: 5}
    };
  }
  const payload = storedPayload(row.payload_json);
  if (!payload) {
    const answer = english(profile) ? "The approved action was invalid, so it was not sent to Google Calendar." : "A ação aprovada era inválida, então não foi enviada ao Google Calendar.";
    await finish(env, sub, row.id, "error", answer);
    return {httpStatus: 200, persist: {conversationId: row.conversation_id, answer}, body: {status: "error", answer, mode: "calendar-error"}};
  }
  try {
    await executePayload(config, bearer, payload, fetchImpl);
  } catch (error) {
    const answer = error instanceof VetoError && error.code === "VAULT_EXCHANGE_FAILED"
      ? vaultAnswer(profile, error)
      : error instanceof VetoError && error.code === "GOOGLE_CALENDAR_FAILED"
        ? (english(profile) ? "You approved the action, but the calendar write failed. " : "Você aprovou a ação, mas a gravação no calendário falhou. ") + googleAnswer(profile, error)
        : (english(profile) ? "You approved the action, but it could not be finished. Check Google Calendar before trying again." : "Você aprovou a ação, mas ela não terminou. Confira o Google Calendar antes de tentar de novo.");
    await finish(env, sub, row.id, "error", answer);
    console.error(JSON.stringify({event: "calendar_write_failed", code: error instanceof Error ? error.code || error.name : "unknown"}));
    return {httpStatus: 200, persist: {conversationId: row.conversation_id, answer}, body: {status: "error", answer, mode: "calendar-error"}};
  }
  const answer = approvedText(profile, payload);
  await finish(env, sub, row.id, "approved", answer);
  return {httpStatus: 200, persist: {conversationId: row.conversation_id, answer}, body: {status: "approved", answer, mode: "ciba-approved"}};
}
