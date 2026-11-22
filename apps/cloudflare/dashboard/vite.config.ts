import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const worker = "http://localhost:8787";

export default defineConfig({
  root: here,
  base: "/dashboard/",
  plugins: [react()],
  publicDir: resolve(here, "public"),
  build: {
    outDir: resolve(here, "../public/dashboard"),
    emptyOutDir: true,
    target: "es2022",
    sourcemap: false,
    // The Worker serves this SPA with `script-src 'self'`; never inline scripts.
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 400,
  },
  server: {
    port: 5173,
    strictPort: false,
    proxy: {
      "/api": { target: worker, changeOrigin: false },
      // Regex key so only report paths (`/r/...`) are proxied, not e.g. `/robots.txt`.
      "^/r(/.*)?$": { target: worker, changeOrigin: false },
      "/health": { target: worker, changeOrigin: false },
    },
  },
});
