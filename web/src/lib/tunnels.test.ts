import { describe, expect, it } from "vitest";
import { connectedTunnel, status, tunnel } from "@/test/tunnel-fixtures";
import { errorCodeLabel, hintText, KIND_LABELS } from "@/pages/diagnostics/text";
import { endpointProblem, isCidr, isWireGuardKey, toTunnelWrite, valuesFromTunnel } from "@/pages/vpn/form";
import { mergeTunnelStatus, resolveRoute, tunnelState } from "./tunnels";

describe("tunnel helpers", () => {
  it("treats unknown states as down", () => {
    expect(tunnelState("connected")).toBe("connected");
    expect(tunnelState("weird")).toBe("down");
    expect(tunnelState(null)).toBe("down");
  });

  it("overlays polled status entries by id", () => {
    const list = [tunnel("a", "A"), tunnel("b", "B")];
    const merged = mergeTunnelStatus(list, [{ id: "b", name: "B", enabled: false, status: status("disabled") }]);
    expect(merged[0]).toBe(list[0]);
    expect(merged[1].status.state).toBe("disabled");
    expect(merged[1].enabled).toBe(false);
  });

  it("resolves routes with the live tunnel state", () => {
    expect(resolveRoute(null).kind).toBe("direct");
    expect(resolveRoute({ kind: "externalProxy", usable: true }).kind).toBe("externalProxy");
    const stale = { kind: "tunnel", tunnelId: "t-conn", tunnelName: "old", state: "down", usable: false };
    expect(resolveRoute(stale)).toMatchObject({ usable: false, tunnelName: "old" });
    expect(resolveRoute(stale, [connectedTunnel])).toMatchObject({ usable: true, state: "connected", tunnelName: "Mullvad Stockholm" });
  });
});

describe("tunnel form rules", () => {
  it("mirrors the server's key, endpoint and CIDR rules", () => {
    expect(isWireGuardKey("4lWFoXFaZOG/ss35101ZbHXPbLR9DgVeNekWLSXLvik=")).toBe(true);
    expect(isWireGuardKey("AAAA")).toBe(false);
    expect(endpointProblem("vpn.example.com:51820")).toBeNull();
    expect(endpointProblem("vpn.example.com")).toBeNull();
    expect(endpointProblem("[2001:db8::1]:51820")).toBeNull();
    expect(endpointProblem("2001:db8::1:51820")).toMatch(/IPv6/);
    expect(endpointProblem("vpn.example.com:0")).toMatch(/port/);
    expect(isCidr("10.64.12.3")).toBe(true);
    expect(isCidr("::/0")).toBe(true);
    expect(isCidr("10.0.0.0/33")).toBe(false);
    expect(isCidr("fc00:bbbb::1/129")).toBe(false);
  });

  it("round-trips a response into a write model without secrets", () => {
    const write = toTunnelWrite(valuesFromTunnel(connectedTunnel));
    expect(write).not.toHaveProperty("privateKey");
    expect(write).not.toHaveProperty("presharedKey");
    expect(write.allowedIps).toEqual(["0.0.0.0/0", "::/0"]);
    expect(write.keepalive).toBe(25);
  });
});

describe("diagnostics text for tunnels", () => {
  it("explains the tunnel hints, kind and error codes", () => {
    expect(hintText("tunnel_down").title).toMatch(/No VPN tunnel is connected/);
    expect(hintText("some_tunnels_down").action).toMatch(/Open VPN/);
    expect(KIND_LABELS.tunnel).toBe("VPN tunnel");
    expect(errorCodeLabel("vpn_down")).toBe("VPN down (nothing sent)");
  });
});
