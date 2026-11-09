# MLH Builders Week 2026 — Context-Preserving Assistant

Official challenge: https://www.mlh.com/events/global-hack-week-builders-week/challenges/01a1ad3a-ca88-fb9f-3599-99b9ba139a0a

## Evidence / acceptance checklist

- [ ] Real Auth0 Universal Login works and produces a token for the BuilderOps API audience.
- [ ] The custom first-party \`GET /api/profile\` returns only the current user's saved preferences.
- [ ] The assistant reads the preferences under the authenticated subject.
- [ ] Open-Meteo is called through the Worker as a third-party API.
- [ ] Cloudflare Workers AI answers using the authenticated preferences and the external weather reading.
- [ ] The same conversation retains identity, history and newly saved preferences.
- [ ] User B cannot read or modify user A's profile and conversations.
- [ ] Unauthenticated and invalid JWT requests to \`/api/profile\` return 401.
- [ ] Capture screenshots of authentication, saved preferences, multi-turn conversation, and evidence of tool/API usage.
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

Cloudflare DeepSeek R1 Distill Qwen 32B planned model deprecation: **2026-11-20**. The model is currently specified as a configurable binding; test actual inference before submitting.

The repository contains an initial implementation; deployment, production D1, real Auth0 login and end-to-end test **remain pending**, so no box above is pre-checked.

## Future integrations

- Tiger Data activity hypertables and analytics.
- Vector search over synthetic documents with authorization checks.
- Auth0 FGA policy-controlled retrieval.
- Optional Token Vault/CIBA after verifying tenant access and challenge constraints.
