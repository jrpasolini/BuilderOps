# MLH Builders Week 2026 — The Veto Agent

Token Vault and asynchronous authorization, in the same repository as the Context-Preserving Assistant.

The weather flow (Auth0 Universal Login, `GET /api/profile` on D1 keyed by the JWT `sub`, Open-Meteo, Workers AI, GitHub Pages at `https://jrpasolini.github.io/BuilderOps/`, Worker at `https://builderops.antonio-pasolini.workers.dev`) keeps working when the new secrets are absent. Calendar code runs only when `vetoConfig()` in `src/veto.js` sees a valid Auth0 domain plus the four Worker secrets, and `VETO_AGENT` is not `off`.

This phase does not include the owner's Auth0 or Google Cloud dashboard. The end-to-end demo cannot be completed until the checklist below is done by hand.

## What the demo must show

1. The signed-in user connects Google Calendar. Auth0 stores that provider's access token and refresh token in Token Vault. BuilderOps never writes them to D1.
2. `agenda` lists upcoming events and attaches the Open-Meteo forecast for each date the forecast can cover.
3. A write (`criar lembrete de chuva` or `reagendar N para AAAA-MM-DDTHH:MM`) does not call the Google write API first. The Worker starts CIBA, the chat says the action is paused, and the user gets a Guardian push or an approval email.
4. After approval, the Worker exchanges the user's API access token at Token Vault and only then creates or moves the event.
5. Denial, expiry, or a missed timeout leaves the calendar unchanged and says so in the chat.

## Architecture

```text
GitHub Pages (auth0-spa-js)
  Bearer access token, audience https://builderops-api
  When veto is on, the SDK also uses a refresh token, MRRT and DPoP
  so it can call the My Account API and run connectAccountWithRedirect.
        |
        |  Google consent. Tokens stay in Auth0 Token Vault.
        v
Cloudflare Worker  (jose + Auth0 JWKS, RS256, issuer, audience, exp, sub)
  weather text  -> existing /api/chat path (D1 profile, Open-Meteo, Workers AI)
  agenda        -> POST /oauth/token  (access-token exchange)
                 -> GET Google Calendar events
                 -> GET Open-Meteo forecast
  write         -> POST /bc-authorize
                 -> store auth_req_id in D1, return pending
                 -> browser POST /api/calendar/approvals/:id
                 -> Worker POST /oauth/token with the CIBA grant (poll)
                 -> on approval only: Token Vault exchange, then Calendar POST or PATCH
```

D1 tables added by `db/002_veto.sql` (also created on first use):

- `calendar_snapshots` — event id, title, start, end, for the signed-in `sub` only
- `calendar_approvals` — the action payload and the CIBA `auth_req_id`

Google tokens are held in memory for one `fetch` and then dropped. The CIBA access token is treated as the approval signal and is not sent to Google and not stored. `auth_req_id` is stored because the Worker must poll, and it is not returned to the browser or written to logs.

Writes are recognized by an exact command parser. The language model has no calendar tool, so a prompt in an event title cannot start a write.

Open-Meteo accepts `forecast_days` from 1 to 16 and the first daily row is today, so the last forecast date is 15 days ahead. A past date or a later date is explained. A reminder is not created outside that window. Inside the window, the write still waits for CIBA. At or above 40% precipitation probability the event title is "Alerta de chuva"; below that it is "Lembrete de tempo". The new time for a moved event is interpreted in the preferred city's timezone.

Commands, exactly, optional final period:

| Command | Effect |
|---|---|
| `agenda`, `meus eventos`, `list events`, `my calendar` | Read |
| `criar lembrete de chuva` | Write, tomorrow in the preferred city |
| `criar lembrete de chuva em AAAA-MM-DD` | Write for that date |
| `create rain reminder` / `create rain reminder on YYYY-MM-DD` | Same, English |
| `reagendar N para AAAA-MM-DDTHH:MM` | Write. `N` comes from the last `agenda` list |
| `reschedule N to YYYY-MM-DDTHH:MM` | Same, English |
| `status da aprovação` / `approval status` | Poll the latest request again |
| `Como está o tempo na minha cidade?` | Not a calendar command. Existing weather path |

