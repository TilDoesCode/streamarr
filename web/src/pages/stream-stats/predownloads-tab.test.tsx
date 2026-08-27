import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { ApiError } from "@/api/client";
import { renderWithProviders } from "@/test/render";
import { PreDownloadDiagnostics, type PreDownloadQueryState } from "./predownloads-tab";

const token = "stream-capability-token";
const now = Date.now();

const nextEpisodeJob = {
  id: "job-next-episode-7",
  state: "downloading",
  kind: "nextEpisode",
  reason: "Watch progress reached 75%",
  priority: "low",
  sourceToken: token,
  sourceReleaseId: "Asterion.Station.S02E06.2160p.WEB-DL.DDP5.1.HDR.HEVC-ORBIT",
  sourceWorkId: "tvdb:438271:s02e06",
  targetToken: "prepared-episode-token",
  targetReleaseId: "Asterion.Station.S02E07.2160p.WEB-DL-ORBIT",
  targetWorkId: "tvdb:438271:s02e07",
  targetTitle: "Asterion Station — Signal in the Dust",
  targetSeasonNumber: 2,
  targetEpisodeNumber: 7,
  bytesDownloaded: 7_158_266_838,
  totalBytes: 18_643_921_810,
  progressPercent: 38.4,
  watchPositionTicks: 18_300_000_000,
  watchDurationTicks: 24_000_000_000,
  watchProgressPercent: 76.25,
  triggerThreshold: 75,
  triggerUnit: "percent",
  queuedAt: new Date(now - 45_000).toISOString(),
  startedAt: new Date(now - 42_000).toISOString(),
  updatedAt: new Date(now - 1_000).toISOString(),
};

const skippedTargetJob = {
  ...nextEpisodeJob,
  id: "job-target-skipped",
  state: "skipped",
  sourceToken: "originating-playback-token",
  sourceWorkId: "tvdb:438271:s02e05",
  targetToken: token,
  targetWorkId: "tvdb:438271:s02e06",
  targetTitle: "Asterion Station — The Quiet Array",
  targetSeasonNumber: 2,
  targetEpisodeNumber: 6,
  bytesDownloaded: 0,
  totalBytes: 0,
  progressPercent: 0,
  errorCode: "capacity",
  errorMessage: "The implicit download could not fit without displacing active content.",
  completedAt: new Date(now - 500).toISOString(),
};

function state(overrides: Partial<PreDownloadQueryState>): PreDownloadQueryState {
  return {
    data: [],
    dataUpdatedAt: now,
    isLoading: false,
    isError: false,
    isFetching: false,
    error: undefined,
    ...overrides,
  };
}

describe("PreDownloadDiagnostics", () => {
  it("shows an empty state when nothing has been triggered", () => {
    renderWithProviders(<PreDownloadDiagnostics sessionToken={token} state={state({ data: [] })} />);
    expect(screen.getByText("No pre-download has been triggered for this session")).toBeInTheDocument();
  });

  it("separates source watch intent from disk progress and identifies prepared targets", () => {
    renderWithProviders(
      <PreDownloadDiagnostics sessionToken={token} state={state({ data: [nextEpisodeJob, skippedTargetJob] })} />,
    );

    expect(screen.getByText("source session")).toBeInTheDocument();
    expect(screen.getByText("prepared target")).toBeInTheDocument();
    expect(screen.getByText("S02E07 · Asterion Station — Signal in the Dust")).toBeInTheDocument();
    expect(screen.getAllByRole("progressbar", { name: /client-reported watch progress/i })[0]).toHaveAttribute("aria-valuenow", "76");
    expect(screen.getAllByRole("progressbar", { name: /ephemeral disk pre-download progress/i })[0]).toHaveAttribute("aria-valuenow", "38");
    expect(screen.getAllByText(/never inferred from download bytes/i).length).toBeGreaterThan(0);
    expect(screen.getByText("capacity")).toBeInTheDocument();
    expect(screen.getByText(/could not fit without displacing active content/i)).toBeInTheDocument();
  });

  it("keeps the panel available while job telemetry is still loading", () => {
    renderWithProviders(
      <PreDownloadDiagnostics sessionToken={token} state={state({ data: undefined, isLoading: true, isFetching: true, dataUpdatedAt: 0 })} />,
    );
    expect(screen.getByLabelText("Loading pre-download jobs")).toBeInTheDocument();
  });

  it("shows a typed job telemetry error without a stale snapshot to fall back on", () => {
    const error = new ApiError(503, "telemetry_unavailable", "The pre-download job sampler is temporarily unavailable.", null);
    renderWithProviders(
      <PreDownloadDiagnostics sessionToken={token} state={state({ data: undefined, isError: true, dataUpdatedAt: 0, error })} />,
    );
    expect(screen.getByText("Pre-download telemetry is unavailable")).toBeInTheDocument();
    expect(screen.getByText("The pre-download job sampler is temporarily unavailable.")).toBeInTheDocument();
  });

  it("retains the last job snapshot and marks it stale when a refresh fails", () => {
    const error = new ApiError(503, "telemetry_unavailable", "The pre-download job sampler is temporarily unavailable.", null);
    renderWithProviders(
      <PreDownloadDiagnostics sessionToken={token} state={state({ data: [nextEpisodeJob], isError: true, error })} />,
    );
    expect(screen.getByText(/showing the last job snapshot/i)).toBeInTheDocument();
    expect(screen.getByText("S02E07 · Asterion Station — Signal in the Dust")).toBeInTheDocument();
  });
});
