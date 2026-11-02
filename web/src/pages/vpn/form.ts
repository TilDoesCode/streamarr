import { z } from "zod";
import type { TunnelResponse, TunnelWrite } from "@/api/types";

export const DEFAULT_ALLOWED_IPS = "0.0.0.0/0, ::/0";

const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i;
const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

export function splitList(value?: string | null): string[] {
  return (value ?? "")
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function isIpv4(value: string): boolean {
  return IPV4_RE.test(value);
}

export function isIpv6(value: string): boolean {
  if (!value.includes(":") || !/^[0-9a-f:.]+$/i.test(value)) return false;
  try {
    new URL(`http://[${value}]/`);
    return true;
  } catch {
    return false;
  }
}

export function isIp(value: string): boolean {
  return isIpv4(value) || isIpv6(value);
}

/** `ip` or `ip/prefix`, the way the server's TryNormalizeCidr accepts it. */
export function isCidr(value: string): boolean {
  const [ip, prefix, extra] = value.split("/");
  if (extra !== undefined || !isIp(ip)) return false;
  if (prefix === undefined) return true;
  if (!/^\d{1,3}$/.test(prefix)) return false;
  return Number(prefix) <= (isIpv4(ip) ? 32 : 128);
}

/** A base64-encoded 32-byte WireGuard key. */
export function isWireGuardKey(value: string): boolean {
  const key = value.trim();
  if (!/^[A-Za-z0-9+/]{43}=$/.test(key)) return false;
  try {
    return atob(key).length === 32;
  } catch {
    return false;
  }
}

/** `host:port`, `[v6]:port` or a bare host (the preset's default port applies). */
export function endpointProblem(value: string): string | null {
  const text = value.trim();
  if (!text || /\s/.test(text) || text.length > 300) return "Use host:port, e.g. vpn.example.com:51820";
  let host = text;
  let port: string | undefined;
  if (text.startsWith("[")) {
    const match = /^\[([^\]]+)\](?::(.*))?$/.exec(text);
    if (!match) return "Write IPv6 endpoints as [address]:port";
    host = match[1];
    port = match[2];
    if (!isIpv6(host)) return "The endpoint host must be a hostname or IP address";
  } else {
    const parts = text.split(":");
    if (parts.length > 2) return "Write IPv6 endpoints as [address]:port";
    [host, port] = parts;
    if (!host || host.length > 253 || !(isIpv4(host) || HOST_RE.test(host)))
      return "The endpoint host must be a hostname or IP address";
  }
  if (port !== undefined && (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535))
    return "The endpoint port must be between 1 and 65535";
  return null;
}

const optionalInt = (min: number, max: number, message: string) =>
  z
    .string()
    .trim()
    .refine((value) => value === "" || (/^\d+$/.test(value) && Number(value) >= min && Number(value) <= max), message);

const keyField = (label: string) =>
  z
    .string()
    .trim()
    .refine((value) => value === "" || isWireGuardKey(value), `${label} must be a base64-encoded 32-byte key`);

function listField(max: number, check: (value: string) => boolean, problem: (value: string) => string) {
  return z.string().superRefine((value, ctx) => {
    const items = splitList(value);
    if (items.length > max) ctx.addIssue({ code: "custom", message: `At most ${max} entries` });
    const bad = items.find((item) => !check(item));
    if (bad) ctx.addIssue({ code: "custom", message: problem(bad) });
  });
}

export function tunnelSchema({ requirePrivateKey }: { requirePrivateKey: boolean }) {
  return z
    .object({
      name: z.string().trim().min(1, "A name is required").max(128, "Maximum 128 characters"),
      preset: z.string(),
      enabled: z.boolean(),
      endpoint: z.string().superRefine((value, ctx) => {
        const problem = endpointProblem(value);
        if (problem) ctx.addIssue({ code: "custom", message: problem });
      }),
      addresses: listField(8, isCidr, (bad) => `“${bad}” is not an IP address or CIDR`).refine(
        (value) => splitList(value).length > 0,
        "At least one interface address is required",
      ),
      dns: listField(8, isIp, (bad) => `“${bad}” is not an IP address`),
      mtu: optionalInt(1280, 1500, "MTU must be between 1280 and 1500"),
      keepalive: optionalInt(0, 600, "Keepalive must be between 0 and 600 seconds"),
      peerPublicKey: keyField("The peer public key").refine((value) => value !== "", "The peer public key is required"),
      privateKey: keyField("The private key").refine(
        (value) => !requirePrivateKey || value !== "",
        "A private key is required",
      ),
      presharedKey: keyField("The preshared key"),
      removePresharedKey: z.boolean(),
      allowedIps: listField(32, isCidr, (bad) => `“${bad}” is not a CIDR network`),
    })
    .superRefine((values, ctx) => {
      if (values.preset === "custom" && splitList(values.dns).length === 0)
        ctx.addIssue({
          code: "custom",
          path: ["dns"],
          message: "Custom tunnels need at least one DNS server so hostnames resolve inside the tunnel",
        });
    });
}

