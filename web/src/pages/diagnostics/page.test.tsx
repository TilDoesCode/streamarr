import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test/render";
import { installFetchRoutes } from "@/test/fetch-routes";
import { setSession } from "@/api/token";
import { abortError, DEFAULT_OPTIONS, type Clock, type SpeedTestTransport } from "@/lib/speedtest";
import type { DiagnosticsResponse } from "@/api/types";
import { DiagnosticsPage } from "./index";
import { SpeedTestCard } from "./speed-test-card";
import { hintText, HINT_TEXT } from "./text";

function diagnostics(overrides: Partial<DiagnosticsResponse> = {}): DiagnosticsResponse {
  const now = Date.now();
  return {
    status: "degraded",
    hints: ["provider_auth_failed", "some_providers_down"],
    server: { version: "0.18.0", uptimeSeconds: 5_321, now: new Date(now).toISOString() },
    components: [
      { id: "database", kind: "database", name: "Database", status: "ok", latencyMs: 1.2 },
      {
        id: "provider:1",
        kind: "provider",
        name: "Eweka",
        status: "ok",
        latencyMs: 143,
        detail: "priority 0",
        connectionsInUse: 3,
        connectionsMax: 20,
      },
      {
        id: "provider:2",
        kind: "provider",
        name: "Backup",
        status: "down",
        latencyMs: 61,
        errorCode: "auth_failed",
        error: "authentication failed (481)",
      },
      {
        id: "disk",
        kind: "disk",
        name: "Storage",
        status: "ok",
        freeBytes: 51_539_607_552,
        minimumFreeBytes: 1_073_741_824,
      },
    ],
    checkedAt: new Date(now - 8_000).toISOString(),
    ageSeconds: 8,
    refreshAvailableAt: new Date(now - 1_000).toISOString(),
    ...overrides,
  };
}

const noSpeedTest = { "GET /api/v1/diagnostics/ping": () => ({ status: 500 }) };

