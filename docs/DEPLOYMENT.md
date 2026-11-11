# BuilderOps — GitHub Pages + Cloudflare Worker deployment

## Frontend / GitHub Pages

This repository has a GitHub Actions workflow `.github/workflows/deploy-pages.yml`.
Every push to `main` runs unit tests, builds the frontend for the repository subpath, and uploads the `dist/pages` static artifact.

- Intended frontend URL: `https://jrpasolini.github.io/BuilderOps/`
- GitHub > Repository Settings > Pages > Build and deployment > Source must be **GitHub Actions**. A source configured as “Deploy from a branch” does **not** use the Vite build from this workflow.
- `npm run build:pages` uses `vite.pages.config.ts` with `base: "/BuilderOps/"`.
- No Auth0 client secret, D1 binding, or AI key is ever embedded in the Pages artifact.
- Optional repository Actions variable `VITE_API_BASE_URL` overrides the backend URL at build time. The default for github.io uses the separately deployed `builderops` Worker under the existing Cloudflare account subdomain. The site will not be functional until the Worker exists.

## Backend / Cloudflare Worker

The Worker is **not** deployed by the GitHub Pages workflow. It provides:

- Protected `/api/profile` and `/api/chat`
- CORS restricted to `https://jrpasolini.github.io` via the `FRONTEND_ORIGIN` binding
- Auth0 JWT validation using the JWKS for the configured tenant
- D1 `DB` binding
- Cloudflare Workers AI `AI` binding running the configured DeepSeek model
- Open-Meteo weather data fetched server-side

The backend config is `cloudflare.config.ts`. Use `npm run build` for a Cloudflare bundle check and `npm run deploy` after replacing **public** Auth0 identifier placeholders. The site frontend is deployed separately through Actions; the Cloudflare build is not part of Pages.

## Auth0 Universal Login configuration

Create an **Auth0 Single Page Application** specifically for BuilderOps and an **API** with a stable audience identifier.

- Allowed Callback URLs: `https://jrpasolini.github.io/BuilderOps/`
- Allowed Logout URLs: `https://jrpasolini.github.io/BuilderOps/`
- Allowed Web Origins: `https://jrpasolini.github.io`
- Cloudflare Worker `AUTH0_DOMAIN`: tenant hostname only, no `https://`
- `AUTH0_CLIENT_ID`: SPA public client ID
- `AUTH0_AUDIENCE`: identifier of the Auth0 API (must match the token audience)

For localhost, add the actual local origin and callback URL as additional entries. Never commit a client secret or private key.

## Identity and privacy

The browser supplies a Bearer access token only to the BuilderOps Worker API. The Worker verifies signature, audience, issuer and expiry. Every profile/conversation query is scoped to the validated subject. CORS alone is not authorization; it only controls browser access. The Worker forwards **no Auth0 token** to Open-Meteo or Workers AI.

Before real-world use, add rate limits and retention/deletion controls. The initial project is a public demonstration using non-sensitive preferences.

## Veto Agent secrets

Calendar reads and CIBA-gated writes are inert until four Worker secrets exist: `AUTH0_VAULT_CLIENT_ID`, `AUTH0_VAULT_CLIENT_SECRET`, `AUTH0_CIBA_CLIENT_ID` and `AUTH0_CIBA_CLIENT_SECRET`. Do not put those values in `cloudflare.config.ts` or in Git. `GET /api/config` reports `veto: true` only when they are present and well formed, and the response must not contain them.

The public switches `VETO_AGENT`, `AUTH0_CIBA_CHANNEL` and `AUTH0_GOOGLE_CONNECTION` have safe defaults in `cloudflare.config.ts`. `VETO_AGENT=off` disables the feature even if the secrets exist. Changing the channel from `guardian` to `email` is a config edit and a redeploy.

The Worker creates `calendar_snapshots` and `calendar_approvals` on first use (`db/002_veto.sql`). Those tables store event ids and the CIBA `auth_req_id`. They must not store Google tokens. The existing profile and chat tables are unchanged, and the weather flow does not touch the new tables while the feature is off.

Full Portuguese setup and the paid-plan warnings: `docs/challenges/VETO_AGENT.md`.

## Privacy-aware RAG secrets

Document answers stay on the weather path until three Worker secrets exist: `FGA_STORE_ID`, `FGA_CLIENT_ID` and `FGA_CLIENT_SECRET`. `FGA_MODEL_ID` is optional. Do not put those values in `cloudflare.config.ts` or in Git, and do not declare `bindings.secret()` before they exist. `GET /api/config` reports `rag: true` only when they are present and well formed, and the response must not contain them. `RAG_AGENT=off` disables the feature even if the secrets exist.

The public switches `RAG_AGENT`, `FGA_API_URL`, `FGA_API_AUDIENCE`, `FGA_TOKEN_URL` and `AI_EMBED_MODEL` have defaults in `cloudflare.config.ts`. The Worker calls Auth0 FGA with `fetch` and embeds the in-repo corpus with Workers AI on first use. No Vectorize binding is required. Weather and calendar behavior are unchanged while `rag` is false.

Full Portuguese setup: `docs/challenges/RAG_AGENT.md`.

## Test checklist

1. GitHub Actions: verify successful `Publish BuilderOps frontend` run and deployed static artifact.
2. Worker health: `GET /api/health` returns `{"ok":true}` after backend deploy.
3. Before Auth0 login, `GET /api/profile` returns 401.
4. Auth0 Universal Login redirects to the repository subpath, not the domain root.
5. In the same conversation, change city to Lisbon and unit to Fahrenheit; confirm both are used in the Open-Meteo tool result.
6. Sign in as another Auth0 account and verify profile/history segregation.
7. Capture screenshots from the actual deployed UI, API, and Auth0 dashboard for the MLH submission.