export type TunnelFormValues = z.input<ReturnType<typeof tunnelSchema>>;

export const TUNNEL_FIELDS = [
  "name",
  "preset",
  "endpoint",
  "addresses",
  "dns",
  "mtu",
  "keepalive",
  "peerPublicKey",
  "privateKey",
  "presharedKey",
  "allowedIps",
] as const satisfies readonly (keyof TunnelFormValues)[];

export type TunnelField = (typeof TUNNEL_FIELDS)[number];

export function isTunnelField(field?: string | null): field is TunnelField {
  return TUNNEL_FIELDS.includes(field as TunnelField);
}

export function emptyValues(preset = "custom"): TunnelFormValues {
  return {
    name: "",
    preset,
    enabled: true,
    endpoint: "",
    addresses: "",
    dns: "",
    mtu: "",
    keepalive: "25",
    peerPublicKey: "",
    privateKey: "",
    presharedKey: "",
    removePresharedKey: false,
    allowedIps: DEFAULT_ALLOWED_IPS,
  };
}

export function valuesFromTunnel(tunnel: TunnelResponse): TunnelFormValues {
  return {
    name: tunnel.name ?? "",
    preset: tunnel.preset ?? "custom",
    enabled: tunnel.enabled,
    endpoint: tunnel.endpoint ?? "",
    addresses: (tunnel.addresses ?? []).join(", "),
    dns: (tunnel.dns ?? []).join(", "),
    mtu: tunnel.mtu != null ? String(tunnel.mtu) : "",
    keepalive: tunnel.keepalive != null ? String(tunnel.keepalive) : "",
    peerPublicKey: tunnel.peerPublicKey ?? "",
    privateKey: "",
    presharedKey: "",
    removePresharedKey: false,
    allowedIps: (tunnel.allowedIps ?? []).join(", ") || DEFAULT_ALLOWED_IPS,
  };
}

/** Prefill the details step from an import; secrets the .conf carried are kept so they can be saved. */
export function valuesFromImport(write: TunnelWrite, preset: string, name: string): TunnelFormValues {
  return {
    ...emptyValues(preset),
    name: write.name?.trim() || name,
    endpoint: write.endpoint ?? "",
    addresses: (write.addresses ?? []).join(", "),
    dns: (write.dns ?? []).join(", "),
    mtu: write.mtu != null ? String(write.mtu) : "",
    keepalive: write.keepalive != null ? String(write.keepalive) : "",
    peerPublicKey: write.peerPublicKey ?? "",
    privateKey: write.privateKey ?? "",
    presharedKey: write.presharedKey ?? "",
    allowedIps: (write.allowedIps ?? []).join(", ") || DEFAULT_ALLOWED_IPS,
  };
}

/** Build the API write model: blank secrets are omitted (server keeps them), `presharedKey: ""` removes. */
export function toTunnelWrite(values: TunnelFormValues): TunnelWrite {
  const body: TunnelWrite = {
    name: values.name.trim(),
    preset: values.preset,
    enabled: values.enabled,
    endpoint: values.endpoint.trim(),
    addresses: splitList(values.addresses),
    dns: splitList(values.dns),
    mtu: values.mtu.trim() ? Number(values.mtu) : null,
    keepalive: values.keepalive.trim() ? Number(values.keepalive) : null,
    peerPublicKey: values.peerPublicKey.trim(),
    allowedIps: splitList(values.allowedIps),
  };
  if (values.privateKey.trim()) body.privateKey = values.privateKey.trim();
  if (values.removePresharedKey) body.presharedKey = "";
  else if (values.presharedKey.trim()) body.presharedKey = values.presharedKey.trim();
  return body;
}

/** Rebuild a write model from a response, e.g. for the enable switch; secrets stay as stored. */
export function writeFromTunnel(tunnel: TunnelResponse): TunnelWrite {
  return {
    name: tunnel.name,
    preset: tunnel.preset,
    enabled: tunnel.enabled,
    endpoint: tunnel.endpoint,
    addresses: tunnel.addresses,
    dns: tunnel.dns,
    mtu: tunnel.mtu ?? null,
    keepalive: tunnel.keepalive ?? null,
    peerPublicKey: tunnel.peerPublicKey,
    allowedIps: tunnel.allowedIps,
  };
}
