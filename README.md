# BuilderOps — Context-Preserving Assistant

**MLH Global Hack Week — Builders Week 2026**

BuilderOps is an identity-aware chat assistant designed to demonstrate user-specific context surviving across an authenticated first-party API and an external third-party API. The project is structured so additional MLH challenges (Tiger Data event analytics, vector search and Auth0 FGA) can be added later.

**Current status:** initial code scaffold published; live Auth0, D1, Workers AI inference and deployment are NOT yet verified.

## Architecture

- **Frontend:** Vite + vanilla JavaScript with Auth0 SPA SDK / Universal Login.
- **Backend:** Cloudflare Worker verifying an Auth0 JWT access token with Auth0 JWKS.
- **First-party API:** \`GET /api/profile\` and \`PUT /api/profile\`, backed by D1 and keyed by the verified JWT \`sub\`. The same service is invoked inside the assistant tool chain.
- **Third-party API:** Open-Meteo weather endpoint, using only allowlisted city coordinates.
- **Model:** Cloudflare Workers AI, model \`@cf/deepseek-ai/deepseek-r1-distill-qwen-32b\`, invoked via \`env.AI.run()\`. No external DeepSeek API key is needed.
- **History:** D1 conversations and messages, scoped by verified user subject plus conversation ID.

**Model lifecycle alert:** Cloudflare currently lists **November 20, 2026** as the planned deprecation date for this DeepSeek R1 model. \`AI_MODEL\` is configurable in \`cloudflare.config.ts\` to support migration. Verify the replacement model's input/output behavior before switching.

Model docs: https://developers.cloudflare.com/ai/models/%40cf/deepseek-ai/deepseek-r1-distill-qwen-32b/

## API routes

| Route | Method | Access | Purpose |
|---|---|---|---|
| \`/api/health\` | GET | Public | Basic health response |
| \`/api/config\` | GET | Public | Non-secret Auth0 SPA identifiers |
| \`/api/profile\` | GET | Auth0 JWT | Read/create authenticated user's profile |
| \`/api/profile\` | PUT | Auth0 JWT | Update allowlisted preferences |
| \`/api/chat\` | POST | Auth0 JWT | Retrieve profile, call Open-Meteo and Workers AI, persist conversation |
| \`/api/history?id=<uuid>\` | GET | Auth0 JWT | Return conversation only for its owner |

## Local setup

1. Install **Node.js 22.18+**, npm and dependencies: \`npm install\`.
2. Create an **Auth0 Single Page Application** and an **Auth0 API** with an API Identifier (audience). Use RS256.
3. Replace the three public placeholder bindings in \`cloudflare.config.ts\`: \`AUTH0_DOMAIN\`, \`AUTH0_CLIENT_ID\` and \`AUTH0_AUDIENCE\`. Never store an Auth0 client secret in the SPA or repository.
4. Set the SPA **Allowed Callback URLs**, **Allowed Logout URLs** and **Allowed Web Origins** for your actual local development and production origins.
5. Create a **Cloudflare D1** database named \`builderops-db\`, using the binding \`DB\`, and apply \`db/001_init.sql\` to local and remote databases as appropriate.
6. The Cloudflare config already declares an **AI** binding. Workers AI runs through the Cloudflare account and **can incur inference charges, including in local development**. No DeepSeek API secret is required.
7. Run \`npm run check\`, then \`npm run dev\`, \`npm run build\`, and finally \`npm run deploy\` only after updating Auth0 and D1 configuration.

The project uses Cloudflare's beta \`cf\` CLI and \`cloudflare.config.ts\`. Check the current CLI docs if a beta version changes configuration behavior: https://developers.cloudflare.com/cf/projects/.

## MLH demo

1. Authenticate user A with Auth0.
2. Save preferred city Vitória, unit Celsius, language Portuguese via the custom first-party profile API.
3. Ask the assistant: “Como está o tempo na minha cidade?” in a single authenticated chat.
4. Show the Worker loading the profile, fetching Open-Meteo and generating an answer through Workers AI (or its deterministic fallback if inference is temporarily unavailable).
5. Change the preferred city and temperature unit, then ask again **in the same conversation**.
6. Authenticate user B and demonstrate that user A's profile and conversation are inaccessible to B.
7. Capture screenshots and submit the repository URL.

Full acceptance checklist: \`docs/challenges/CONTEXT_PRESERVING.md\`.

## Security notes

- JWT signature, issuer, audience and expiration are verified server-side using Auth0 JWKS; identities are not accepted from client input.
- All D1 profile/history lookups are scoped by the JWT subject.
- The weather API receives coordinates and units, not Auth0 tokens.
- Workers AI receives the profile preferences, weather and recent conversation content but **not an Auth0 access token**; do not claim that these inputs are invisible to model processing.
- UI uses \`textContent\` for AI output to avoid treating model output as HTML.
- Optional model output is cleaned of any \`<think>\` spans before being displayed.
- Before real public use, implement rate limits, privacy/retention disclosure, history deletion and budget controls. Do not use real medical or sensitive personal data in the demo.

## Roadmap

Tiger Data hypertables → streaming dashboard → vector search → Auth0 FGA + permission-aware RAG. Advanced Token Vault/CIBA remains optional.

## License

MIT — Copyright (c) 2026 Antonio Pasolini Junior.
