import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { queryKeys } from "@/api/queries";
import { setSession } from "@/api/token";
import { renderWithProviders } from "@/test/render";
import { isActiveRepairState, RepairsPage } from "./repairs";

const overview = {
  enabled: true,
  policy: "whenNoFallback",
  cacheBytesUsed: 1_024,
  cacheBudgetBytes: 8_192,
  artifacts: [
    {
      fingerprint: "abc123",
      releaseTitle: "Cached release",
      bytes: 1_024,
      createdUtc: "2026-08-06T08:00:00Z",
      lastAccessUtc: "2026-08-06T09:00:00Z",
      pinCount: 1,
    },
  ],
  jobs: [
    {
      jobId: "finished/job",
      releaseTitle: "Older finished release",
      state: "ready",
      disposition: "repairable",
      createdAtUtc: "2026-08-06T08:00:00Z",
      completedAtUtc: "2026-08-06T08:05:00Z",
      progressPercent: 100,
      events: [],
    },
    {
      jobId: "active/job",
      releaseTitle: "Newest active release",
      state: "downloadingRecovery",
      phase: "recovery",
      disposition: "repairable",
      createdAtUtc: "2026-08-06T09:00:00Z",
      progressPercent: 40,
      processedBytes: 400,
      totalBytes: 1_000,
      damagedBlocks: 2,
      recoveryBlocksUsed: 2,
      events: [
        { atUtc: "2026-08-06T09:02:00Z", state: "downloadingRecovery", message: "second" },
        { atUtc: "2026-08-06T09:01:00Z", state: "planning", message: "first" },
      ],
    },
  ],
};

let cancelled: string[];

function installFetch(repairOverview: unknown = overview) {
  cancelled = [];
  let repairFailure = false;
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const cancel = url.match(/\/repairs\/([^/]+)\/cancel$/);
    if (cancel && method === "POST") {
      cancelled.push(decodeURIComponent(cancel[1]));
      return jsonResponse(204, undefined);
    }
    if (url.endsWith("/repairs") && method === "GET") {
      return repairFailure
        ? jsonResponse(503, {
            error: { code: "repair_refresh_failed", message: "Temporary repair failure." },
          })
        : jsonResponse(200, repairOverview);
    }
    return jsonResponse(404, { error: { code: "not_found", message: "not found" } });
  }));
  return {
    setRepairFailure(value: boolean) {
      repairFailure = value;
    },
  };
}

function jsonResponse(status: number, body: unknown): Promise<Response> {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    headers: new Headers(body === undefined ? {} : { "content-type": "application/json" }),
    text: () => Promise.resolve(body === undefined ? "" : JSON.stringify(body)),
    clone: () => ({ json: () => Promise.resolve(body) }),
  } as unknown as Response);
}

