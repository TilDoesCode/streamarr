import "@testing-library/jest-dom/vitest";
import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

// Newer Node releases may expose their own experimental global `localStorage`. Pin the test
// global to jsdom's origin-aware implementation so production code and tests share one store.
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: window.localStorage,
});
Object.defineProperty(globalThis, "sessionStorage", {
  configurable: true,
  value: window.sessionStorage,
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

// jsdom lacks matchMedia — the ThemeProvider probes it for the initial theme.
if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}
