import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test/render";
import { installFetchRoutes } from "@/test/fetch-routes";
import { setSession } from "@/api/token";
import { abortError, DEFAULT_OPTIONS, type Clock, type SpeedTestTransport } from "@/lib/speedtest";
import type { DiagnosticsResponse } from "@/api/types";
import { DiagnosticsPage } from "./index";
import { SpeedTestCard, useBrowserSpeedTest } from "./speed-test-card";
import { hintText, HINT_TEXT } from "./text";
import { BROWSER_RESULT_KEY } from "@/lib/streaming-path";

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

function usenetResult(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    status: "ok",
    code: null,
    measuredAt: new Date(now - 120_000).toISOString(),
    megabitsPerSecond: 250,
    provider: { index: 1, role: "primary", name: "Newshosting", code: "ok", error: null },
    fallbackUsed: false,
    attempts: [{ index: 1, role: "primary", name: "Newshosting", code: "ok", error: null }],
    connectionsUsed: 8,
    connectionsMax: 20,
    activeStreams: 0,
    bytesDownloaded: 250_000_000,
    durationMs: 8_000,
    firstByteMs: 120,
    reused: false,
    joined: false,
    freshUntil: new Date(now).toISOString(),
    ...overrides,
  };
}

describe("StreamingPathCard", () => {
  beforeEach(() => {
    localStorage.removeItem(BROWSER_RESULT_KEY);
    setSession({ username: "admin", role: "admin", expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
  });
  afterEach(() => {
    localStorage.removeItem(BROWSER_RESULT_KEY);
    vi.unstubAllGlobals();
  });

  const base = { "GET /api/v1/diagnostics": () => diagnostics({ status: "ok", hints: [] }), ...noSpeedTest };

  it("shows both legs and names the slower one as the bottleneck", async () => {
    localStorage.setItem(
      BROWSER_RESULT_KEY,
      JSON.stringify({ downloadMbps: 38, uploadMbps: 12, pingMs: 4, measuredAt: new Date(Date.now() - 300_000).toISOString() }),
    );
    installFetchRoutes({ ...base, "GET /api/v1/diagnostics/usenet-speed": () => ({ running: false, allowed: true, latest: usenetResult() }) });
    renderWithProviders(<DiagnosticsPage />);

    const usenet = await screen.findByTestId("streaming-path-usenet");
    expect(await within(usenet).findByText("250 Mbit/s")).toBeInTheDocument();
    expect(within(usenet).getByText(/measured 2m ago · Primary · Newshosting/)).toBeInTheDocument();
    expect(within(usenet).getByText("8/20 connections used")).toBeInTheDocument();
    const browser = screen.getByTestId("streaming-path-browser");
    expect(within(browser).getByText("38 Mbit/s")).toBeInTheDocument();
    expect(within(browser).getByText(/measured 5m ago/)).toBeInTheDocument();
    expect(within(browser).getByText("Bottleneck")).toBeInTheDocument();
    expect(screen.getByTestId("streaming-path-verdict")).toHaveTextContent(
      "This browser is the bottleneck: ~38 Mbit/s → 4K WEB and 1080p play smoothly; 4K remuxes (~80 Mbit/s) will buffer.",
    );
  });

  it("says which leg is missing when only Usenet is measured", async () => {
    installFetchRoutes({ ...base, "GET /api/v1/diagnostics/usenet-speed": () => ({ running: false, allowed: true, latest: usenetResult({ megabitsPerSecond: 25 }) }) });
    renderWithProviders(<DiagnosticsPage />);
    const verdict = await screen.findByTestId("streaming-path-verdict");
    await waitFor(() => expect(verdict).toHaveTextContent(/Usenet delivers ~25 Mbit\/s → 1080p plays; 4K will buffer/));
    expect(verdict).toHaveTextContent(/Server → This browser is not measured yet/);
    expect(within(screen.getByTestId("streaming-path-browser")).getByText("Not measured yet.")).toBeInTheDocument();
  });

  it("Measure all runs the Usenet test before the browser test", async () => {
    const { requests } = installFetchRoutes({
      ...base,
      "GET /api/v1/diagnostics/usenet-speed": () => ({ running: false, allowed: true, latest: null }),
      "POST /api/v1/diagnostics/usenet-speed": () => usenetResult({ megabitsPerSecond: 90, measuredAt: new Date().toISOString() }),
    });
    renderWithProviders(<DiagnosticsPage />);
    await userEvent.click(await screen.findByRole("button", { name: /Measure all/ }));

    await waitFor(() => expect(requests.some((r) => r.path === "/api/v1/diagnostics/ping")).toBe(true));
    const post = requests.findIndex((r) => r.method === "POST" && r.path === "/api/v1/diagnostics/usenet-speed");
    const ping = requests.findIndex((r) => r.path === "/api/v1/diagnostics/ping");
    expect(post).toBeGreaterThanOrEqual(0);
    expect(post).toBeLessThan(ping);
    expect(await within(screen.getByTestId("streaming-path-usenet")).findByText("90 Mbit/s")).toBeInTheDocument();
  });

  it("explains a 503 when every provider connection is busy", async () => {
    installFetchRoutes({
      ...base,
      "GET /api/v1/diagnostics/usenet-speed": () => ({ running: false, allowed: true, latest: null }),
      "POST /api/v1/diagnostics/usenet-speed": () => ({
        status: 503,
        body: { error: { code: "usenet_speedtest_no_free_connections", message: "No free connections." } },
      }),
    });
    renderWithProviders(<DiagnosticsPage />);
    await userEvent.click(await screen.findByRole("button", { name: "Test Usenet" }));
    expect(await screen.findByTestId("usenet-busy")).toHaveTextContent(
      "All provider connections are busy with streams — try again when fewer streams are playing",
    );
  });

  it("notes a fallback provider, playing streams and a shared result", async () => {
    installFetchRoutes({
      ...base,
      "GET /api/v1/diagnostics/usenet-speed": () => ({
        running: false,
        allowed: true,
        latest: usenetResult({
          megabitsPerSecond: 120,
          provider: { index: 2, role: "backup", name: "Eweka", code: "ok", error: null },
          fallbackUsed: true,
          attempts: [
            { index: 1, role: "primary", name: "Newshosting", code: "auth_failed", error: "481 authentication failed" },
            { index: 2, role: "backup", name: "Eweka", code: "ok", error: null },
          ],
          activeStreams: 2,
          reused: true,
        }),
      }),
    });
    renderWithProviders(<DiagnosticsPage />);
    const usenet = await screen.findByTestId("streaming-path-usenet");
    expect(await within(usenet).findByText(/Backup #2 · Eweka/)).toBeInTheDocument();
    const notes = within(usenet).getByTestId("usenet-notes");
    expect(notes).toHaveTextContent("Primary failed (auth_failed: 481 authentication failed) — measured the backup");
    expect(notes).toHaveTextContent("Measured while 2 streams were playing — a lower bound");
    expect(within(usenet).getByText(/Recent shared result from .* \(tests are shared for 2 minutes\)/)).toBeInTheDocument();
  });

  it("shows a failed Usenet test with its code and error", async () => {
    installFetchRoutes({
      ...base,
      "GET /api/v1/diagnostics/usenet-speed": () => ({
        running: false,
        allowed: true,
        latest: usenetResult({
          status: "failed",
          code: "auth_failed",
          megabitsPerSecond: null,
          provider: { index: 1, role: "primary", name: "Newshosting", code: "auth_failed", error: "481 authentication failed" },
          attempts: [{ index: 1, role: "primary", name: "Newshosting", code: "auth_failed", error: "481 authentication failed" }],
        }),
      }),
    });
    renderWithProviders(<DiagnosticsPage />);
    const failed = await screen.findByTestId("usenet-failed");
    expect(failed).toHaveTextContent("Failed: Login rejected (auth_failed)");
    expect(failed).toHaveTextContent("Primary · Newshosting: auth_failed: 481 authentication failed");
    expect(screen.getByTestId("streaming-path-verdict")).toHaveTextContent(/Neither leg is measured yet/);
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
    return <Harness transport={transport(bytesPerChunk, advance)} clock={clock} options={options} />;
  }

  // The details card has no start of its own; the Streaming path card's "Test browser" runs the shared test.
  function Harness(props: Parameters<typeof useBrowserSpeedTest>[0]) {
    const test = useBrowserSpeedTest(props);
    return (
      <>
        <button onClick={() => void test.start()}>Test browser</button>
        <SpeedTestCard test={test} />
      </>
    );
  }

  it("runs the test and shows results with the streaming verdict", async () => {
    // 1 MB per 5 virtual ms ≈ 1.6 Gbit/s: every tier passes.
    renderWithProviders(card(1_000_000));
    await userEvent.click(screen.getByRole("button", { name: /Test browser/ }));
    expect(await screen.findByText(/comfortably stream up to 4K HDR remux/, {}, { timeout: 3_000 })).toBeInTheDocument();
    expect(screen.getByTestId("speed-download")).toHaveTextContent(/Mbit\/s/);
    expect(screen.getByTestId("speed-upload")).toHaveTextContent(/Mbit\/s/);
    expect(screen.getByText("needs 100 Mbit/s")).toBeInTheDocument();
    expect(within(screen.getByTestId("browser-speed-test-card")).queryByRole("button")).toBeNull();
    const stored = JSON.parse(localStorage.getItem(BROWSER_RESULT_KEY) ?? "null") as { downloadMbps: number; measuredAt: string };
    expect(stored.downloadMbps).toBeGreaterThan(100);
    expect(Date.parse(stored.measuredAt)).not.toBeNaN();
  });

  it("reports a slow link and can be cancelled", async () => {
    renderWithProviders(card(100));
    await userEvent.click(screen.getByRole("button", { name: /Test browser/ }));
    expect(await screen.findByText(/too slow for smooth 720p/, {}, { timeout: 3_000 })).toBeInTheDocument();

    renderWithProviders(card(100, { ...fastOptions, durationMs: 60_000 }));
    await userEvent.click(screen.getAllByRole("button", { name: /Test browser/ }).at(-1)!);
    await userEvent.click(await screen.findByRole("button", { name: /Cancel/ }));
    expect(await screen.findByText("Speed test cancelled.")).toBeInTheDocument();
  });
});
