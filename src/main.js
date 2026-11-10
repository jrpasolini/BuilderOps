import { createAuth0Client } from "@auth0/auth0-spa-js";
import "./style.css";

const el = id => document.getElementById(id);
const ui = {
  auth:el("authBtn"),status:el("status"),name:el("userName"),sub:el("userSub"),
  form:el("settings"),city:el("city"),unit:el("unit"),lang:el("lang"),save:el("save"),
  connect:el("connectCalendar"),calendarHint:el("calendarHint"),
  chatForm:el("chatForm"),prompt:el("prompt"),send:el("send"),messages:el("messages"),mode:el("mode")
};
const CALENDAR_SCOPES = ["openid","profile","email","https://www.googleapis.com/auth/calendar.events"];
let auth0, profile, conversationId = null, busy = false, vetoOn = false, googleConnection = "google-oauth2";
const appReturnUrl = new URL(import.meta.env.BASE_URL, window.location.origin).href;
const explicitApi = String(import.meta.env.VITE_API_BASE_URL || "").trim().replace(/\/+$/, "");
// Verified Cloudflare account subdomain. The Worker named 'builderops' must be deployed separately.
const defaultApi = window.location.hostname.endsWith(".github.io")
  ? "https://builderops.antonio-pasolini.workers.dev"
  : window.location.origin;
const apiBase = explicitApi || defaultApi;
function apiUrl(path) { return new URL(path, apiBase).href; }


