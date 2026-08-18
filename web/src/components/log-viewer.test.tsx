import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { focusManager, onlineManager } from "@tanstack/react-query";
import { setSession } from "@/api/token";
import { renderWithProviders } from "@/test/render";
import { LogViewer } from "./log-viewer";

const generatedAt = "2026-08-17T12:30:00.000Z";
const feed = {
  generatedAt,
  hasMore: false,
  sources: [
    { source: "core", configured: true, available: true, lastCheckedAt: generatedAt },
    { source: "jellyfin", configured: true, available: false, message: "Jellyfin did not answer.", lastCheckedAt: generatedAt },
  ],
  entries: [
    {
      id: "core-17",
      atUtc: "2026-08-17T12:29:58.123Z",
      level: "Error",
      source: "core",
      category: "Streamarr.Server.Services.SessionManager",
      message: "Release became unavailable while streaming.",
      exception: "UsenetArticleNotFoundException: article missing\n   at SessionManager.OpenStream()",
      releaseId: "release-44",
      workId: "tmdb:movie:44",
    },
    {
      id: "jellyfin-9",
      atUtc: "2026-08-17T12:29:55.000Z",
      level: "Information",
      source: "jellyfin",
      category: "MediaBrowser.Controller.Session.SessionManager",
      message: "Playback stopped on Shield TV.",
    },
  ],
};