describe("DiagnosticsPage", () => {
  beforeEach(() => {
    setSession({ username: "admin", role: "admin", expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("renders the verdict, translated hints and every component", async () => {
    installFetchRoutes({ "GET /api/v1/diagnostics": () => diagnostics(), ...noSpeedTest });
    renderWithProviders(<DiagnosticsPage />);

    const banner = await screen.findByRole("region", { name: "Overall status" });
    expect(banner).toHaveAttribute("data-status", "degraded");
    expect(within(banner).getByText(/needs attention/)).toBeInTheDocument();
    expect(within(banner).getByText("A Usenet provider rejects the login.")).toBeInTheDocument();
    expect(within(banner).getByText(/Check username and password under Usenet Providers/)).toBeInTheDocument();
    expect(within(banner).getByText(HINT_TEXT.some_providers_down.title)).toBeInTheDocument();
    expect(within(banner).getByText("v0.18.0")).toBeInTheDocument();
    expect(within(banner).getByText("1h 28m")).toBeInTheDocument();

    const backup = screen.getByTestId("component-provider:2");
    expect(within(backup).getByText("down")).toBeInTheDocument();
    expect(within(backup).getByText("Backup")).toBeInTheDocument();
    expect(within(backup).getByText("Login rejected")).toBeInTheDocument();
    expect(within(backup).getByText("authentication failed (481)")).toBeInTheDocument();
    expect(within(backup).getByText("61 ms")).toBeInTheDocument();

    const eweka = screen.getByTestId("component-provider:1");
    expect(within(eweka).getByText("priority 0")).toBeInTheDocument();
    expect(within(eweka).getByText("3 / 20 connections in use")).toBeInTheDocument();

    const disk = screen.getByTestId("component-disk");
    expect(within(disk).getByText("48.0 GB free · minimum 1.0 GB")).toBeInTheDocument();
    expect(screen.getByTestId("checked-ago")).toHaveTextContent(/Checked \d+ s ago/);
  });

  it("refresh asks the server to re-probe with refresh=true", async () => {
    const { fetchMock } = installFetchRoutes({
      "GET /api/v1/diagnostics": () => diagnostics({ status: "ok", hints: [] }),
      ...noSpeedTest,
    });
    renderWithProviders(<DiagnosticsPage />);
    await screen.findByText("Everything looks healthy");

    const urls = () => fetchMock.mock.calls.map(([input]) => String(input));
    expect(urls()).toContain("/api/v1/diagnostics?refresh=false");
    await userEvent.click(screen.getByRole("button", { name: /Refresh/ }));
    await waitFor(() => expect(urls()).toContain("/api/v1/diagnostics?refresh=true"));
  });

  it("disables refresh until the server allows another probe", async () => {
    installFetchRoutes({
      "GET /api/v1/diagnostics": () =>
        diagnostics({ refreshAvailableAt: new Date(Date.now() + 9_000).toISOString() }),
      ...noSpeedTest,
    });
    renderWithProviders(<DiagnosticsPage />);
    const button = await screen.findByRole("button", { name: /Refresh \(\d+s\)/ });
    expect(button).toBeDisabled();
  });

  it("shows an error when diagnostics cannot be loaded", async () => {
    installFetchRoutes({
      "GET /api/v1/diagnostics": () => ({
        status: 429,
        body: { error: { code: "rate_limited", message: "Too many requests." } },
      }),
      ...noSpeedTest,
    });
    renderWithProviders(<DiagnosticsPage />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load diagnostics: Too many requests.");
  });

  it("falls back to a generic sentence for unknown hint codes", () => {
    expect(hintText("future_code").title).toContain("future_code");
  });
});

describe("SpeedTestCard", () => {
  const fastOptions = { ...DEFAULT_OPTIONS, pings: 3, durationMs: 120, warmupMs: 20, updateIntervalMs: 10 };

  // Virtual time moves only with the simulated chunks, so a busy event loop cannot change the measured rate.
  function virtualClock() {
    let now = 0;
    const sleepers = new Set<{ at: number; resolve: () => void }>();
    const clock: Clock = {
      now: () => now,
      sleep: (ms, signal) =>
        new Promise<void>((resolve, reject) => {
          if (signal?.aborted) return reject(abortError());
          const sleeper = { at: now + ms, resolve };
          sleepers.add(sleeper);
          signal?.addEventListener(
            "abort",
            () => {
              sleepers.delete(sleeper);
              reject(abortError());
            },
            { once: true },
          );
        }),
    };
    const advance = (ms: number) => {
      now += ms;
      for (const sleeper of [...sleepers]) {
        if (sleeper.at > now) continue;
        sleepers.delete(sleeper);
        sleeper.resolve();
      }
    };
    return { clock, advance };
  }

  function transport(bytesPerChunk: number, advance: (ms: number) => void): SpeedTestTransport {
    const info = { maxDownloadBytes: 1 << 20, maxUploadBytes: 1 << 20, maxParallelTransfers: 6 };
    const transfer = (_bytes: number, signal: AbortSignal, onBytes: (n: number) => void) =>
      new Promise<void>((resolve, reject) => {
        let ticks = 0;
        const id = setInterval(() => {
          advance(5);
          onBytes(bytesPerChunk);
          if (++ticks < 8) return;
          clearInterval(id);
          resolve();
        }, 1);
        signal.addEventListener("abort", () => {
          clearInterval(id);
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    return { ping: async () => info, download: transfer, upload: transfer };
  }

  function card(bytesPerChunk: number, options = fastOptions) {
    const { clock, advance } = virtualClock();
    return <SpeedTestCard transport={transport(bytesPerChunk, advance)} clock={clock} options={options} />;
  }

  it("runs the test and shows results with the streaming verdict", async () => {
    // 1 MB per 5 virtual ms ≈ 1.6 Gbit/s: every tier passes.
    renderWithProviders(card(1_000_000));
    await userEvent.click(screen.getByRole("button", { name: /Start test/ }));
    expect(await screen.findByText(/comfortably stream up to 4K HDR remux/, {}, { timeout: 3_000 })).toBeInTheDocument();
    expect(screen.getByTestId("speed-download")).toHaveTextContent(/Mbit\/s/);
    expect(screen.getByTestId("speed-upload")).toHaveTextContent(/Mbit\/s/);
    expect(screen.getByText("needs 100 Mbit/s")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Run again/ })).toBeInTheDocument();
  });

  it("reports a slow link and can be cancelled", async () => {
    renderWithProviders(card(100));
    await userEvent.click(screen.getByRole("button", { name: /Start test/ }));
    expect(await screen.findByText(/too slow for smooth 720p/, {}, { timeout: 3_000 })).toBeInTheDocument();

    renderWithProviders(card(100, { ...fastOptions, durationMs: 60_000 }));
    await userEvent.click(screen.getByRole("button", { name: /Start test/ }));
    await userEvent.click(await screen.findByRole("button", { name: /Cancel/ }));
    expect(await screen.findByText("Speed test cancelled.")).toBeInTheDocument();
  });
});
