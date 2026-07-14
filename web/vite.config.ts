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
      // Preserve the browser-visible Host. Cookie-authenticated unsafe requests are protected
      // by an exact Origin check in Kestrel, so rewriting Host would make legitimate dev POSTs
      // look cross-origin and be rejected.
      "/api": { target: SERVER_ORIGIN, changeOrigin: false },
      "/openapi": { target: SERVER_ORIGIN, changeOrigin: false },
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
    // Vitest component tests live under src/. Playwright E2E specs live under e2e/ and
    // must NOT be collected by Vitest (they use @playwright/test, not the jsdom runner).
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    exclude: ["e2e/**", "node_modules/**", "dist/**"],
  },
});
