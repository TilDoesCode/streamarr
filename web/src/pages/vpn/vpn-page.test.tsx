import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test/render";
import { installFetchRoutes } from "@/test/fetch-routes";
import { setSession } from "@/api/token";
import type { TunnelResponse, TunnelStatusEntry } from "@/api/types";
import { connectedTunnel, presets, status, tunnel } from "@/test/tunnel-fixtures";
import { VpnPage } from "../vpn";

function statusList(tunnels: TunnelResponse[], override: Record<string, Partial<TunnelStatusEntry>> = {}) {
  return {
    checkedAt: new Date().toISOString(),
    tunnels: tunnels.map((t) => ({ id: t.id, name: t.name, enabled: t.enabled, status: t.status, ...override[t.id ?? ""] })),
  };
}

const allStates = [
  connectedTunnel,
  tunnel("t-start", "Proton Zurich", { preset: "protonvpn", status: status("starting") }),
  tunnel("t-deg", "Mullvad Frankfurt", { status: status("degraded", { lastError: "last handshake 3 min ago" }) }),
  tunnel("t-down", "AirVPN", { preset: "custom", status: status("down", { lastError: "helper not started yet" }) }),
  tunnel("t-off", "Spare", { enabled: false, status: status("disabled") }),
];

describe("VpnPage", () => {
  beforeEach(() => {
    setSession({ username: "admin", role: "admin", expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("explains the feature with one big Add tunnel button when there are no tunnels", async () => {
    installFetchRoutes({
      "GET /api/v1/tunnels": () => [],
      "GET /api/v1/tunnels/status": () => statusList([]),
      "GET /api/v1/tunnels/presets": () => presets,
    });
    const user = userEvent.setup();
    renderWithProviders(<VpnPage />);

    expect(await screen.findByText("Send indexer and Usenet traffic through your VPN")).toBeInTheDocument();
    const add = screen.getAllByRole("button", { name: /add tunnel/i });
    expect(add).toHaveLength(1);
    await user.click(add[0]);
    expect(await screen.findByRole("dialog", { name: "Add VPN tunnel" })).toBeInTheDocument();
    expect(await screen.findByRole("radio", { name: /Mullvad VPN/ })).toBeInTheDocument();
  });

  it("renders every state with its details, counters and usage", async () => {
    installFetchRoutes({
      "GET /api/v1/tunnels": () => allStates,
      "GET /api/v1/tunnels/status": () => statusList(allStates),
      "GET /api/v1/tunnels/presets": () => presets,
    });
    renderWithProviders(<VpnPage />);

    const connected = within(await screen.findByTestId("tunnel-t-conn"));
    expect(connected.getByText("Connected")).toBeInTheDocument();
    expect(connected.getAllByText("185.65.134.86").length).toBeGreaterThan(0);
    expect(connected.getByText("38 ms")).toBeInTheDocument();
    expect(connected.getByText(/^1\d+s ago$/)).toBeInTheDocument();
    expect(connected.getByText("1.5 GB")).toBeInTheDocument();
    expect(connected.getByText("50.0 MB")).toBeInTheDocument();
    expect(connected.getByText("3 indexers")).toHaveAttribute("title", "NZBGeek, DrunkenSlug, NZBFinder");
    expect(connected.getByText("1 provider")).toBeInTheDocument();
    expect(connected.getByText(/Mullvad VPN/)).toBeInTheDocument();

    expect(within(screen.getByTestId("tunnel-t-start")).getByText("Connecting")).toBeInTheDocument();
    expect(within(screen.getByTestId("tunnel-t-deg")).getByText("last handshake 3 min ago")).toBeInTheDocument();
    const down = within(screen.getByTestId("tunnel-t-down"));
    expect(down.getByText("Down")).toBeInTheDocument();
    expect(down.getByText("helper not started yet")).toBeInTheDocument();
    expect(down.getByText(/Custom WireGuard/)).toBeInTheDocument();
    expect(down.getByText(/nothing yet/)).toBeInTheDocument();
    expect(within(screen.getByTestId("tunnel-t-off")).getAllByText("Disabled").length).toBeGreaterThan(0);
    expect(screen.getByText(/5 tunnels · 1 connected · 1 connecting · 1 degraded · 1 down · 1 disabled/)).toBeInTheDocument();
  });

  it("merges the 5-second status poll into the cards", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const listed = tunnel("t1", "Mullvad Stockholm", { status: status("starting") });
    let polled: Partial<TunnelStatusEntry> = { status: status("starting") };
    const { requests } = installFetchRoutes({
      "GET /api/v1/tunnels": () => [listed],
      "GET /api/v1/tunnels/status": () => statusList([listed], { t1: polled }),
      "GET /api/v1/tunnels/presets": () => presets,
    });
    renderWithProviders(<VpnPage />);
    expect(await screen.findByText("Connecting")).toBeInTheDocument();

    polled = { status: status("connected", { exitIp: "185.65.134.86", latencyMs: 41 }) };
    await act(() => vi.advanceTimersByTimeAsync(5_100));

    expect(await screen.findByText("Connected")).toBeInTheDocument();
    expect(screen.getByText("41 ms")).toBeInTheDocument();
    expect(requests.filter((r) => r.path === "/api/v1/tunnels").length).toBe(1);
    expect(requests.filter((r) => r.path === "/api/v1/tunnels/status").length).toBeGreaterThanOrEqual(2);
  });

  it("tests a tunnel and shows the handshake result inline", async () => {
    installFetchRoutes({
      "GET /api/v1/tunnels": () => [connectedTunnel],
      "GET /api/v1/tunnels/status": () => statusList([connectedTunnel]),
      "GET /api/v1/tunnels/presets": () => presets,
      "POST /api/v1/tunnels/t-conn/test": () => ({
        success: true,
        handshakeOk: true,
        state: "connected",
        exitIp: "185.65.134.99",
        latencyMs: 44,
        lastHandshakeUtc: new Date().toISOString(),
      }),
    });
    const user = userEvent.setup();
    renderWithProviders(<VpnPage />);
    await user.click(await screen.findByRole("button", { name: "Test Mullvad Stockholm" }));

    const result = await screen.findByText("Handshake OK");
    const row = within(result.closest("[role=status]") as HTMLElement);
    expect(row.getByText("185.65.134.99")).toBeInTheDocument();
    expect(row.getByText("44 ms")).toBeInTheDocument();
  });

  it("shows a failed test calmly with the reason", async () => {
    const down = tunnel("t-down", "AirVPN");
    installFetchRoutes({
      "GET /api/v1/tunnels": () => [down],
      "GET /api/v1/tunnels/status": () => statusList([down]),
      "GET /api/v1/tunnels/presets": () => presets,
      "POST /api/v1/tunnels/t-down/test": () => ({ success: false, handshakeOk: false, state: "down", error: "helper not started yet" }),
    });
    const user = userEvent.setup();
    renderWithProviders(<VpnPage />);
    await user.click(await screen.findByRole("button", { name: "Test AirVPN" }));
    expect(await screen.findByText(/Test failed, no handshake: helper not started yet/)).toBeInTheDocument();
  });

  it("disables a tunnel without sending its secrets", async () => {
    const { requests } = installFetchRoutes({
      "GET /api/v1/tunnels": () => [connectedTunnel],
      "GET /api/v1/tunnels/status": () => statusList([connectedTunnel]),
      "GET /api/v1/tunnels/presets": () => presets,
      "PUT /api/v1/tunnels/t-conn": ({ body }) => ({ ...connectedTunnel, ...(body as object) }),
    });
    const user = userEvent.setup();
    renderWithProviders(<VpnPage />);
    await user.click(await screen.findByRole("switch", { name: "Disable Mullvad Stockholm" }));

    await waitFor(() => expect(requests.some((r) => r.method === "PUT")).toBe(true));
    const body = requests.find((r) => r.method === "PUT")!.body as Record<string, unknown>;
    expect(body.enabled).toBe(false);
    expect(body).not.toHaveProperty("privateKey");
    expect(body).not.toHaveProperty("presharedKey");
    expect(body.endpoint).toBe(connectedTunnel.endpoint);
  });

  it("offers to set dependents to direct when the tunnel is still in use", async () => {
    const { requests } = installFetchRoutes({
      "GET /api/v1/tunnels": () => [connectedTunnel],
      "GET /api/v1/tunnels/status": () => statusList([connectedTunnel]),
      "GET /api/v1/tunnels/presets": () => presets,
      "DELETE /api/v1/tunnels/t-conn": ({ search }) =>
        search.includes("force=true")
          ? { status: 204 }
          : {
              status: 409,
              body: {
                error: {
                  code: "tunnel_in_use",
                  message: "The tunnel is still used by providers 'Eweka' and indexers 'NZBGeek', 'DrunkenSlug'.",
                  params: { providers: "Eweka", indexers: "NZBGeek, DrunkenSlug" },
                },
              },
            },
    });
    const user = userEvent.setup();
    renderWithProviders(<VpnPage />);
    await user.click(await screen.findByRole("button", { name: "Delete Mullvad Stockholm" }));
    await user.click(screen.getByRole("button", { name: "Remove" }));

    const dialog = await screen.findByRole("dialog", { name: "This tunnel is still in use" });
    const list = within(within(dialog).getByRole("list", { name: "Routed through this tunnel" }));
    expect(list.getByText("Eweka")).toBeInTheDocument();
    expect(list.getByText("NZBGeek")).toBeInTheDocument();
    expect(list.getByText("DrunkenSlug")).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Set them to direct and delete" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const deletes = requests.filter((r) => r.method === "DELETE");
    expect(deletes.map((r) => r.search)).toEqual(["", "?force=true"]);
  });
});
