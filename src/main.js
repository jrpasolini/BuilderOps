import { createAuth0Client } from "@auth0/auth0-spa-js";
import "./style.css";

const el = id => document.getElementById(id);
const ui = {
  auth:el("authBtn"),status:el("status"),name:el("userName"),sub:el("userSub"),
  form:el("settings"),city:el("city"),unit:el("unit"),lang:el("lang"),save:el("save"),
  chatForm:el("chatForm"),prompt:el("prompt"),send:el("send"),messages:el("messages"),mode:el("mode")
};
let auth0, profile, conversationId = null, busy = false;

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
}
async function api(path, options={}) {
  const token=await auth0.getTokenSilently();
  const response=await fetch(path,{
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
    const response=await fetch("/api/config",{cache:"no-store"});
    const config=await response.json();
    if (!config.ready) {
      status("Configurar Auth0 primeiro");
      ui.auth.disabled=true;
      bubble("Configure os identificadores públicos AUTH0_DOMAIN, AUTH0_CLIENT_ID e AUTH0_AUDIENCE no projeto.");
      return;
    }
    auth0=await createAuth0Client({
      domain:config.domain,
      clientId:config.clientId,
      authorizationParams:{redirect_uri:window.location.origin,audience:config.audience},
      cacheLocation:"memory",
      useRefreshTokens:false
    });
    const search=new URLSearchParams(window.location.search);
    if (search.has("code") && search.has("state")) {
      await auth0.handleRedirectCallback();
      window.history.replaceState({},document.title,window.location.pathname);
    }
    ui.auth.addEventListener("click",async()=>{
      if (await auth0.isAuthenticated()) {
        await auth0.logout({logoutParams:{returnTo:window.location.origin}});
      } else {
        await auth0.loginWithRedirect();
      }
    });
    await loginState();
  } catch(e) {
    status("Falha no login");
    bubble("Falha na autenticação: " + e.message);
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
    ui.mode.textContent=result.mode==="llm" ? "DeepSeek + tools" : "Fluxo verificado";
    bubble(result.answer);
  } catch(e) { bubble("Não foi possível responder: " + e.message); }
  finally { busy=false; ui.send.disabled=false; ui.prompt.focus(); }
});
init();
