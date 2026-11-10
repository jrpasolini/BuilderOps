import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.js";

const env={FRONTEND_ORIGIN:"https://jrpasolini.github.io"};
const backend="https://builderops.antonio-pasolini.workers.dev";

test("preflight allows only the configured GitHub Pages origin", async () => {
  const request = new Request(backend+"/api/profile", {
    method:"OPTIONS",
    headers:{
      origin:"https://jrpasolini.github.io",
      "access-control-request-method":"GET",
      "access-control-request-headers":"Authorization"
    }
  });
  const response=await worker.fetch(request,env);
  assert.equal(response.status,204);
  assert.equal(response.headers.get("access-control-allow-origin"),env.FRONTEND_ORIGIN);
  assert.match(response.headers.get("access-control-allow-headers"),/Authorization/);
});
test("foreign browser origins receive no CORS permission", async () => {
  const response=await worker.fetch(new Request(backend+"/api/chat",{
    method:"OPTIONS",
    headers:{origin:"https://not-our-site.example"}
  }),env);
  assert.equal(response.status,403);
  assert.equal(response.headers.get("access-control-allow-origin"),null);
});
test("missing JWT is rejected even for allowlisted origin", async () => {
  const response=await worker.fetch(new Request(backend+"/api/profile",{
    headers:{origin:env.FRONTEND_ORIGIN}
  }),env);
  assert.equal(response.status,401);
  assert.equal(response.headers.get("access-control-allow-origin"),env.FRONTEND_ORIGIN);
});
test("calendar approval route still requires a JWT", async () => {
  const response=await worker.fetch(new Request(backend+"/api/calendar/approvals/11111111-1111-4111-8111-111111111111",{
    method:"POST",
    headers:{origin:env.FRONTEND_ORIGIN}
  }),env);
  assert.equal(response.status,401);
  assert.equal(response.headers.get("access-control-allow-origin"),env.FRONTEND_ORIGIN);
});
test("public config can advertise veto without echoing secrets", async () => {
  const secret="vault-secret-value-123456";
  const cibaSecret="ciba-secret-value-123456";
  const configured={
    ...env,
    AUTH0_DOMAIN:"tenant.auth0.com",
    AUTH0_CLIENT_ID:"spaPublicClientId123456",
    AUTH0_AUDIENCE:"https://builderops-api",
    AUTH0_VAULT_CLIENT_ID:"vaultclientid12345678901234",
    AUTH0_VAULT_CLIENT_SECRET:secret,
    AUTH0_CIBA_CLIENT_ID:"cibaclientid123456789012345",
    AUTH0_CIBA_CLIENT_SECRET:cibaSecret,
    AUTH0_CIBA_CHANNEL:"guardian",
    AUTH0_GOOGLE_CONNECTION:"google-oauth2",
    VETO_AGENT:"auto"
  };
  const response=await worker.fetch(new Request(backend+"/api/config"), configured);
  const body=await response.json();
  assert.equal(response.status,200);
  assert.equal(body.veto,true);
  assert.equal(body.googleConnection,"google-oauth2");
  assert.equal(body.ready,true);
  const encoded=JSON.stringify(body);
  assert.equal(encoded.includes(secret),false);
  assert.equal(encoded.includes(cibaSecret),false);
  assert.equal(encoded.includes(configured.AUTH0_VAULT_CLIENT_ID),false);
  assert.equal(encoded.includes(configured.AUTH0_CIBA_CLIENT_ID),false);
});
test("public health endpoint stays available to GitHub Pages", async () => {
  const response=await worker.fetch(new Request(backend+"/api/health",{
    headers:{origin:env.FRONTEND_ORIGIN}
  }),env);
  assert.equal(response.status,200);
  assert.equal((await response.json()).ok,true);
  assert.equal(response.headers.get("access-control-allow-origin"),env.FRONTEND_ORIGIN);
});
