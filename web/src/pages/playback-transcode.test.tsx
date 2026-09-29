import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setSession } from "@/api/token";
import { renderWithProviders } from "@/test/render";
import { installFetchRoutes } from "@/test/fetch-routes";
import { createdSession, remuxPlan } from "@/test/transcoding-fixtures";
import { PlaybackPage } from "./playback";

vi.mock("@tanstack/react-router", () => ({
  useSearch: () => ({}),
  Link: ({ children }: { children: React.ReactNode }) => <a href="/transcoding">{children}</a>,
}));
vi.mock("@/components/hls-player", () => ({
  HlsPlayer: ({ src, label }: { src: string; label: string }) => <div role="region" aria-label={label} data-src={src} />,
}));

const resolveResponse = {
  releaseId: "rel-ac3",
  status: "ready",
  streamUrl: "http://server:8080/api/v1/stream/tok-ac3",
  container: "mkv",
  sizeBytes: 1_000_000,
  runTimeTicks: 300_000_000,
  mediaStreams: [{ type: "Video", codec: "h264", width: 1920, height: 1080 }],
  sessionTtlSeconds: 3600,
  suggestedFallbackReleaseId: null,
};

describe("PlaybackPage — server transcode mode", () => {
  beforeEach(() => setSession({ username: "admin", role: "admin", expiresAt: new Date(Date.now() + 3_600_000).toISOString() }));
  afterEach(() => vi.restoreAllMocks());

  it("keeps direct play as the default and transcodes the same stream capability on request", async () => {
    const user = userEvent.setup();
    const { requests } = installFetchRoutes({
      "POST /api/v1/resolve": () => resolveResponse,
      "POST /api/v1/transcoding/sessions": () => ({ status: 201, body: createdSession() }),
      "DELETE /api/v1/transcode/cap-token-123": () => ({ status: 204 }),
    });
    const { unmount } = renderWithProviders(<PlaybackPage />);

    await user.type(screen.getByPlaceholderText(/release id/i), "rel-ac3");
    await user.click(screen.getByRole("button", { name: /resolve & load/i }));

    const direct = await screen.findByRole("radio", { name: /direct play/i });
    expect(direct).toHaveAttribute("aria-checked", "true");
    expect(document.querySelector("video")).toHaveAttribute("src", "/api/v1/stream/tok-ac3");

    await user.click(screen.getByRole("radio", { name: /server transcode/i }));

    const player = await screen.findByRole("region", { name: "Transcoded preview" });
    expect(player).toHaveAttribute("data-src", "/api/v1/transcode/cap-token-123/master.m3u8");
    expect(document.querySelector("video")).toBeNull();
    const create = requests.find((r) => r.method === "POST" && r.path.endsWith("/transcoding/sessions"));
    expect(create?.body).toMatchObject({ streamToken: "tok-ac3", maxHeight: 1080 });
    expect(screen.getAllByText(/VideoToolbox decode\+encode/)[0]).toBeVisible();

    unmount();
    await waitFor(() => expect(requests.some((r) => r.method === "DELETE" && r.path === "/api/v1/transcode/cap-token-123")).toBe(true));
  });

  it("asks for a stream copy in remux mode and explains the copy", async () => {
    const user = userEvent.setup();
    const { requests } = installFetchRoutes({
      "POST /api/v1/resolve": () => resolveResponse,
      "POST /api/v1/transcoding/sessions": () => ({ status: 201, body: createdSession({ mode: "remux", plan: remuxPlan() }) }),
      "DELETE /api/v1/transcode/cap-token-123": () => ({ status: 204 }),
    });
    renderWithProviders(<PlaybackPage />);

    await user.type(screen.getByPlaceholderText(/release id/i), "rel-ac3");
    await user.click(screen.getByRole("button", { name: /resolve & load/i }));
    await user.click(await screen.findByRole("radio", { name: /server remux/i }));

    expect(await screen.findByRole("region", { name: "Remuxed preview" })).toHaveAttribute("data-src", "/api/v1/transcode/cap-token-123/master.m3u8");
    const create = requests.find((r) => r.method === "POST" && r.path.endsWith("/transcoding/sessions"));
    expect(create?.body).toMatchObject({ streamToken: "tok-ac3", mode: "remux" });
    expect(create?.body).not.toHaveProperty("maxHeight");
    expect(screen.getAllByText(/stream copy \(remux\)/)[0]).toBeVisible();
    expect(screen.getByRole("button", { name: /restart remux/i })).toBeVisible();
  });

  it("links to the settings when transcoding is disabled", async () => {
    const user = userEvent.setup();
    installFetchRoutes({
      "POST /api/v1/resolve": () => resolveResponse,
      "POST /api/v1/transcoding/sessions": () => ({
        status: 409,
        body: { error: { code: "transcoding_disabled", message: "Server-side transcoding is disabled in the settings." } },
      }),
    });
    renderWithProviders(<PlaybackPage />);

    await user.type(screen.getByPlaceholderText(/release id/i), "rel-ac3");
    await user.click(screen.getByRole("button", { name: /resolve & load/i }));
    await user.click(await screen.findByRole("radio", { name: /server transcode/i }));

    expect(await screen.findByText(/transcoding is disabled in the settings/i)).toBeVisible();
    expect(screen.getByRole("link", { name: /open transcoding settings/i })).toBeVisible();
  });
});
