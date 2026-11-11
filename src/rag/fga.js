// Auth0 FGA over plain HTTPS. Tokens and client secrets stay in this module's
// memory for one Worker isolate. They are not returned to the browser.

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
const CLIENT_ID = /^[A-Za-z0-9_-]{8,128}$/;
const API_HOST = /^api\.(us1|eu1|au1)\.fga\.dev$/;
const SUB = /^[A-Za-z0-9_|.:@-]{1,128}$/;
const tokenCache = new Map();

function explicitlyOff(env) {
  const flag = String(env?.RAG_AGENT || "auto").trim().toLowerCase();
  return flag === "off" || flag === "false" || flag === "0";
}
function httpsOrigin(value, hostOk, pathOk) {
  try {
    const url = new URL(String(value || ""));
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return "";
    if (!hostOk(url.hostname) || !pathOk(url.pathname)) return "";
    return url.origin;
  } catch {
    return "";
  }
}
export function normalizeSub(value) {
  let sub = String(value || "").trim();
  if (sub.toLowerCase().startsWith("user:")) sub = sub.slice(5);
  if (!SUB.test(sub) || sub.includes("*")) return "";
  return sub;
}
export function ragConfig(env) {
  if (explicitlyOff(env)) return {enabled: false};
  const storeId = String(env?.FGA_STORE_ID || "").trim();
  const clientId = String(env?.FGA_CLIENT_ID || "").trim();
  const clientSecret = String(env?.FGA_CLIENT_SECRET || "");
  const modelId = String(env?.FGA_MODEL_ID || "").trim();
  const apiOrigin = httpsOrigin(env?.FGA_API_URL || "https://api.us1.fga.dev", host => API_HOST.test(host), path => path === "" || path === "/");
  const audienceOrigin = httpsOrigin(env?.FGA_API_AUDIENCE || "https://api.us1.fga.dev/", host => API_HOST.test(host), path => path === "/");
  const tokenOrigin = httpsOrigin(env?.FGA_TOKEN_URL || "https://auth.fga.dev/oauth/token", host => host === "auth.fga.dev", path => path === "/oauth/token");
  const secretOk = clientSecret.length >= 16 && clientSecret.length <= 500 && !/replace|your_|changeme|example/i.test(clientSecret);
  const modelOk = modelId === "" || ULID.test(modelId);
  if (!ULID.test(storeId) || !CLIENT_ID.test(clientId) || !secretOk || !modelOk || !apiOrigin || !audienceOrigin || !tokenOrigin) {
    return {enabled: false};
  }
  let tokenUrl;
  try { tokenUrl = new URL(String(env?.FGA_TOKEN_URL || "https://auth.fga.dev/oauth/token")).href; }
  catch { return {enabled: false}; }
  return {
    enabled: true,
    storeId,
    clientId,
    clientSecret,
    modelId,
    apiUrl: apiOrigin,
    audience: audienceOrigin + "/",
    tokenUrl,
    embedModel: String(env?.AI_EMBED_MODEL || "@cf/baai/bge-m3"),
    chatModel: String(env?.AI_MODEL || "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b")
  };
}
export function ragPublicConfig(env) {
  return {enabled: ragConfig(env).enabled};
}
export function resetFgaState() {
  tokenCache.clear();
}
async function readJson(response, limit) {
  const text = await response.text();
  if (text.length > limit) return null;
  if (!text) return {};
  try { return JSON.parse(text); } catch { return null; }
}
function storeUrl(config, suffix) {
  const url = new URL("/stores/" + config.storeId + "/" + suffix, config.apiUrl);
  if (url.origin !== config.apiUrl || !url.pathname.startsWith("/stores/" + config.storeId + "/")) {
    throw new Error("FGA_URL");
  }
  return url;
}
export async function fetchFgaToken(config, fetchImpl) {
  const key = config.tokenUrl + "\0" + config.clientId;
  const cached = tokenCache.get(key);
  if (cached && cached.until > Date.now()) return cached.token;
  const response = await fetchImpl(config.tokenUrl, {
    method: "POST",
    redirect: "manual",
    headers: {"content-type": "application/json", accept: "application/json"},
    body: JSON.stringify({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      audience: config.audience,
      grant_type: "client_credentials"
    }),
    signal: AbortSignal.timeout(8000)
  });
  if (response.status >= 300 && response.status < 400) throw new Error("FGA_REDIRECT");
  const data = await readJson(response, 20000);
  const token = data?.access_token;
  if (!response.ok || typeof token !== "string" || token.length < 8) throw new Error("FGA_TOKEN");
  const ttl = Number(data.expires_in);
  const seconds = Number.isFinite(ttl) && ttl > 60 ? ttl - 30 : 45;
  tokenCache.set(key, {token, until: Date.now() + seconds * 1000});
  return token;
}
function errorMessage(item) {
  const message = item?.error?.message;
  return typeof message === "string" ? message.trim() : "";
}
function decisionsFrom(payload, checks) {
  const result = payload?.result;
  const decisions = new Map();
  if (Array.isArray(result)) {
    result.forEach((item, index) => {
      const id = typeof item?.correlation_id === "string" ? item.correlation_id : checks[index]?.correlation_id;
      if (id) decisions.set(id, item?.allowed === true && !errorMessage(item));
    });
  } else if (result && typeof result === "object") {
    for (const [id, item] of Object.entries(result)) {
      decisions.set(id, item?.allowed === true && !errorMessage(item));
    }
  } else {
    return null;
  }
  for (const check of checks) {
    if (!decisions.has(check.correlation_id)) return null;
  }
  return decisions;
}
export async function batchCheckViewer({config, token, sub, documentIds, fetchImpl}) {
  const userId = normalizeSub(sub);
  if (!userId) return {ok: false};
  if (!documentIds.length) return {ok: true, allowed: new Set()};
  const checks = documentIds.map(id => ({
    tuple_key: {user: "user:" + userId, relation: "viewer", object: "document:" + id},
    correlation_id: id
  }));
  const body = {checks, consistency: "HIGHER_CONSISTENCY"};
  if (config.modelId) body.authorization_model_id = config.modelId;
  const response = await fetchImpl(storeUrl(config, "batch-check"), {
    method: "POST",
    redirect: "manual",
    headers: {
      authorization: "Bearer " + token,
      "content-type": "application/json",
      accept: "application/json"
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok || (response.status >= 300 && response.status < 400)) return {ok: false};
  const decisions = decisionsFrom(await readJson(response, 100000), checks);
  if (!decisions) return {ok: false};
  const allowed = new Set();
  for (const [id, isAllowed] of decisions) if (isAllowed) allowed.add(id);
  return {ok: true, allowed};
}
export async function writeTuples(config, tuples, fetchImpl) {
  const token = await fetchFgaToken(config, fetchImpl);
  const response = await fetchImpl(storeUrl(config, "write"), {
    method: "POST",
    redirect: "manual",
    headers: {
      authorization: "Bearer " + token,
      "content-type": "application/json",
      accept: "application/json"
    },
    body: JSON.stringify({
      writes: {tuple_keys: tuples, on_duplicate: "ignore"},
      ...(config.modelId ? {authorization_model_id: config.modelId} : {})
    }),
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok || (response.status >= 300 && response.status < 400)) throw new Error("FGA_WRITE");
  return {count: tuples.length};
}
