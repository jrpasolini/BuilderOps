# MLH Builders Week 2026 — Context-Preserving Assistant

Official challenge: https://www.mlh.com/events/global-hack-week-builders-week/challenges/01a1ad3a-ca88-fb9f-3599-99b9ba139a0a

## Evidence / acceptance checklist

- [x] Real Auth0 Universal Login works and produces a token for the BuilderOps API audience.
- [x] The custom first-party `GET /api/profile` returns only the current user's saved preferences.
- [x] The assistant reads the preferences under the authenticated subject.
- [x] Open-Meteo is called through the Worker as a third-party API.
- [x] Cloudflare Workers AI answers using the authenticated preferences and the external weather reading.
- [ ] The same conversation retains identity, history and newly saved preferences.
- [ ] User B cannot read or modify user A's profile and conversations.
- [ ] Unauthenticated and invalid JWT requests to `/api/profile` return 401.
- [x] Capture screenshots of authentication, saved preferences, multi-turn conversation, and evidence of tool/API usage.
- [ ] Publish source and submit the GitHub repository URL to MLH.

## Suggested live walkthrough

1. Sign in as user A with Auth0 Universal Login.
2. Save Vitória, Celsius, pt-BR using the protected profile API.
3. Ask about local weather. Verify that the Worker loads the saved profile and gets Open-Meteo weather before invoking Workers AI.
4. Switch to Lisbon and Fahrenheit, save and ask again in the SAME conversation.
5. Sign out, sign in as user B, verify separate preferences and inaccessible history.
6. Show results without exposing access tokens or other personal identifiers.

## Security boundaries

- The browser supplies a JWT access token; the Worker checks Auth0 JWKS signature, issuer, audience and expiry.
- The subject comes only from the verified token and selects D1 rows.
- Conversation UUIDs are not permissions; the subject is checked on every read and continuation.
- Open-Meteo does not receive tokens or Auth0 subjects.
- Workers AI sees a minimized verified profile and weather payload, never an Auth0 token.
- The UI renders model output as text.
- The assistant falls back to deterministic weather formatting on model failure.

## Model and deployment status

Cloudflare DeepSeek R1 Distill Qwen 32B planned model deprecation: **2026-11-20**. The model is currently specified as a configurable binding. The 2026-11-09 live chat used this Workers AI model.

**Verified on 2026-11-09** (about 21:50 America/Sao_Paulo) at `https://jrpasolini.github.io/BuilderOps/` with the Worker `https://builderops.antonio-pasolini.workers.dev`:

- Auth0 Universal Login completed. The header showed **Sessão autenticada**.
- `GET /api/profile` with the Auth0 JWT loaded the D1 profile for the validated `sub`: Vitória, ES; Celsius; Português (Brasil). The chat showed “Perfil carregado: Vitória, ES.”
- In that same conversation, “Como está o tempo na minha cidade?” was answered by `/api/chat` with Open-Meteo for the saved city through Workers AI (19,6°C, 91% relative humidity, light rain, wind 11,2 km/h, next-day max 22,9°C / min 18,7°C, 96% chance of rain).
- Without a token: `GET /api/health` returned 200, `GET /api/config` reported `ready: true`, and `GET /api/profile` returned 401.

Screenshot: [`docs/assets/builderops-demo.png`](../assets/builderops-demo.png).

Still open, so those boxes stay unchecked: a preference change continued in the same conversation, user B isolation, a request with an invalid JWT (the 401 above was a missing token), and submitting the repository URL to MLH.

## Future integrations

- Tiger Data activity hypertables and analytics.
- Vector search over synthetic documents with authorization checks.
- Auth0 FGA policy-controlled retrieval.
- Optional Token Vault/CIBA after verifying tenant access and challenge constraints.
