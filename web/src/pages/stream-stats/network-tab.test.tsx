import { UserRound } from "lucide-react";
import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test/render";
import { DataPath, DetailCell, Identifier, LedgerRow, NetworkTab } from "./network-tab";

describe("NetworkTab", () => {
  it("renders the live data path alongside identity and lifecycle details", () => {
    renderWithProviders(
      <NetworkTab
        dataPath={
          <DataPath
            client="jellyfin"
            connections={2}
            globalConnections={12}
            connectionBudget={16}
            cachedChunks={612}
            providers={[{ name: "Eweka EU", activeConnections: 7, tripped: false }]}
          />
        }
        detailCells={<DetailCell icon={<UserRound />} label="Requester" value="Mara Voss" detail="jf-user-7b29" />}
        ledgerRows={<LedgerRow label="MIME route" value="video/x-matroska" detail="direct byte-range delivery" />}
        identifiers={<Identifier label="Release ID" value="Asterion.Station.S02E06" />}
      />,
    );

    expect(screen.getByText("12/16 global · 1/1 providers ready")).toBeInTheDocument();
    expect(screen.getByText("Mara Voss")).toBeInTheDocument();
    expect(screen.getByText("video/x-matroska")).toBeInTheDocument();
    expect(screen.getByText("Asterion.Station.S02E06")).toBeInTheDocument();
  });

  it("omits the data path section for retained (non-live) streams", () => {
    renderWithProviders(
      <NetworkTab
        detailCells={<DetailCell icon={<UserRound />} label="Requester" value="Mara Voss" detail="jf-user-7b29" />}
        ledgerRows={<LedgerRow label="MIME route" value="video/x-matroska" detail="direct byte-range delivery" />}
        identifiers={<Identifier label="Stream token" value="stream-capability-token" secret />}
      />,
    );
    expect(screen.queryByText("The live data path")).not.toBeInTheDocument();
    expect(screen.getByText("Mara Voss")).toBeInTheDocument();
  });
});

describe("Identifier", () => {
  it("copies its value to the clipboard", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });

    renderWithProviders(<Identifier label="Release ID" value="Asterion.Station.S02E06" />);
    await user.click(screen.getByRole("button", { name: "Copy Release ID" }));

    expect(writeText).toHaveBeenCalledWith("Asterion.Station.S02E06");
  });
});
