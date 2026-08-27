import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithProviders } from "@/test/render";
import { TtffFlamegraph } from "./overview-tab";

describe("TtffFlamegraph", () => {
  it("renders the request→first-frame waterfall and hides post-startup noise", async () => {
    renderWithProviders(
      <TtffFlamegraph
        spans={[
          { name: "nzb-fetch", category: "nzb", startMs: 0, durationMs: 42, detail: "cache", source: "server" },
          { name: "health-check", category: "health", startMs: 44, durationMs: 210, detail: "0/24 missing", source: "server" },
          { name: "materialize", category: "materialize", startMs: 44, durationMs: 690, detail: "580 segments", source: "server" },
          { name: "ffprobe", category: "probe", startMs: 736, durationMs: 122, detail: null, source: "server" },
          { name: "stream-first-byte", category: "stream", startMs: 1_240, durationMs: 480, detail: "pos=0", source: "server" },
          { name: "stream-first-byte", category: "stream", startMs: 3_796_000, durationMs: 2, detail: "pos=4000000", source: "server" },
          { name: "pacing-engaged", category: "stream", startMs: 700_000, durationMs: 0, detail: null, source: "server" },
          { name: "jellyfin-open", category: "client", startMs: 0, durationMs: 1_180, detail: "ready", source: "client" },
          { name: "jellyfin-open", category: "client", startMs: 0, durationMs: 1_220, detail: "ready", source: "client" },
        ]}
      />,
    );

    expect(screen.getByText("nzb-fetch")).toBeInTheDocument();
    expect(screen.getByText("stream-first-byte")).toBeInTheDocument();
    expect(screen.getByText("jellyfin-open")).toBeInTheDocument();
    expect(screen.getAllByText("1.72s").length).toBeGreaterThan(0);
    expect(screen.getByRole("note")).toHaveTextContent("3 duplicate or post-startup events hidden");
    expect(screen.queryByText("pacing-engaged")).not.toBeInTheDocument();
  });

  it("renders nothing when there are no timeline spans", () => {
    const { container } = renderWithProviders(<TtffFlamegraph spans={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