describe("LogViewer", () => {
  beforeEach(() => {
    setSession({ username: "admin", role: "admin", expiresAt: "2026-08-17T13:30:00.000Z" });
  });

  it("renders Core and Jellyfin entries, source health, and the complete exception", async () => {
    installFetch(feed);
    renderWithProviders(<LogViewer />);

    const log = await screen.findByRole("log", { name: "Core and Jellyfin logs" });
    expect(within(log).getByText("Release became unavailable while streaming.")).toBeInTheDocument();
    expect(within(log).getByText("Playback stopped on Shield TV.")).toBeInTheDocument();
    expect(within(log).getByText(/UsenetArticleNotFoundException/)).toBeInTheDocument();
    expect(screen.getByLabelText("Log source status")).toHaveTextContent("Core");
    expect(screen.getByLabelText("Log source status")).toHaveTextContent("Jellyfin unavailable");
    expect(screen.getByLabelText("Log source diagnostics")).toHaveTextContent(
      "Jellyfin unavailable: Jellyfin did not answer.",
    );
    expect(screen.getByText("Jellyfin did not answer.")).toBeVisible();
    expect(screen.getByText("release / release-44")).toBeInTheDocument();
  });

  it("keeps an expanded exception open when a newer row arrives", async () => {
    const user = userEvent.setup();
    const updatedFeed = {
      ...feed,
      entries: [
        {
          id: "core-18",
          atUtc: "2026-08-17T12:29:59.000Z",
          level: "Error",
          source: "core",
          category: "Streamarr.Server.Services.SessionManager",
          message: "A newer stream failure arrived.",
        },
        ...feed.entries,
      ],
    };
    let request = 0;
    vi.stubGlobal("fetch", vi.fn(() => jsonResponse(request++ === 0 ? feed : updatedFeed)));
    renderWithProviders(<LogViewer />);

    await screen.findByText("Release became unavailable while streaming.");
    await user.click(screen.getByText("Exception details"));
    expect(screen.getByText("Exception details").closest("details")).toHaveAttribute("open");

    await user.click(screen.getByRole("button", { name: "Refresh logs" }));
    await screen.findByText("A newer stream failure arrived.");
    expect(screen.getByText("Exception details").closest("details")).toHaveAttribute("open");
  });

  it("never requests more than the server's 500-entry maximum", async () => {
    const user = userEvent.setup();
    const fetchMock = installFetch({ ...feed, hasMore: true });
    renderWithProviders(<LogViewer />);

    await user.click(await screen.findByRole("button", { name: "Show more retained entries" }));
    await waitFor(() => expect(requestedLimits(fetchMock)).toContain(400));
    await user.click(await screen.findByRole("button", { name: "Show more retained entries" }));

    const cappedButton = await screen.findByRole("button", { name: "Refine filters for older entries" });
    expect(cappedButton).toBeDisabled();
    expect(requestedLimits(fetchMock)).toContain(500);
    expect(Math.max(...requestedLimits(fetchMock))).toBe(500);
  });

  it("keeps a paused snapshot frozen across window focus and reconnect events", async () => {
    const user = userEvent.setup();
    const fetchMock = installFetch(feed);
    renderWithProviders(<LogViewer />);

    await screen.findByRole("log", { name: "Core and Jellyfin logs" });
    await user.click(screen.getByRole("button", { name: "Pause" }));
    expect(screen.getByRole("button", { name: "Follow live" })).toBeInTheDocument();
    fetchMock.mockClear();

    focusManager.setFocused(false);
    focusManager.setFocused(true);
    onlineManager.setOnline(false);
    onlineManager.setOnline(true);
    await new Promise((resolve) => window.setTimeout(resolve, 20));

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps compact rows stacked until the container has desktop space", async () => {
    installFetch(feed);
    renderWithProviders(<LogViewer compact />);

    const log = await screen.findByRole("log", { name: "Core and Jellyfin logs" });
    const message = within(log).getByText("Release became unavailable while streaming.");
    const rowGrid = message.closest("li")?.firstElementChild;
    expect(rowGrid).toHaveClass("xl:grid-cols-[7.75rem_5.5rem_10rem_minmax(0,1fr)]");
    expect(rowGrid).not.toHaveClass("md:grid-cols-[7.75rem_5.5rem_10rem_minmax(0,1fr)]");
    expect(screen.getByRole("search")).toHaveClass(
      "xl:grid-cols-[minmax(16rem,1fr)_11rem_12rem_auto]",
    );
  });

  it("sends source, level, search and stream scope to the bounded log endpoint", async () => {
    const user = userEvent.setup();
    const fetchMock = installFetch({ ...feed, entries: [] });
    renderWithProviders(<LogViewer streamToken="stream token/7" compact />);

    await screen.findByText("No matching log entries");
    await user.selectOptions(screen.getByLabelText("Log source"), "jellyfin");
    await user.selectOptions(screen.getByLabelText("Minimum log level"), "error");
    await user.type(screen.getByLabelText("Search log messages"), "transcode failed");
    await user.click(screen.getByRole("button", { name: "Apply" }));

    await waitFor(() => {
      const urls = fetchMock.mock.calls.map(([input]) => String(input));
      expect(urls).toContain(
        "/api/v1/logs?source=jellyfin&minimumLevel=error&search=transcode+failed&streamToken=stream+token%2F7&limit=100",
      );
    });
    expect(screen.getByText("Core and Jellyfin events for this stream")).toBeInTheDocument();
  });

  it("does not report an unselected Jellyfin source as unavailable", async () => {
    const user = userEvent.setup();
    installFetch(feed);
    renderWithProviders(<LogViewer />);

    expect(await screen.findByText("Jellyfin did not answer.")).toBeVisible();
    await user.selectOptions(screen.getByLabelText("Log source"), "core");

    const statuses = await screen.findByLabelText("Log source status");
    expect(statuses).toHaveTextContent("Core available");
    expect(statuses).not.toHaveTextContent("Jellyfin");
    expect(screen.queryByLabelText("Log source diagnostics")).not.toBeInTheDocument();
  });

  it("shows a useful initial error instead of an empty console", async () => {
    vi.stubGlobal("fetch", vi.fn(() => errorResponse("The log collector is starting.")));
    renderWithProviders(<LogViewer />);

    expect(await screen.findByRole("alert")).toHaveTextContent("The log feed is unavailable");
    expect(screen.getByRole("alert")).toHaveTextContent("The log collector is starting.");
  });
});

function installFetch(body: unknown) {
  const fetchMock = vi.fn((_input: RequestInfo | URL) => jsonResponse(body));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function requestedLimits(fetchMock: ReturnType<typeof vi.fn>): number[] {
  return fetchMock.mock.calls
    .map(([input]) => new URL(String(input), "http://streamarr.test").searchParams.get("limit"))
    .filter((value): value is string => value !== null)
    .map(Number);
}

function jsonResponse(body: unknown): Promise<Response> {
  return Promise.resolve({
    ok: true,
    status: 200,
    statusText: "OK",
    headers: new Headers({ "content-type": "application/json" }),
    text: () => Promise.resolve(JSON.stringify(body)),
    clone: () => ({ json: () => Promise.resolve(body) }),
  } as unknown as Response);
}

function errorResponse(message: string): Promise<Response> {
  const body = { error: { code: "logs_unavailable", message } };
  return Promise.resolve({
    ok: false,
    status: 503,
    statusText: "Service Unavailable",
    headers: new Headers({ "content-type": "application/json" }),
    text: () => Promise.resolve(JSON.stringify(body)),
    clone: () => ({ json: () => Promise.resolve(body) }),
  } as unknown as Response);
}
