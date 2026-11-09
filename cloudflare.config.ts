import { bindings, defineConfig } from "cf/config";
import * as entrypoint from "./src/worker.js" with { type: "cf-worker" };

// Public Auth0 identifiers only; never commit private client secrets.
export default defineConfig({
  worker: {
    name: "builderops",
    entrypoint,
    compatibilityDate: "2026-11-09",
    assets: {
      notFoundHandling: "single-page-application",
      runWorkerFirst: ["/api/*"],
    },
    env: {
      AUTH0_DOMAIN: bindings.text("REPLACE_ME.us.auth0.com"),
      AUTH0_CLIENT_ID: bindings.text("REPLACE_WITH_SPA_CLIENT_ID"),
      AUTH0_AUDIENCE: bindings.text("https://builderops-api.example"),
      DB: bindings.d1({ name: "builderops-db" }),
      AI: bindings.ai(),
      AI_MODEL: bindings.text("@cf/deepseek-ai/deepseek-r1-distill-qwen-32b"),
    },
    observability: {
      enabled: true,
      redactQueryString: true,
      logs: { enabled: true, headSamplingRate: 0.1 },
      traces: { enabled: true, headSamplingRate: 0.1 },
    },
  },
});
