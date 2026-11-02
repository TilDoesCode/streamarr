import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test/render";
import { installFetchRoutes } from "@/test/fetch-routes";
import { setSession } from "@/api/token";
import { connectedTunnel, status, tunnel } from "@/test/tunnel-fixtures";
import { IndexersPage } from "./indexers";
import { ProvidersPage } from "./providers";
import { VpnTile } from "./dashboard";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, className }: { children: ReactNode; to: string; className?: string }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
}));

const downTunnel = tunnel("t-down", "Mullvad Stockholm");
const downRoute = { kind: "tunnel", tunnelId: "t-down", tunnelName: "Mullvad Stockholm", state: "down", usable: false, lastError: "helper not started yet" };
const okRoute = { kind: "tunnel", tunnelId: "t-conn", tunnelName: "Mullvad Stockholm", state: "connected", usable: true };

const indexers = [
  { id: "i1", name: "NZBGeek", baseUrl: "https://api.nzbgeek.example", hasApiKey: true, categories: [2000], enabled: true, priority: 0, tunnelId: "t-down", route: downRoute },
  { id: "i2", name: "DrunkenSlug", baseUrl: "https://drunkenslug.example", hasApiKey: true, categories: [], enabled: true, priority: 1, tunnelId: null, route: { kind: "direct", usable: true } },
  { id: "i3", name: "Legacy", baseUrl: "https://legacy.example", hasApiKey: true, categories: [], enabled: true, priority: 2, tunnelId: null, route: { kind: "externalProxy", usable: true } },
];

const provider = (id: string, name: string, extra: Record<string, unknown>) => ({
  id,
  name,
  host: `news.${id}.example`,
  port: 563,
  useSsl: true,
  username: "u",
  hasPassword: true,
  maxConnections: 10,
  priority: id === "p1" ? 0 : 1,
  enabled: true,
  isBackupOnly: false,
  ...extra,
});

describe("indexer routes", () => {
  beforeEach(() => {
    setSession({ username: "admin", role: "admin", expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
  });
  afterEach(() => vi.restoreAllMocks());

  it("badges each route and explains a vpn_down test", async () => {
    installFetchRoutes({
      "GET /api/v1/config/indexers": () => indexers,
      "GET /api/v1/tunnels": () => [downTunnel],
      "POST /api/v1/config/indexers/i1/test": () => ({ success: false, latencyMs: 0, errorCode: "vpn_down", error: "VPN down", route: downRoute }),
    });
    const user = userEvent.setup();
    renderWithProviders(<IndexersPage />);

    expect(await screen.findByText("via Mullvad Stockholm · VPN down")).toBeInTheDocument();
    expect(screen.getByText("Direct")).toBeInTheDocument();
    expect(screen.getByText("External proxy")).toBeInTheDocument();

    await user.click(screen.getAllByRole("button", { name: "Test" })[0]);
    const row = (await screen.findAllByText("Tunnel “Mullvad Stockholm” is not connected; nothing is sent until it is."))[0];
    expect(within(row.parentElement as HTMLElement).getByRole("link", { name: "Open VPN" })).toHaveAttribute("href", "/vpn");
  });

  it("shows the live tunnel state over the route captured when the list loaded", async () => {
    installFetchRoutes({
      "GET /api/v1/config/indexers": () => [{ ...indexers[0], tunnelId: "t-conn", route: { ...downRoute, tunnelId: "t-conn" } }],
      "GET /api/v1/tunnels": () => [connectedTunnel],
    });
    renderWithProviders(<IndexersPage />);
    expect(await screen.findByText("via Mullvad Stockholm")).toBeInTheDocument();
  });

  it("sets an indexer back to direct from the Connection select", async () => {
    const { requests } = installFetchRoutes({
      "GET /api/v1/config/indexers": () => indexers,
      "GET /api/v1/tunnels": () => [downTunnel, connectedTunnel],
      "PUT /api/v1/config/indexers/i1": ({ body }) => ({ ...indexers[0], ...(body as object) }),
    });
    const user = userEvent.setup();
    renderWithProviders(<IndexersPage />);
    await user.click(await screen.findByRole("button", { name: "Edit NZBGeek" }));

    const select = screen.getByLabelText("Connection");
    expect(select).toHaveValue("t-down");
    expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Direct (default)",
      "via Mullvad Stockholm – down",
      "via Mullvad Stockholm – connected",
    ]);
    await user.selectOptions(select, "");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(requests.some((r) => r.method === "PUT")).toBe(true));
    expect((requests.find((r) => r.method === "PUT")!.body as Record<string, unknown>).tunnelId).toBe("");
  });
});

