import { createRemoteJWKSet, jwtVerify } from "jose";
import { CITIES, DEFAULT_PROFILE, validSettings, weatherUrl, formatWeather } from "./shared.js";

const responseHeaders = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff"
};
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: responseHeaders });
const fail = (status, message) => json({error: message}, status);
const jwksCache = new Map();

function authConfig(env) {
  const domain = String(env.AUTH0_DOMAIN || "");
  if (!/^[a-z0-9][a-z0-9.-]*\.auth0\.com$/i.test(domain) || domain.includes("REPLACE")) {
    throw new Error("AUTH_CONFIG_MISSING");
  }
  if (!env.AUTH0_AUDIENCE || String(env.AUTH0_AUDIENCE).includes("example")) {
    throw new Error("AUTH_CONFIG_MISSING");
  }
  return { domain, issuer: "https://" + domain + "/", audience: env.AUTH0_AUDIENCE };
}
async function authenticatedSubject(request, env) {
  const header = request.headers.get("authorization") || "";
  if (!header.startsWith("Bearer ")) throw new Error("AUTH_REQUIRED");
  const { domain, issuer, audience } = authConfig(env);
  if (!jwksCache.has(domain)) {
    jwksCache.set(domain, createRemoteJWKSet(new URL(issuer + ".well-known/jwks.json")));
  }
  try {
    const { payload } = await jwtVerify(header.slice(7), jwksCache.get(domain), {
      issuer, audience, algorithms: ["RS256"]
    });
    if (typeof payload.sub !== "string" || !payload.sub) throw new Error("Missing subject");
    return payload.sub;
  } catch {
    throw new Error("TOKEN_INVALID");
  }
}
async function profileFor(env, sub) {
  let profile = await env.DB.prepare(
    "SELECT preferred_city, temperature_unit, response_language FROM profiles WHERE user_sub=?"
  ).bind(sub).first();
  if (!profile) {
    await env.DB.prepare("INSERT OR IGNORE INTO profiles (user_sub) VALUES (?)").bind(sub).run();
    profile = await env.DB.prepare(
      "SELECT preferred_city, temperature_unit, response_language FROM profiles WHERE user_sub=?"
    ).bind(sub).first();
  }
  return profile || DEFAULT_PROFILE;
}
async function firstPartyProfile(env, sub) {
  // The same protected service backs GET /api/profile and the assistant tool.
  // Subject is derived from the verified Auth0 token, never from the request body.
  const data = await profileFor(env, sub);
  return { ...data, city_name: CITIES[data.preferred_city]?.name || CITIES.vitoria.name };
}
async function updateProfile(request, env, sub) {
  let value;
  try { value = await request.json(); } catch { return fail(400, "JSON inválido"); }
  if (!validSettings(value)) return fail(400, "Preferências inválidas");
  await env.DB.prepare(
    "INSERT INTO profiles (user_sub,preferred_city,temperature_unit,response_language) VALUES (?,?,?,?) " +
    "ON CONFLICT(user_sub) DO UPDATE SET preferred_city=excluded.preferred_city, " +
    "temperature_unit=excluded.temperature_unit,response_language=excluded.response_language,updated_at=CURRENT_TIMESTAMP"
  ).bind(sub,value.preferred_city,value.temperature_unit,value.response_language).run();
  return json(await firstPartyProfile(env,sub));
}
async function weatherTool(profile) {
  const res = await fetch(weatherUrl(profile), {
    headers: {accept: "application/json"}, signal: AbortSignal.timeout(6500)
  });
  if (!res.ok) throw new Error("Weather provider HTTP " + res.status);
  const weather = await res.json();
  return { city: CITIES[profile.preferred_city].name, weather, summary: formatWeather(profile, weather) };
}
async function modelAnswer(env, profile, weather, question, history) {
  if (!env.LLM_API_KEY) return null;
  const system = "You are BuilderOps, a concise assistant. Write in " + profile.response_language +
    ". Only use verified profile and weather readings. Do not claim to have performed other actions. " +
    "Never reveal security tokens. State that Open-Meteo is the weather source. Verified profile: " +
    JSON.stringify(profile) + ". Weather: " +
    JSON.stringify({city:weather.city,current:weather.weather.current,current_units:weather.weather.current_units});
  const messages = [
    {role:"system",content:system},
    ...history.slice(-8).filter(x => ["user","assistant"].includes(x.role)).map(
      x => ({role:x.role,content:String(x.content).slice(0,1200)})
    ),
    {role:"user",content:question}
  ];
  const res = await fetch("https://api.deepseek.com/chat/completions", {
    method:"POST",
    headers:{"content-type":"application/json",authorization:"Bearer " + env.LLM_API_KEY},
    body:JSON.stringify({model:env.LLM_MODEL || "deepseek-chat",messages,temperature:0.3,max_tokens:280}),
    signal:AbortSignal.timeout(12000)
  });
  if (!res.ok) throw new Error("Model unavailable");
  const payload = await res.json();
  const answer = payload?.choices?.[0]?.message?.content;
  return typeof answer === "string" && answer.trim() ? answer.trim().slice(0,2400) : null;
}
async function chat(request, env, sub) {
  let input;
  try { input = await request.json(); } catch { return fail(400, "JSON inválido"); }
  const question = typeof input?.message === "string" ? input.message.trim() : "";
  if (!question || question.length > 600) return fail(400, "Mensagem deve ter 1–600 caracteres");
  const priorId = typeof input.conversationId === "string" ? input.conversationId : "";
  if (priorId && !/^[0-9a-f-]{36}$/i.test(priorId)) return fail(400, "ID inválido");
  const id = priorId || crypto.randomUUID();
  if (priorId) {
    const owned = await env.DB.prepare(
      "SELECT id FROM conversations WHERE id=? AND user_sub=?"
    ).bind(id,sub).first();
    if (!owned) return fail(404, "Conversa não encontrada");
  } else {
    await env.DB.prepare("INSERT INTO conversations (id,user_sub) VALUES (?,?)").bind(id,sub).run();
  }
  const profile = await firstPartyProfile(env,sub);
  const previous = await env.DB.prepare(
    "SELECT role,content FROM messages WHERE user_sub=? AND conversation_id=? " +
    "ORDER BY created_at DESC,rowid DESC LIMIT 8"
  ).bind(sub,id).all();
  await env.DB.prepare(
    "INSERT INTO messages (id,conversation_id,user_sub,role,content) VALUES (?,?,?,?,?)"
  ).bind(crypto.randomUUID(),id,sub,"user",question).run();
  let tool;
  try { tool = await weatherTool(profile); } catch { tool = null; }
  let answer;
  let mode = "deterministic";
  if (!tool) {
    answer = profile.response_language === "en-US"
      ? "I found your preference for " + profile.city_name + ", but the weather service is currently unavailable."
      : "Encontrei sua preferência por " + profile.city_name + ", mas a API meteorológica está indisponível.";
  } else {
    try {
      const generated = await modelAnswer(env,profile,tool,question,(previous.results || []).reverse());
      if (generated) { answer = generated; mode = "llm"; }
    } catch { /* Do not leak upstream provider or token errors to the browser. */ }
    if (!answer) {
      answer = tool.summary + " " + (profile.response_language === "en-US"
        ? "I used your authenticated profile settings and queried the public weather API."
        : "Usei suas preferências da API autenticada e consultei a API pública de previsão do tempo.");
    }
  }
  await env.DB.prepare(
    "INSERT INTO messages (id,conversation_id,user_sub,role,content) VALUES (?,?,?,?,?)"
  ).bind(crypto.randomUUID(),id,sub,"assistant",answer).run();
  await env.DB.prepare(
    "UPDATE conversations SET updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_sub=?"
  ).bind(id,sub).run();
  return json({conversationId:id,answer,mode,profileUsed:profile,thirdParty:tool?"Open-Meteo":"unavailable"});
}
async function history(request, env, sub) {
  const id = new URL(request.url).searchParams.get("id") || "";
  if (!/^[0-9a-f-]{36}$/i.test(id)) return fail(400,"ID inválido");
  const owned = await env.DB.prepare("SELECT id FROM conversations WHERE id=? AND user_sub=?")
    .bind(id,sub).first();
  if (!owned) return fail(404,"Conversa não encontrada");
  const rows = await env.DB.prepare(
    "SELECT role,content,created_at FROM messages WHERE conversation_id=? AND user_sub=? " +
    "ORDER BY created_at,rowid LIMIT 100"
  ).bind(id,sub).all();
  return json({conversationId:id,messages:rows.results});
}
export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === "/api/config" && request.method === "GET") {
      const ready = !String(env.AUTH0_CLIENT_ID || "").startsWith("REPLACE") &&
        !String(env.AUTH0_DOMAIN || "").startsWith("REPLACE") &&
        !String(env.AUTH0_AUDIENCE || "").includes("example");
      return json({domain:env.AUTH0_DOMAIN,clientId:env.AUTH0_CLIENT_ID,audience:env.AUTH0_AUDIENCE,ready});
    }
    if (path === "/api/health" && request.method === "GET") {
      return json({ok:true,service:"builderops",version:"0.1.0"});
    }
    if (!path.startsWith("/api/")) return fail(404,"Not found");
    let sub;
    try {
      sub = await authenticatedSubject(request,env);
    } catch(e) {
      return fail(e.message === "AUTH_REQUIRED" || e.message === "TOKEN_INVALID" ? 401 : 503,
        "Autenticação necessária ou inválida");
    }
    try {
      if (path === "/api/profile" && request.method === "GET") return json(await firstPartyProfile(env,sub));
      if (path === "/api/profile" && request.method === "PUT") return updateProfile(request,env,sub);
      if (path === "/api/chat" && request.method === "POST") return chat(request,env,sub);
      if (path === "/api/history" && request.method === "GET") return history(request,env,sub);
      return fail(404,"Rota não encontrada");
    } catch(e) {
      console.error(JSON.stringify({event:"api_error",route:path,error_type:e instanceof Error?e.name:"unknown"}));
      return fail(500,"Erro interno. Verifique configuração e banco D1.");
    }
  }
};
