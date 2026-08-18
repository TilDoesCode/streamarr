import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setSession } from "@/api/token";
import { renderWithProviders } from "@/test/render";
import { PreDownloadSettings } from "./pre-download-settings";

const defaultConfig = {
  enabled: false,
  downloadCurrentFile: true,
  currentFileThresholdSeconds: 10,
  downloadNextEpisode: true,
  nextEpisodeThresholdPercent: 75,
  maxConcurrentDownloads: 1,
};

let config = { ...defaultConfig };
let saved: Record<string, unknown> | undefined;
let getStatus = 200;

describe("PreDownloadSettings", () => {
  beforeEach(() => {
    config = { ...defaultConfig };
    saved = undefined;
    getStatus = 200;
    setSession({
      username: "admin",
      role: "admin",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    installFetch();
  });

  afterEach(() => vi.restoreAllMocks());

  it("loads the complete policy and explains the paused state", async () => {
    renderWithProviders(<PreDownloadSettings />);

    const master = await screen.findByRole("switch", { name: "Enable pre-download" });
    expect(master).not.toBeChecked();
    expect(screen.getByRole("status")).toHaveTextContent("Background caching is paused");
    expect(screen.getByRole("switch", { name: "Download the current file" })).toBeDisabled();
    expect(screen.getByRole("switch", { name: "Download the next episode" })).toBeDisabled();
    expect(screen.getByLabelText("Playback grace period")).toHaveValue(10);
    expect(screen.getByLabelText("Playback grace period")).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByLabelText("Watch-progress trigger")).toHaveValue(75);
    expect(screen.getByLabelText("Concurrent pre-downloads")).toHaveValue(1);
    expect(screen.getByText("Lower than explicit playback")).toBeInTheDocument();
    expect(screen.getByText("Shared ephemeral hard TTL")).toBeInTheDocument();
  });

  it("enables the policy and saves the full replacement contract", async () => {
    const user = userEvent.setup();
    renderWithProviders(<PreDownloadSettings />);

    await user.click(await screen.findByRole("switch", { name: "Enable pre-download" }));
    await replaceNumber(user, screen.getByLabelText("Playback grace period"), "20");
    await replaceNumber(user, screen.getByLabelText("Watch-progress trigger"), "80");
    await replaceNumber(user, screen.getByLabelText("Concurrent pre-downloads"), "2");
    await user.click(screen.getByRole("button", { name: "Save pre-download settings" }));

    await waitFor(() => expect(saved).toBeDefined());
    expect(saved).toEqual({
      enabled: true,
      downloadCurrentFile: true,
      currentFileThresholdSeconds: 20,
      downloadNextEpisode: true,
      nextEpisodeThresholdPercent: 80,
      maxConcurrentDownloads: 2,
    });
  });

  it("keeps a rule value while its switch is disabled", async () => {
    config.enabled = true;
    const user = userEvent.setup();
    renderWithProviders(<PreDownloadSettings />);

    const nextEpisode = await screen.findByRole("switch", { name: "Download the next episode" });
    await user.click(nextEpisode);

    expect(screen.getByLabelText("Watch-progress trigger")).toHaveAttribute("readonly");
    await user.click(screen.getByRole("button", { name: "Save pre-download settings" }));

    await waitFor(() => expect(saved).toBeDefined());
    expect(saved).toMatchObject({
      enabled: true,
      downloadNextEpisode: false,
      nextEpisodeThresholdPercent: 75,
    });
  });

  it("mirrors every server-side numeric bound and blocks invalid writes", async () => {
    config.enabled = true;
    const user = userEvent.setup();
    renderWithProviders(<PreDownloadSettings />);

    await screen.findByRole("switch", { name: "Enable pre-download" });
    await replaceNumber(user, screen.getByLabelText("Playback grace period"), "3601");
    await replaceNumber(user, screen.getByLabelText("Watch-progress trigger"), "0");
    await replaceNumber(user, screen.getByLabelText("Concurrent pre-downloads"), "9");
    await user.click(screen.getByRole("button", { name: "Save pre-download settings" }));

    expect(await screen.findByText("Must not exceed 3600 seconds")).toBeInTheDocument();
    expect(screen.getByText("Must be at least 1 percent")).toBeInTheDocument();
    expect(screen.getByText("Must not exceed 8")).toBeInTheDocument();
    expect(saved).toBeUndefined();
  });

  it("accepts the inclusive boundary values exposed by the API", async () => {
    config.enabled = true;
    const user = userEvent.setup();
    renderWithProviders(<PreDownloadSettings />);

    await screen.findByRole("switch", { name: "Enable pre-download" });
    await replaceNumber(user, screen.getByLabelText("Playback grace period"), "0");
    await replaceNumber(user, screen.getByLabelText("Watch-progress trigger"), "100");
    await replaceNumber(user, screen.getByLabelText("Concurrent pre-downloads"), "8");
    await user.click(screen.getByRole("button", { name: "Save pre-download settings" }));

    await waitFor(() => expect(saved).toBeDefined());
    expect(saved).toMatchObject({
      currentFileThresholdSeconds: 0,
      nextEpisodeThresholdPercent: 100,
      maxConcurrentDownloads: 8,
    });
  });

  it("renders a typed inline error when the config cannot load", async () => {
    getStatus = 503;
    renderWithProviders(<PreDownloadSettings />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Pre-download configuration is temporarily unavailable.",
    );
  });
});

function installFetch() {
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.includes("/config/pre-download") && method === "GET") {
      return getStatus === 200
        ? response(200, config)
        : response(503, {
          error: {
            code: "pre_download_config_unavailable",
            message: "Pre-download configuration is temporarily unavailable.",
          },
        });
    }
    if (url.includes("/config/pre-download") && method === "PUT") {
      saved = JSON.parse(init?.body as string) as Record<string, unknown>;
      config = { ...config, ...saved } as typeof config;
      return response(200, config);
    }
    return response(404, { error: { code: "not_found", message: "no" } });
  }));
}

function response(status: number, body: unknown): Promise<Response> {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 503 ? "Service Unavailable" : "",
    headers: new Headers({ "content-type": "application/json" }),
    text: () => Promise.resolve(JSON.stringify(body)),
    clone: () => ({ json: () => Promise.resolve(body) }),
  } as unknown as Response);
}

async function replaceNumber(
  user: ReturnType<typeof userEvent.setup>,
  input: HTMLElement,
  value: string,
) {
  await user.clear(input);
  await user.type(input, value);
}
