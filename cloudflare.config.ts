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
      FRONTEND_ORIGIN: bindings.text("https://jrpasolini.github.io"),
      AUTH0_DOMAIN: bindings.text("dev-1pvf63u214jb5oi8.us.auth0.com"),
      AUTH0_CLIENT_ID: bindings.text("ekrjl1rjQDtomIHm7jtVDTD1jZrSh9NG"),
      AUTH0_AUDIENCE: bindings.text("https://builderops-api"),
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
