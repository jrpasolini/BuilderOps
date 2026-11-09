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

## Test checklist

1. GitHub Actions: verify successful `Publish BuilderOps frontend` run and deployed static artifact.
2. Worker health: `GET /api/health` returns `{"ok":true}` after backend deploy.
3. Before Auth0 login, `GET /api/profile` returns 401.
4. Auth0 Universal Login redirects to the repository subpath, not the domain root.
5. In the same conversation, change city to Lisbon and unit to Fahrenheit; confirm both are used in the Open-Meteo tool result.
6. Sign in as another Auth0 account and verify profile/history segregation.
7. Capture screenshots from the actual deployed UI, API, and Auth0 dashboard for the MLH submission.
