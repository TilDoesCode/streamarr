/// <reference types="vitest/config" />
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

// Dev: proxy /api and /openapi to the Core Server so the SPA runs on Vite's origin but
// talks to the real backend (BRIEF §4). Prod: the built SPA is served by the Core Server
// itself as static files with SPA fallback — see StreamarrServerBootstrap.UseStreamarrServer.
const SERVER_ORIGIN = process.env.STREAMARR_SERVER_ORIGIN ?? "http://localhost:5199";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: SERVER_ORIGIN, changeOrigin: true },
      "/openapi": { target: SERVER_ORIGIN, changeOrigin: true },
    },
  },
  build: {
    // Emitted into the Core Server's wwwroot so a single container serves everything.
    outDir: "dist",
    emptyOutDir: true,
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    css: false,
  },
});