describe("RepairsPage", () => {
  beforeEach(() => {
    setSession({ username: "admin", role: "admin", expiresAt: "2099-01-01T00:00:00Z" });
    installFetch();
  });

  it("sorts jobs newest-first and expands events chronologically", async () => {
    const user = userEvent.setup();
    renderWithProviders(<RepairsPage />);

    const table = await screen.findByRole("region", { name: "Repair jobs" });
    const rows = within(table).getAllByRole("row");
    expect(rows[1]).toHaveTextContent("Newest active release");
    expect(rows[2]).toHaveTextContent("Older finished release");
    expect(
      within(screen.getByRole("region", { name: "Repair artifacts" })).getByText("Cached release"),
    ).toBeInTheDocument();

    await user.click(within(table).getByRole("button", { name: /toggle event log for newest/i }));
    const log = screen.getByRole("log", { name: /newest active release/i });
    expect(log).toHaveAttribute("tabindex", "0");
    expect(within(log).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      expect.stringContaining("first"),
      expect.stringContaining("second"),
    ]);
  });

  it("keeps compact titles contained and desktop columns within the page", async () => {
    renderWithProviders(<RepairsPage />);

    const compactJobs = await screen.findByRole("list", { name: "Repair jobs" });
    const compactTitle = within(compactJobs).getByRole("button", {
      name: /toggle event log for newest active release/i,
    });
    expect(compactJobs).toHaveClass("xl:hidden");
    expect(compactTitle).toHaveClass("min-w-0", "overflow-hidden");
    expect(within(compactTitle).getByText("Newest active release")).toHaveClass(
      "[overflow-wrap:anywhere]",
    );

    const desktopJobs = screen.getByRole("region", { name: "Repair jobs" });
    const table = within(desktopJobs).getByRole("table");
    expect(desktopJobs).toHaveClass("xl:block");
    expect(table).toHaveClass("table-fixed");
    expect(within(table).getAllByRole("columnheader")).toHaveLength(7);
  });

  it("dismisses cancellation safely and restores focus to the trigger", async () => {
    const user = userEvent.setup();
    renderWithProviders(<RepairsPage />);
    const table = await screen.findByRole("region", { name: "Repair jobs" });
    const trigger = within(table).getByRole("button", { name: /cancel repair job newest/i });

    await user.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Cancel repair job?" });
    expect(dialog).toHaveTextContent("Newest active release");
    const keep = within(dialog).getByRole("button", { name: /keep repair job newest/i });
    await waitFor(() => expect(keep).toHaveFocus());

    await user.click(keep);

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
    expect(cancelled).toEqual([]);
  });

  it("requires descriptive confirmation and URL-encodes the job id before cancelling", async () => {
    const user = userEvent.setup();
    renderWithProviders(<RepairsPage />);
    const table = await screen.findByRole("region", { name: "Repair jobs" });

    await user.click(within(table).getByRole("button", { name: /cancel repair job newest/i }));
    const dialog = screen.getByRole("dialog", { name: "Cancel repair job?" });
    await user.click(
      within(dialog).getByRole("button", { name: /confirm cancellation of newest/i }),
    );

    await waitFor(() => expect(cancelled).toEqual(["active/job"]));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(
      within(table).queryByRole("button", { name: /cancel repair job older/i }),
    ).not.toBeInTheDocument();
  });

  it("shows a full initial error without claiming the artifact cache is empty", async () => {
    const controls = installFetch();
    controls.setRepairFailure(true);

    renderWithProviders(<RepairsPage />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Temporary repair failure.");
    expect(screen.queryByText(/no repair artifacts cached yet/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Repair jobs" })).not.toBeInTheDocument();
  });

  it("keeps cached jobs and artifacts visible when a background refresh fails", async () => {
    const controls = installFetch();
    const { queryClient } = renderWithProviders(<RepairsPage />);
    const jobsTable = await screen.findByRole("region", { name: "Repair jobs" });
    const artifactsTable = screen.getByRole("region", { name: "Repair artifacts" });

    controls.setRepairFailure(true);
    await queryClient.refetchQueries({ queryKey: queryKeys.repairs, exact: true });

    expect(await screen.findByRole("status")).toHaveTextContent(/showing the last repair data/i);
    expect(within(jobsTable).getByText("Newest active release")).toBeInTheDocument();
    expect(within(artifactsTable).getByText("Cached release")).toBeInTheDocument();
  });

  it("explains how to enable repair instead of presenting the normal empty state", async () => {
    installFetch({ ...overview, enabled: false, artifacts: [], jobs: [] });

    renderWithProviders(<RepairsPage />);

    expect(
      await screen.findByText(/PAR2 repair is disabled in the Core configuration/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/Streamarr:Repair:Enabled/i)).toBeInTheDocument();
    expect(screen.queryByText(/No repair jobs yet/i)).not.toBeInTheDocument();
  });

  it("renders active zero-total work as indeterminate progress", async () => {
    installFetch({
      ...overview,
      artifacts: [],
      jobs: [
        {
          ...overview.jobs[1],
          jobId: "queued/job",
          releaseTitle: "Queued release",
          state: "queued",
          phase: "planning",
          progressPercent: 0,
          processedBytes: 0,
          totalBytes: 0,
          events: [],
        },
      ],
    });

    renderWithProviders(<RepairsPage />);

    const jobsTable = await screen.findByRole("region", { name: "Repair jobs" });
    const progress = within(jobsTable).getByRole("progressbar", { name: "Repair progress" });
    expect(progress).not.toHaveAttribute("aria-valuenow");
    expect(progress).not.toHaveAttribute("aria-valuemin");
    expect(progress).not.toHaveAttribute("aria-valuemax");
    expect(progress).toHaveAttribute("aria-valuetext", "Total size pending");
    expect(within(jobsTable).getByText("queued")).toHaveClass("text-amber-800");
    expect(within(jobsTable).getByText("Preparing…")).toBeInTheDocument();
    expect(within(jobsTable).getByText("Total size pending")).toBeInTheDocument();
    expect(progress.firstElementChild).toHaveClass("w-1/3", "animate-pulse");
  });
});

describe("isActiveRepairState", () => {
  it.each(["queued", "planning", "materializingSources", "downloadingRecovery", "reconstructing", "verifying"])(
    "classifies %s as active",
    (state) => expect(isActiveRepairState(state)).toBe(true),
  );

  it.each([
    undefined,
    null,
    "",
    "none",
    "ready",
    "failed",
    "cancelled",
    "evicted",
    "unknown",
    "completed-in-a-future-core",
  ])(
    "classifies %s as terminal",
    (state) => expect(isActiveRepairState(state)).toBe(false),
  );
});