describe("provider routes", () => {
  beforeEach(() => {
    setSession({ username: "admin", role: "admin", expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
  });
  afterEach(() => vi.restoreAllMocks());

  it("routes a new provider through a tunnel", async () => {
    const { requests } = installFetchRoutes({
      "GET /api/v1/config/providers": () => [provider("p1", "Eweka", { route: { kind: "direct", usable: true } })],
      "GET /api/v1/tunnels": () => [connectedTunnel],
      "POST /api/v1/config/providers": ({ body }) => ({ status: 201, body }),
    });
    const user = userEvent.setup();
    renderWithProviders(<ProvidersPage />);
    expect(await screen.findByText("Direct")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Add provider" }));
    await user.type(screen.getByLabelText("Name"), "Newshosting");
    await user.type(screen.getByLabelText("Host"), "news.newshosting.example");
    await user.selectOptions(screen.getByLabelText("Connection"), "t-conn");
    await user.click(screen.getAllByRole("button", { name: "Add provider" }).at(-1)!);

    await waitFor(() => expect(requests.some((r) => r.method === "POST")).toBe(true));
    expect((requests.find((r) => r.method === "POST")!.body as Record<string, unknown>).tunnelId).toBe("t-conn");
  });

  it("links to the VPN page when there are no tunnels", async () => {
    installFetchRoutes({
      "GET /api/v1/config/providers": () => [provider("p1", "Eweka", { route: { kind: "direct", usable: true } })],
      "GET /api/v1/tunnels": () => [],
    });
    const user = userEvent.setup();
    renderWithProviders(<ProvidersPage />);
    await user.click(await screen.findByRole("button", { name: "Edit Eweka" }));
    expect(screen.getByRole("link", { name: "Add a VPN tunnel first" })).toHaveAttribute("href", "/vpn");
    expect(within(screen.getByLabelText("Connection")).getAllByRole("option")).toHaveLength(1);
  });

  it("explains vpn_down for the connection check and the speed test", async () => {
    installFetchRoutes({
      "GET /api/v1/config/providers": () => [
        provider("p1", "Eweka", { route: okRoute, tunnelId: "t-conn" }),
        provider("p2", "Newshosting", { route: downRoute, tunnelId: "t-down" }),
      ],
      "GET /api/v1/tunnels": () => [connectedTunnel, downTunnel],
      "POST /api/v1/config/providers/p2/test": () => ({
        success: false,
        errorCode: "vpn_down",
        error: "VPN down",
        route: downRoute,
        achievableConnections: 0,
        requestedConnections: 10,
      }),
      "POST /api/v1/config/providers/p2/speedtest": () => ({
        status: 503,
        body: { error: { code: "vpn_down", message: "VPN down: tunnel 'Mullvad Stockholm' is down." } },
      }),
    });
    const user = userEvent.setup();
    renderWithProviders(<ProvidersPage />);

    expect(await screen.findByText("via Mullvad Stockholm")).toBeInTheDocument();
    expect(screen.getByText("via Mullvad Stockholm · VPN down")).toBeInTheDocument();

    await user.click(screen.getAllByRole("button", { name: "Check" })[1]);
    expect(
      (await screen.findAllByText("Tunnel “Mullvad Stockholm” is not connected; nothing is sent until it is.")).length,
    ).toBeGreaterThan(0);

    await user.click(screen.getByRole("button", { name: "Speed test Newshosting" }));
    await user.click(screen.getByRole("button", { name: "Run 8-second test" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Tunnel “Mullvad Stockholm” is not connected; nothing is sent until it is.");
  });
});

describe("dashboard VPN tile", () => {
  beforeEach(() => {
    setSession({ username: "admin", role: "admin", expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
  });
  afterEach(() => vi.restoreAllMocks());

  it("stays hidden while no tunnel exists", async () => {
    const { requests } = installFetchRoutes({
      "GET /api/v1/tunnels/status": () => ({ checkedAt: new Date().toISOString(), tunnels: [] }),
    });
    const { container } = renderWithProviders(<VpnTile />);
    await waitFor(() => expect(requests.length).toBe(1));
    expect(container).toBeEmptyDOMElement();
  });

  it("counts connected, down and disabled tunnels and links to the VPN page", async () => {
    installFetchRoutes({
      "GET /api/v1/tunnels/status": () => ({
        checkedAt: new Date().toISOString(),
        tunnels: [
          { id: "a", name: "Mullvad", enabled: true, status: status("connected") },
          { id: "b", name: "Proton", enabled: true, status: status("down") },
          { id: "c", name: "Spare", enabled: false, status: status("disabled") },
        ],
      }),
    });
    renderWithProviders(<VpnTile />);
    const tile = within(await screen.findByTestId("vpn-tile"));
    expect(tile.getByText(/^1 connected/)).toBeInTheDocument();
    expect(tile.getByText("· 1 down")).toBeInTheDocument();
    expect(tile.getByText("· 1 off")).toBeInTheDocument();
    expect(tile.getByText("Mullvad")).toBeInTheDocument();
    expect(tile.getByRole("link", { name: /Manage VPN/ })).toHaveAttribute("href", "/vpn");
  });
});