function status(message) { ui.status.textContent = message; }
function bubble(text, role="assistant") {
  const element=document.createElement("div");
  element.className="bubble " + role;
  element.textContent=text;
  ui.messages.append(element);
  ui.messages.scrollTop=ui.messages.scrollHeight;
}
function enable(enabled) {
  for (const x of [ui.city,ui.unit,ui.lang,ui.save,ui.prompt,ui.send]) x.disabled=!enabled;
  ui.connect.hidden = !(enabled && vetoOn);
  ui.calendarHint.hidden = !vetoOn;
}
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function modeLabel(mode) {
  const labels = {
    "workers-ai": "Workers AI · DeepSeek R1",
    "calendar-read": "Agenda · Token Vault",
    "ciba-pending": "CIBA · aguardando",
    "ciba-approved": "CIBA · aprovado",
    "ciba-denied": "CIBA · encerrado",
    "veto-disabled": "Agenda desligada",
    "calendar-error": "Agenda · erro"
  };
  return labels[mode] || "Fluxo verificado";
}
async function watchApproval(approval) {
  if (!approval || !/^[0-9a-f-]{36}$/i.test(approval.id || "")) return;
  const deadline = Date.now() + Math.min((approval.expiresInSeconds || 180) * 1000, 190000);
  let wait = approval.retryAfterSeconds || 5;
  while (Date.now() < deadline) {
    await sleep(Math.min(Math.max(wait, 5), 60) * 1000);
    const result = await api("/api/calendar/approvals/" + approval.id, {method:"POST"});
    if (result.status === "pending") {
      wait = result.retryAfterSeconds || wait;
      continue;
    }
    ui.mode.textContent = modeLabel(result.mode);
    bubble(result.answer || "Pedido de aprovação encerrado.");
    return;
  }
  bubble("Ainda sem resposta fora do chat. Quando aprovar ou recusar, envie: status da aprovação");
}
async function api(path, options={}) {
  const token=await auth0.getTokenSilently();
  const response=await fetch(apiUrl(path),{
    ...options,
    headers:{
      authorization:"Bearer " + token,
      ...(options.body ? {"content-type":"application/json"} : {}),
      ...options.headers
    }
  });
  const data=await response.json().catch(()=>({}));
  if (!response.ok) throw new Error(data.error || "HTTP " + response.status);
  return data;
}
function setProfile(value) {
  profile=value;
  ui.city.value=value.preferred_city;
  ui.unit.value=value.temperature_unit;
  ui.lang.value=value.response_language;
}
async function loginState() {
  if (!await auth0.isAuthenticated()) {
    enable(false); status("Não autenticado"); ui.auth.textContent="Entrar com Auth0"; return;
  }
  const user=await auth0.getUser();
  ui.name.textContent=user?.nickname || user?.name || "Usuário autenticado";
  ui.sub.textContent=user?.sub ? user.sub.slice(0,20) + "…" : "Auth0 session";
  ui.auth.textContent="Sair";
  status("Sessão autenticada");
  setProfile(await api("/api/profile"));
  enable(true);
  bubble("Perfil carregado: " + profile.city_name + ". Você pode alterar preferências e perguntar sobre o tempo.");
}
async function init() {
  try {
    const response=await fetch(apiUrl("/api/config"),{cache:"no-store"});
    const config=await response.json();
    if (!config.ready) {
      status("Configurar Auth0 primeiro");
      ui.auth.disabled=true;
      bubble("Configure os identificadores públicos AUTH0_DOMAIN, AUTH0_CLIENT_ID e AUTH0_AUDIENCE no projeto.");
      return;
    }
    vetoOn = Boolean(config.veto);
    googleConnection = typeof config.googleConnection === "string" && config.googleConnection ? config.googleConnection : "google-oauth2";
    ui.calendarHint.hidden = !vetoOn;
    auth0=await createAuth0Client({
      domain:config.domain,
      clientId:config.clientId,
      authorizationParams:{redirect_uri:appReturnUrl,audience:config.audience},
      cacheLocation:"memory",
      useRefreshTokens:vetoOn,
      ...(vetoOn ? {useMrrt:true, useDpop:true} : {})
    });
    const search=new URLSearchParams(window.location.search);
    if (search.has("code") && search.has("state")) {
      await auth0.handleRedirectCallback();
      window.history.replaceState({},document.title,appReturnUrl);
    } else if (vetoOn && search.has("connect_code") && search.has("state")) {
      const connected = await auth0.handleRedirectCallback();
      window.history.replaceState({},document.title,appReturnUrl);
      bubble(connected?.connection ? "Google Calendar conectado (" + connected.connection + ")." : "Conexão do calendário concluída.");
    } else if (vetoOn && search.has("error") && search.has("state") && !search.has("code")) {
      const code = search.get("error") || "";
      window.history.replaceState({},document.title,appReturnUrl);
      bubble("A conexão do Google Calendar não foi concluída" + (/^[a-z0-9_]+$/i.test(code) ? " (" + code + ")." : "."));
    }
    ui.connect.addEventListener("click", async () => {
      if (!auth0?.connectAccountWithRedirect) {
        bubble("O SDK do Auth0 neste navegador não expõe a conexão de contas.");
        return;
      }
      await auth0.connectAccountWithRedirect({
        connection: googleConnection,
        scopes: CALENDAR_SCOPES,
        redirectUri: appReturnUrl
      });
    });
    ui.auth.addEventListener("click",async()=>{
      if (await auth0.isAuthenticated()) {
        await auth0.logout({logoutParams:{returnTo:appReturnUrl}});
      } else {
        await auth0.loginWithRedirect();
      }
    });
    await loginState();
  } catch(e) {
    status("API ou login indisponível");
    bubble("Não foi possível iniciar o assistente. Confira o Worker e a configuração Auth0. Detalhe: " + e.message);
  }
}
ui.form.addEventListener("submit",async(e)=>{
  e.preventDefault();
  ui.save.disabled=true;
  try {
    const updated=await api("/api/profile",{
      method:"PUT",
      body:JSON.stringify({
        preferred_city:ui.city.value,
        temperature_unit:ui.unit.value,
        response_language:ui.lang.value
      })
    });
    setProfile(updated);
    bubble("Preferências salvas para esta identidade: " + updated.city_name + ".");
  } catch(e) { bubble("Erro ao salvar: " + e.message); }
  finally { ui.save.disabled=false; }
});
ui.chatForm.addEventListener("submit",async(e)=>{
  e.preventDefault();
  const message=ui.prompt.value.trim();
  if (!message || busy || !auth0) return;
  busy=true; ui.send.disabled=true; ui.prompt.value="";
  bubble(message,"user");
  try {
    const result=await api("/api/chat",{
      method:"POST",body:JSON.stringify({message,conversationId})
    });
    conversationId=result.conversationId;
    ui.mode.textContent=modeLabel(result.mode);
    bubble(result.answer);
    if (result.approval?.status==="pending") await watchApproval(result.approval);
  } catch(e) { bubble("Não foi possível responder: " + e.message); }
  finally { busy=false; ui.send.disabled=false; ui.prompt.focus(); }
});
init();