`N` is 1–8. All-day events are refused before CIBA. A second write while one request is still pending does not start another CIBA call.

## How this maps to Auth0

Researched 2026-11-10 from the current Auth0 docs. The Worker speaks HTTP. It does not load `@auth0/ai` or `googleapis`.

### Token Vault and Connected Accounts

- Connected Accounts, not the social login `/authorize` flow, is what stores the Google access token and refresh token in Token Vault: https://auth0.com/docs/secure/call-apis-on-users-behalf/token-vault/connected-accounts-for-token-vault
- Google connection setup, including Offline Access: https://auth0.com/ai/docs/connections/google
- Calling third-party APIs on the user's behalf (Auth0 for AI Agents): https://auth0.com/ai/docs/get-started/call-third-party-apis-on-users-behalf
- The SPA starts the link with `connectAccountWithRedirect` (auth0-spa-js 2.6+, DPoP retry in 2.7). This repo depends on `^2.7.0`. Example: https://github.com/auth0/auth0-spa-js/blob/main/examples/token-vault.md
- With veto on, the SDK cache is `localStorage` so the refresh token survives the Connected Accounts redirect, protected by DPoP. The BuilderOps API needs **Allow Offline Access**, and the My Account API default policy may require MFA, so the tenant MFA policy is set to **Always**. With veto off the cache stays `memory`.
- My Account API audience is `https://{tenant}/me/` with `create:me:connected_accounts`, `read:me:connected_accounts` and `delete:me:connected_accounts`: https://auth0.com/docs/manage-users/my-account-api
- The browser does not send its refresh token to the Worker. The Worker therefore uses the **access token exchange**, with the Custom API Client of the API `https://builderops-api`: https://auth0.com/docs/secure/call-apis-on-users-behalf/token-vault/access-token-exchange-with-token-vault
- Grant: `urn:auth0:params:oauth:grant-type:token-exchange:federated-connection-access-token`
- Subject token type: `urn:ietf:params:oauth:token-type:access_token`
- Requested token type: `http://auth0.com/oauth/token-type/federated-connection-access-token`
- Connection: `google-oauth2` unless `AUTH0_GOOGLE_CONNECTION` is changed
- Configuring the Token Vault grant and the Custom API Client: https://auth0.com/docs/secure/call-apis-on-users-behalf/token-vault/configure-token-vault
- Refresh-token exchange exists, but it needs the Auth0 refresh token on a confidential client. This SPA does not forward that token. Reference only: https://auth0.com/docs/secure/call-apis-on-users-behalf/token-vault/refresh-token-exchange-with-token-vault

The connect call asks Google for `openid`, `profile`, `email` and `https://www.googleapis.com/auth/calendar.events`. Runtime scopes replace the scopes selected on the connection, except `offline_access`, which still has to be enabled on the connection. `calendar.events` can read and write events. The broader `https://www.googleapis.com/auth/calendar` scope is not requested.

