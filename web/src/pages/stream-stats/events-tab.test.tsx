import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "@/test/render";
import { EventLog, EventTimeline } from "./events-tab";

const now = Date.now();

describe("EventTimeline", () => {
  it("renders correlated client playback events", () => {
    renderWithProviders(
      <EventTimeline
        events={[{
          id: 71,
          releaseId: "Asterion.Station.S02E06.2160p.WEB-DL.DDP5.1.HDR.HEVC-ORBIT",
          workId: "tvdb:438271:s02e06",
          title: "Asterion Station — The Quiet Array",
          event: "progress",
          positionTicks: 18_420_000_000,
          source: "jellyfin",
          playbackSessionId: "jf-playback-55",
          externalUserName: "Mara Voss",
          deviceName: "Shield TV Pro",
          receivedAt: new Date(now - 30_000).toISOString(),
        }]}
      />,
    );
    expect(screen.getByText("Shield TV Pro", { exact: false })).toBeInTheDocument();
    expect(screen.getByText("Mara Voss", { exact: false })).toBeInTheDocument();
  });

  it("explains that nothing has arrived yet", () => {
    renderWithProviders(<EventTimeline events={[]} />);
    expect(screen.getByText(/no correlated playback events/i)).toBeInTheDocument();
  });
});

describe("EventLog", () => {
  it("renders the chronological resolve/repair/lifecycle history", () => {
    renderWithProviders(
      <EventLog
        events={[
          { atUtc: new Date(now - 40 * 60_000).toISOString(), source: "ttff", category: "nzb", name: "nzb-fetch", detail: "cache" },
          { atUtc: new Date(now - 39 * 60_000).toISOString(), source: "repair", category: "Failed", name: "Failed", detail: "failed: the release carries no PAR2 set" },
          { atUtc: new Date(now - 20 * 60_000).toISOString(), source: "lifecycle", category: "closed", name: "closed", detail: null },
        ]}
      />,
    );
    expect(screen.getByText(/failed: the release carries no PAR2 set/i)).toBeInTheDocument();
    expect(screen.getAllByText("nzb-fetch").length).toBeGreaterThan(0);
  });

  it("explains that no diagnostic events were recorded", () => {
    renderWithProviders(<EventLog events={[]} />);
    expect(screen.getByText(/no diagnostic events were recorded/i)).toBeInTheDocument();
  });
});
