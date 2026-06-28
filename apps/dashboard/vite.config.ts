import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

const dataDir = process.env.DATA_DIR ?? ".maradocs-data";
const resolvedDataDir = path.isAbsolute(dataDir)
  ? dataDir
  : path.resolve(process.env.INIT_CWD ?? process.cwd(), dataDir);

// The dashboard is served by the MaraDocs server under /dashboard/.
// During `vite dev`, proxy API + read URLs to the local server (port 8787).
export default defineConfig({
  base: "/dashboard/",
  plugins: [react()],
  server: {
    port: 5273,
    watch: {
      ignored: [resolvedDataDir, `${resolvedDataDir}/**`],
    },
    proxy: {
      "/api": "http://localhost:8787",
      "/r": "http://localhost:8787",
      "/health": "http://localhost:8787",
    },
  },
});
