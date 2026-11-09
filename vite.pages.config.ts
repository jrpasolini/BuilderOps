import { defineConfig } from "vite";
// GitHub Pages: https://jrpasolini.github.io/BuilderOps/
// This build intentionally omits Cloudflare Worker bundling; API is separate.
export default defineConfig({
  base: "/BuilderOps/",
  build: {
    outDir: "dist/pages",
    emptyOutDir: true,
    target: "es2022",
    sourcemap: false,
  },
});
