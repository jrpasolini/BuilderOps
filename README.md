# BuilderOps — Context-Preserving Assistant

**MLH Global Hack Week — Builders Week 2026**

BuilderOps is an identity-aware chat assistant designed to demonstrate user-specific context surviving across an authenticated first-party API and an external third-party API. The project is structured so additional MLH challenges (Tiger Data event analytics, vector search and Auth0 FGA) can be added later.

**Current status (2026-11-09):** GitHub Pages frontend deployed at `https://jrpasolini.github.io/BuilderOps/`; Cloudflare Worker `builderops` uploaded and enabled at `https://builderops.antonio-pasolini.workers.dev`; Cloudflare D1 database `builderops-db` initialized. A real Auth0 login and the authenticated end-to-end flow were verified the same day: Universal Login, first-party `GET /api/profile`, and an Open-Meteo answer via Workers AI chat.

## Architecture

- **Frontend:** Vite + vanilla JavaScript with Auth0 SPA SDK / Universal Login.
- **Backend:** Cloudflare Worker verifying an Auth0 JWT access token with Auth0 JWKS.
- **First-party API:** `GET /api/profile` and `PUT /api/profile`, backed by D1 and keyed by the verified JWT `sub`. The same service is invoked inside the assistant tool chain.
- **Third-party API:** Open-Meteo weather endpoint, using only allowlisted city coordinates.
- **Model:** Cloudflare Workers AI, model `@cf/deepseek-ai/deepseek-r1-distill-qwen-32b`, invoked via `env.AI.run()`. No external DeepSeek API key is needed.
- **History:** D1 conversations and messages, scoped by verified user subject plus conversation ID.

**Model lifecycle alert:** Cloudflare currently lists **November 20, 2026** as the planned deprecation date for this DeepSeek R1 model. `AI_MODEL` is configurable in `cloudflare.config.ts` to support migration. Verify the replacement model's input/output behavior before switching.

Model docs: https://developers.cloudflare.com/ai/models/%40cf/deepseek-ai/deepseek-r1-distill-qwen-32b/

## API routes

| Route | Method | Access | Purpose |
|---|---|---|---|
| `/api/health` | GET | Public | Basic health response |
| `/api/config` | GET | Public | Non-secret Auth0 SPA identifiers |
| `/api/profile` | GET | Auth0 JWT | Read/create authenticated user's profile |
| `/api/profile` | PUT | Auth0 JWT | Update allowlisted preferences |
| `/api/chat` | POST | Auth0 JWT | Retrieve profile, call Open-Meteo and Workers AI, persist conversation |
| `/api/history?id=<uuid>` | GET | Auth0 JWT | Return conversation only for its owner |

## Local setup

1. Install **Node.js 22.18+**, npm and dependencies: `npm install`.
2. Create an **Auth0 Single Page Application** and an **Auth0 API** with an API Identifier (audience). Use RS256.
3. Replace the three public placeholder bindings in `cloudflare.config.ts`: `AUTH0_DOMAIN`, `AUTH0_CLIENT_ID` and `AUTH0_AUDIENCE`. Never store an Auth0 client secret in the SPA or repository.
4. Set the SPA **Allowed Callback URLs**, **Allowed Logout URLs** and **Allowed Web Origins** for your actual local development and production origins.
5. Create a **Cloudflare D1** database named `builderops-db`, using the binding `DB`, and apply `db/001_init.sql` to local and remote databases as appropriate.
6. The Cloudflare config already declares an **AI** binding. Workers AI runs through the Cloudflare account and **can incur inference charges, including in local development**. No DeepSeek API secret is required.
7. Run `npm run check`, then `npm run dev`, `npm run build`, and finally `npm run deploy` only after updating Auth0 and D1 configuration.

The project uses Cloudflare's beta `cf` CLI and `cloudflare.config.ts`. Check the current CLI docs if a beta version changes configuration behavior: https://developers.cloudflare.com/cf/projects/.

## MLH demo

1. Authenticate user A with Auth0.
2. Save preferred city Vitória, unit Celsius, language Portuguese via the custom first-party profile API.
3. Ask the assistant: “Como está o tempo na minha cidade?” in a single authenticated chat.
4. Show the Worker loading the profile, fetching Open-Meteo and generating an answer through Workers AI (or its deterministic fallback if inference is temporarily unavailable).
5. Change the preferred city and temperature unit, then ask again **in the same conversation**.
6. Authenticate user B and demonstrate that user A's profile and conversation are inaccessible to B.
7. Capture screenshots and submit the repository URL.

Full acceptance checklist: `docs/challenges/CONTEXT_PRESERVING.md`.

## Demo / Verification

Verified on 2026-11-09, about 21:50 America/Sao_Paulo, on the live GitHub Pages frontend and the Worker above. One authenticated conversation covered the three challenge goals:

| Challenge goal | What this run showed |
|---|---|
| Initial user authentication | Auth0 Universal Login. The header showed **Sessão autenticada**. |
| User-specific setting from a first-party API | `GET /api/profile` with the Auth0 JWT. The D1 row is keyed by the validated `sub`. Loaded city Vitória, ES, unit Celsius and language Português (Brasil). The chat showed “Perfil carregado: Vitória, ES.” |
| Third-party task in the same conversation | The user asked “Como está o tempo na minha cidade?”. `POST /api/chat` answered with Open-Meteo for that saved city through Workers AI: 19,6°C, 91% relative humidity, light rain, wind 11,2 km/h, and a next-day forecast (max 22,9°C, min 18,7°C, 96% chance of rain, overcast). Source: Open-Meteo. |

Auth0 Token Vault is not required. Open-Meteo is a public, keyless API, so there is no third-party credential to store or exchange. The Worker forwards no Auth0 access token to Open-Meteo or to Workers AI. Open-Meteo receives coordinates and units; Workers AI receives the profile preferences, the weather reading and recent conversation content.

Without a token on that Worker, `GET /api/health` returned 200, `GET /api/config` reported `ready: true`, and `GET /api/profile` returned 401.

![Authenticated BuilderOps session: Vitória, ES preferences and an Open-Meteo weather answer in the same chat](docs/assets/builderops-demo.png)

## Security notes

- JWT signature, issuer, audience and expiration are verified server-side using Auth0 JWKS; identities are not accepted from client input.
- All D1 profile/history lookups are scoped by the JWT subject.
- The weather API receives coordinates and units, not Auth0 tokens.
- Workers AI receives the profile preferences, weather and recent conversation content but **not an Auth0 access token**; do not claim that these inputs are invisible to model processing.
- UI uses `textContent` for AI output to avoid treating model output as HTML.
- Optional model output is cleaned of any `<think>` spans before being displayed.
- Before real public use, implement rate limits, privacy/retention disclosure, history deletion and budget controls. Do not use real medical or sensitive personal data in the demo.

## Roadmap

Tiger Data hypertables → streaming dashboard → vector search → Auth0 FGA + permission-aware RAG. Advanced Token Vault/CIBA remains optional.

## License

MIT — Copyright (c) 2026 Antonio Pasolini Junior.
