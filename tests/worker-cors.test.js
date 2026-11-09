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
test("public health endpoint stays available to GitHub Pages", async () => {
  const response=await worker.fetch(new Request(backend+"/api/health",{
    headers:{origin:env.FRONTEND_ORIGIN}
  }),env);
  assert.equal(response.status,200);
  assert.equal((await response.json()).ok,true);
  assert.equal(response.headers.get("access-control-allow-origin"),env.FRONTEND_ORIGIN);
});