`calendar.events` is a sensitive Google scope. Until Google verifies the consent screen, the app is limited to test users (Auth0's Google guide also notes the 100-login cap for sensitive scopes).

### CIBA

- Overview, including the poll diagram and the plan requirement: https://auth0.com/docs/get-started/authentication-and-authorization-flow/client-initiated-backchannel-authentication-flow
- Guardian push, `/bc-authorize`, `/oauth/token`, `authorization_pending`, `slow_down`, `access_denied`: https://auth0.com/docs/get-started/authentication-and-authorization-flow/client-initiated-backchannel-authentication-flow/mobile-push-notifications-with-ciba
- Enable the grant and the channel: https://auth0.com/docs/get-started/applications/configure-client-initiated-backchannel-authentication
- Poll API: https://auth0.com/docs/api/authentication/login/check-back-channel-login-status

The Worker sends `login_hint` as JSON `{"format":"iss_sub","iss":"https://{tenant}/","sub":"<jwt sub>"}`, `scope=openid`, and a `binding_message` of at most 64 characters from the set `A–Z a–z 0–9 + - _ . , : #`. Guardian uses `requested_expiry=300` (the docs say 300 or lower selects push). Email uses `requested_expiry=3600` (the docs say 301 through 259200 selects email).

Auth0 documents **poll** mode for the consumption device. The client polls `/oauth/token` with `grant_type=urn:openid:params:grant-type:ciba` and `auth_req_id`, waiting at least the returned `interval` (about 5 seconds). `slow_down` and `Retry-After` increase the wait. This Worker does one poll per browser request so a Cloudflare invocation is not held open for minutes.

The OpenID CIBA spec also defines ping and push, where the authorization server calls the client. Auth0's published pages do not document a callback URL or a ping/push mode for the consumption device. "Push" in those pages is the Guardian notification to the phone. If the dashboard has an undocumented ping setting, it is unused here.

A successful CIBA response is an Auth0 access token for `openid`, not a Google token. The Worker discards it and performs the Calendar write with a fresh Token Vault exchange of the user's API access token.

Limits stated by Auth0: 500 CIBA requests per minute per tenant, 5000 pending requests, and 5 requests per minute per user.

### Cloudflare Worker

`fetch` to three hosts only: the configured `*.auth0.com` tenant, `https://www.googleapis.com/calendar/v3/calendars/primary/...`, and `https://api.open-meteo.com`. Event ids placed in the Calendar path must match `^[A-Za-z0-9_-]{1,1024}$`. JWT checks are unchanged. Every D1 read and write for calendar state includes the verified `sub`.

`bindings.secret()` is intentionally not declared. The cf config marks a `secret()` binding as required, which can block a deploy of the existing assistant before the secrets exist. See the uncertainty list.

## Paid plan and other hard limits

Checked against https://auth0.com/pricing and the CIBA pages above.

| Capability | What the public docs say |
|---|---|
| CIBA | **Not on Free.** Pricing table: Essentials and Professional are "ADD-ON"; Enterprise is "Included + ADD-ON". Every CIBA doc says an Enterprise plan or an appropriate add-on. |
| Guardian push | The push page says it is available for all Enterprise plans. `requested_expiry` of 300 or lower selects this channel, and the request fails if MFA push is not configured and email is not available as a fallback. |
| CIBA email | The configure-CIBA page says email needs the **Auth0 for AI Agents add-on on a paid plan**. The user needs a verified email. Template: Branding > Email Templates > Asynchronous Approval. |
| Token Vault quota | Pricing table "Token Vault": Free 2, Essentials 3 + add-on, Professional 3 + add-on, Enterprise 4 + add-on. The add-on is described as "Unlimited Token Vault". The page does not say what the number counts. |
| MFA policy Always | The Token Vault configuration page says a tenant MFA policy of Always must be set back to Never or the Vault exchange fails. |
| Google sensitive scope | `calendar.events` needs the consent screen. Unverified apps are limited to test users. |

The Okta service-specific terms (the April 30, 2026 revision) say the base CIBA service on Enterprise includes the Guardian app and SDK channels, and that the Auth0 for AI Agents add-on is what adds email and other channels. Treat that as supporting detail; the Auth0 docs above are the operational source.

A Free tenant can hold the code and can possibly complete a Token Vault **read** inside the Free quota. It cannot complete the challenge's approval step until CIBA is entitled.

## Checklist (português)

Faça nesta ordem. Não cole segredo em arquivo commitado, em issue, ou em log. O tenant deste repositório é `dev-1pvf63u214jb5oi8.us.auth0.com`. A API já publicada é `https://builderops-api`. O callback do site é `https://jrpasolini.github.io/BuilderOps/`.

### 0. Antes de começar

- [ ] Confirme o plano. Se o tenant for Free, o passo de aprovação (CIBA) não vai funcionar. Push do Guardian: Enterprise ou add-on. E-mail: add-on Auth0 for AI Agents em plano pago. Token Vault no Free tem cota; a página de preço não explica a unidade do número 2.
- [ ] Não mude o aplicativo SPA nem os callbacks que já servem o desafio do assistente de contexto, fora dos itens explícitos abaixo.
- [ ] Tenha um celular para o app Auth0 Guardian, ou um e-mail verificado se for usar o canal de e-mail.

### 1. Google Cloud — cliente OAuth do Calendar

1. Abra https://console.cloud.google.com/ e crie ou escolha um projeto.
2. Em **APIs e serviços > Biblioteca**, ative **Google Calendar API**. https://developers.google.com/calendar/api/guides/overview
3. Em **Google Auth Platform > Branding**, em Authorized domains, coloque `auth0.com`. Se o tenant usar domínio próprio, use esse domínio no lugar.
4. Em **Audience**, tipo **External**. Em Test users, adicione o Gmail que vai conectar o calendário.
5. Em **Data Access**, adicione:
   - `openid`
   - `https://www.googleapis.com/auth/userinfo.email`
   - `https://www.googleapis.com/auth/userinfo.profile`
   - `https://www.googleapis.com/auth/calendar.events`
6. Em **Clients > New client**, tipo **Web application**.
   - Origem JavaScript autorizada: `https://dev-1pvf63u214jb5oi8.us.auth0.com`
   - URI de redirecionamento autorizado: `https://dev-1pvf63u214jb5oi8.us.auth0.com/login/callback`
7. Guarde o Client ID e o Client Secret do Google só para colar na Auth0 no passo seguinte. Não os commite.

`calendar.events` é escopo sensível. Enquanto o app não for verificado pela Google, só os test users conseguem consentir.

### 2. Auth0 — conexão Google com Token Vault

1. Auth0 Dashboard > **Authentication > Social > Create Connection > Google / Gmail**.
2. Cole o Client ID e o Client Secret do passo 1.
3. Em **Purpose**, ligue **Connected Accounts for Token Vault**. Não desligue o login que o outro desafio já usa. Deixar "Authentication" ligado nesta conexão é opcional: se ficar ligado, o Google também aparece como forma de entrar. Para não mudar o login atual, deixe só Connected Accounts.
4. Em **Permissions**, ligue **Offline Access**. Sem isso o Token Vault não guarda refresh token.
5. Salve. Na aba **Applications**, habilite o SPA do BuilderOps (client id público `ekrjl1rjQDtomIHm7jtVDTD1jZrSh9NG`).
6. O nome da conexão deve continuar `google-oauth2`. Se a Auth0 gerar outro nome, ou você renomeia, ou altera `AUTH0_GOOGLE_CONNECTION` em `cloudflare.config.ts` e faz deploy de novo.

Os escopos enviados pelo botão do site substituem os escopos marcados no dashboard, exceto `offline_access`. O botão envia `openid`, `profile`, `email` e `https://www.googleapis.com/auth/calendar.events`.

### 3. Auth0 — My Account API, MRRT e refresh token da SPA

Isto só passa a valer quando `veto` está ligado. Com `veto: false` o SPA continua sem refresh token e sem DPoP, e o cache do SDK permanece `memory`. Com o veto ligado, o cache usa `localStorage` para o refresh token sobreviver ao redirecionamento de Connected Accounts, protegido por DPoP. A API do BuilderOps precisa de **Allow Offline Access** ligado, e a política padrão da My Account API pode exigir MFA (política de MFA do tenant em **Always**).

1. **Applications > APIs** e ative **Auth0 My Account API**, se ainda não estiver ativa. https://auth0.com/docs/manage-users/my-account-api
2. Abra essa API > **Application Access**. No SPA, **User Access > Authorized**.
3. Nas permissões, marque os escopos de Connected Accounts: `create:me:connected_accounts`, `read:me:connected_accounts`, `delete:me:connected_accounts`.
4. Na mesma API, em **Settings > Access Settings**, marque **Allow Skipping User Consent** se a tela de MRRT pedir isso.
5. Abra o SPA > **Multi-Resource Refresh Token** e inclua a My Account API.
6. No SPA, em **Advanced Settings > Grant Types**, deixe **Authorization Code** e marque **Refresh Token**. O SPA precisa ser first-party (`is_first_party`) e OIDC conformant, que é o padrão de aplicativo novo.
7. Confirme os callbacks que já existem:
   - Allowed Callback URLs: `https://jrpasolini.github.io/BuilderOps/`
   - Allowed Logout URLs: o mesmo
   - Allowed Web Origins: `https://jrpasolini.github.io`
8. Quando o recurso for ligado, saia e entre de novo no site. O SDK passa a pedir refresh token, MRRT e DPoP. O exemplo oficial do SPA diz que a My Account API exige DPoP. A página de Connected Accounts diz que DPoP é opcional até ser configurado. O código segue o SDK e só liga DPoP junto com o veto.

### 4. Auth0 — Custom API Client do Token Vault

A troca de token de acesso exige um cliente confidencial vinculado à API `https://builderops-api`, não o SPA.

1. **Applications > APIs >** a API cujo identifier é `https://builderops-api`.
2. **Add Application**, nome sugerido `BuilderOps Token Vault`.
3. O tipo resultante é **Custom API Client**. Em **Advanced Settings > Grant Types**, o grant **Token Vault** (`urn:auth0:params:oauth:grant-type:token-exchange:federated-connection-access-token`) deve estar ligado.
4. O cliente precisa ser first-party, confidencial (`token_endpoint_auth_method` diferente de `none`) e OIDC conformant.
5. Copie o Client ID e o Client Secret para os segredos do Worker `AUTH0_VAULT_CLIENT_ID` e `AUTH0_VAULT_CLIENT_SECRET`. Não os commite.

### 5. Auth0 — aplicativo CIBA e Guardian

O cliente CIBA também é confidencial e first-party. Pode ser um segundo aplicativo. Não há, na documentação lida, garantia de que o Custom API Client aceite o grant CIBA ao mesmo tempo. Se o dashboard permitir os dois grants no mesmo cliente, os dois pares de segredo podem receber os mesmos valores. Se não permitir, use dois clientes. O código aceita os dois jeitos.

1. **Applications > Applications > Create Application > Regular Web Application**, nome sugerido `BuilderOps CIBA`.
2. Método de autenticação: Client Secret.
3. Em **Grant Types**, marque **Client Initiated Backchannel Authentication (CIBA)**.
4. Na seção CIBA do aplicativo, ligue o canal:
   - **guardian-push** para o celular. O código manda `requested_expiry=300`.
   - **email** só se o add-on estiver comprado. Aí mude `AUTH0_CIBA_CHANNEL` em `cloudflare.config.ts` de `guardian` para `email` e faça deploy. O código passa a mandar `requested_expiry=3600`.
5. Copie Client ID e Secret para `AUTH0_CIBA_CLIENT_ID` e `AUTH0_CIBA_CLIENT_SECRET`.

Guardian, se o canal for push:

1. **Security > Multi-factor Auth**. Ative **Push Notification** usando **Auth0 Guardian**. Em Push Notification App, escolha o app Guardian. https://auth0.com/docs/secure/multi-factor-authentication/auth0-guardian
2. Não deixe a política de MFA em **Always**. A página de configuração do Token Vault diz que Always faz a troca do token falhar. https://auth0.com/docs/secure/call-apis-on-users-behalf/token-vault/configure-token-vault
3. Jeito prático de inscrever sem ficar em Always: ponha a política em Always, entre uma vez no site, instale o app Auth0 Guardian e conclua o QR code, depois volte a política para **Never** antes de testar a agenda. Alternativa: uma Action que pede inscrição só em login interativo (`event.transaction.protocol`), e não no token endpoint.
4. Em **User Management > Users**, abra o usuário e confira um fator push inscrito.
5. Se o usuário não tiver push e o e-mail de CIBA estiver ligado, a Auth0 pode cair para o e-mail em vez de recusar. Se nenhum canal servir, `/bc-authorize` falha e o chat mostra o código OAuth, sem gravar no Google.

E-mail, se for o canal:

1. **Branding > Email Templates > Asynchronous Approval**. Ative o template. Em produção a Auth0 pede provedor de e-mail próprio; o provedor embutido é só para teste.
2. O usuário precisa de e-mail verificado.
3. Isso é add-on pago. Não conte com ele no Free.

### 6. Cloudflare Worker — segredos e variável de fuga

No Worker `builderops` > **Settings > Variables and Secrets**, crie estes segredos (não são variáveis de texto no Git):

| Nome | Valor |
|---|---|
| `AUTH0_VAULT_CLIENT_ID` | Client ID do Custom API Client |
| `AUTH0_VAULT_CLIENT_SECRET` | Secret desse cliente |
| `AUTH0_CIBA_CLIENT_ID` | Client ID do app CIBA |
| `AUTH0_CIBA_CLIENT_SECRET` | Secret desse app |

Já estão no `cloudflare.config.ts`, sem segredo:

| Binding | Padrão | Efeito |
|---|---|---|
| `VETO_AGENT` | `auto` | `off`, `false` ou `0` desliga mesmo com segredo |
| `AUTH0_CIBA_CHANNEL` | `guardian` | `email` só depois de mudar o arquivo e fazer deploy |
| `AUTH0_GOOGLE_CONNECTION` | `google-oauth2` | nome da conexão social |

O Worker cria as tabelas ao primeiro uso. Se quiser aplicar à mão no D1 `builderops-db`, o arquivo é `db/002_veto.sql`. Não guarde token do Google nessas tabelas. O código não grava.

Incerteza do CLI `cf`: segredo que não está declarado com `bindings.secret()` pode não chegar em `env` depois do deploy, ou um deploy pode não preservar segredo criado só no painel. Este repositório não declara `bindings.secret()` de propósito, para o `npm run build` e o deploy do assistente atual não passarem a exigir segredo. Depois de cadastrar os quatro valores, abra `GET https://builderops.antonio-pasolini.workers.dev/api/config`. O JSON deve ter `"veto": true` e **não** pode conter os segredos nem os client ids confidenciais. Se continuar `false`:

1. Confirme que os quatro valores existem no Worker e que cada client id tem 16 a 64 caracteres `A-Za-z0-9_-`, e cada secret tem pelo menos 16 caracteres.
2. Só então adicione em `cloudflare.config.ts`, dentro de `env`:

```ts
AUTH0_VAULT_CLIENT_ID: bindings.secret(),
AUTH0_VAULT_CLIENT_SECRET: bindings.secret(),
AUTH0_CIBA_CLIENT_ID: bindings.secret(),
AUTH0_CIBA_CLIENT_SECRET: bindings.secret(),
```

3. Faça deploy de novo. Se o deploy exigir os segredos e eles ainda não existirem, ele pode falhar. Por isso eles entram só depois de existirem na conta.

### 7. Roteiro de teste de ponta a ponta

Pré-condição: `veto: true` no `/api/config`, usuário inscrito no Guardian (ou e-mail de CIBA pronto), conta Google de teste conectável.

1. `curl -fsS https://builderops.antonio-pasolini.workers.dev/api/health` devolve `{"ok":true,...}`.
2. `curl -fsS https://builderops.antonio-pasolini.workers.dev/api/config` devolve `ready: true`, `veto: true`, `googleConnection: "google-oauth2"`. Procure no corpo: nenhum secret, nenhum client id do Vault e nenhum client id do CIBA.
3. `curl -sS -o /dev/null -w '%{http_code}\n' https://builderops.antonio-pasolini.workers.dev/api/profile` devolve `401`.
4. Abra https://jrpasolini.github.io/BuilderOps/ , entre com Auth0 e saia/entre de novo se esta for a primeira vez com veto ligado.
5. Clique em **Conectar Google Calendar**. Aceite o acesso aos eventos. A volta deve dizer que a conta conectou, sem mostrar token.
6. Salve a cidade Vitória, Celsius, pt-BR.
7. No chat, envie exatamente `agenda`. A resposta lista eventos numerados. Datas dentro de 16 dias da Open-Meteo (hoje conta como dia 0; a última data é daqui a 15 dias) trazem máxima, mínima e chance de chuva. Data mais distante explica que ainda não há previsão. Conferir no Worker log, se precisar: não deve aparecer `ya29.` nem `access_token`.
8. Envie `Como está o tempo na minha cidade?`. A resposta continua sendo o fluxo antigo (perfil + Open-Meteo, Workers AI ou o texto determinístico).
9. Envie `criar lembrete de chuva`. O chat diz que a ação está pausada e mostra a mensagem de conferência. Abra o Google Calendar: o evento das 08:00 ainda não existe.
10. No celular, a notificação do Guardian mostra a mesma mensagem curta. **Aprove**. Em até cerca de três minutos o chat deve dizer que o evento foi criado. Confira "Alerta de chuva" ou "Lembrete de tempo" às 08:00 no fuso da cidade preferida. Abaixo de 40% de chuva o título é o lembrete; a gravação mesmo assim só ocorre depois da aprovação.
11. Repita o comando (ou use outra data dentro da janela: `criar lembrete de chuva em AAAA-MM-DD`). **Recuse** no Guardian, ou espere expirar (o pedido de push dura 300 segundos). O chat diz que foi cancelado. O calendário não ganha outro evento.
12. Envie `agenda` de novo e depois `reagendar 1 para AAAA-MM-DDTHH:MM` com um horário novo dentro do ano. Sem aprovação, o horário antigo permanece. Com aprovação, o evento muda e a duração original é mantida (entre 15 minutos e 8 horas; fora isso o código usa 1 hora).
13. Se a tela parar de consultar, envie `status da aprovação`.
14. Entre com outro usuário Auth0. A agenda e os pedidos do primeiro não aparecem. Um `POST /api/calendar/approvals/{id}` sem o JWT desse dono não devolve o pedido (401 sem token, 404 com outro usuário).

Data fora da janela, por exemplo `criar lembrete de chuva em 2027-01-01`, responde que a Open-Meteo não prevê tão longe e não chama CIBA.

## What is already implemented without dashboard access

- Parser, forecast window, Token Vault exchange, Calendar list/insert/patch, CIBA start and poll, denial and expiry, one pending request per user, and the hidden connect button.
- Tests in `tests/veto.test.js` cover: weather text is not a calendar command; the feature stays idle with no network when secrets are missing; a read does not POST to Google; a write does not POST to Google until CIBA returns an access token; denial does not write; an all-day event is refused; secrets and the Google token are absent from the chat payload and from the stored action JSON.
- `npm run check` and `npm run build` pass without the secrets.

## Uncertainties

- Whether this tenant's plan already includes CIBA or the AI Agents add-on. The public pricing page says Free does not include CIBA. Nobody on this task could open the tenant.
- What the Token Vault number on the pricing table counts (connections, applications, or something else).
- Whether one confidential client can hold both the Token Vault grant and the CIBA grant. The code allows two client ids.
- Whether the My Account API on this tenant requires DPoP. The SPA SDK example says yes. The Connected Accounts page says DPoP is validated when it is configured, and that the API can accept DPoP tokens by default. DPoP is enabled only while veto is on. If login breaks after that, set `VETO_AGENT` to `off` and redeploy; the SPA returns to the previous options.
- Whether a `cf deploy` injects Worker secrets that are not declared with `bindings.secret()`. The recovery snippet is in the checklist.
- Auth0 ping/push toward the Worker is not documented. Only poll is implemented.
- Real Guardian delivery, real Google consent, and a real Token Vault exchange were not executed here. The owner's checklist is the missing half.
