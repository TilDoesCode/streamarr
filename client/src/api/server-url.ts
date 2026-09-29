import { AppError } from './errors';

export type ServerAddress = {
  /** Candidate base URLs in the order to probe them (scheme given → exactly one). */
  candidates: string[];
  host: string;
  /** Host is on a private/local network (LAN, loopback, link-local, CGNAT/Tailscale, mDNS, single label). */
  isPrivate: boolean;
};

type ParsedUrl = { scheme?: string; host: string; port?: string; path: string };

// Own parser: React Native's URL polyfill neither validates nor understands IPv6 literals.
const URL_PATTERN =
  /^(?:([a-z][a-z0-9+.-]*):\/\/)?(?:([^@/?#]*)@)?(\[[0-9a-f:.]+\]|[^:/?#[\]]+)(?::(\d{1,5}))?(\/[^?#]*)?(?:\?[^#]*)?(?:#.*)?$/i;
const HOST_LABELS = /^[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?(\.[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?)*\.?$/i;
const API_SUFFIX = /\/api(\/.*)?$/i;

function parseUrl(input: string): ParsedUrl | undefined {
  const match = URL_PATTERN.exec(input);
  if (!match) return undefined;
  const [, scheme, userinfo, rawHost = '', port, path = ''] = match;
  if (userinfo !== undefined) return undefined;
  const host = rawHost.toLowerCase();
  const bracketed = host.startsWith('[');
  if (!bracketed && !HOST_LABELS.test(host)) return undefined;
  if (port !== undefined && (Number(port) < 1 || Number(port) > 65535)) return undefined;
  return { scheme: scheme?.toLowerCase(), host: host.replace(/\.$/, ''), port, path };
}

function ipv4(host: string): number[] | undefined {
  const parts = host.split('.');
  if (parts.length !== 4) return undefined;
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : NaN));
  return octets.every((octet) => octet >= 0 && octet <= 255) ? octets : undefined;
}

/** True for hosts that are only reachable on a local network, where plain http is common and acceptable. */
export function isPrivateHost(rawHost: string): boolean {
  const host = rawHost.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (/\.(local|lan|home|internal|intranet|home\.arpa)$/.test(host)) return true;
  const v4 = ipv4(host);
  if (v4) {
    const [a = 0, b = 0] = v4;
    return (
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (host.includes(':')) {
    return host === '::1' || /^f[cd][0-9a-f]{0,2}:/.test(host) || /^fe[89ab][0-9a-f]?:/.test(host);
  }
  return !host.includes('.');
}

/** Parses what the user typed into probe candidates; throws AppError('invalid_url'). */
export function parseServerInput(input: string): ServerAddress {
  const trimmed = input.trim();
  const parsed = trimmed && !/\s/.test(trimmed) ? parseUrl(trimmed) : undefined;
  if (!parsed || (parsed.scheme && parsed.scheme !== 'http' && parsed.scheme !== 'https'))
    throw new AppError('invalid_url');

  // Keep a reverse-proxy base path, drop a pasted API path, query and fragment.
  const path = parsed.path.replace(API_SUFFIX, '').replace(/\/+$/, '');
  const hostPort = parsed.port ? `${parsed.host}:${parsed.port}` : parsed.host;
  const isPrivate = isPrivateHost(parsed.host);
  const build = (scheme: string) => `${scheme}://${hostPort}${path}`;
  const candidates = parsed.scheme
    ? [build(parsed.scheme)]
    : isPrivate
      ? [build('http'), build('https')]
      : [build('https'), build('http')];
  return { candidates, host: parsed.host, isPrivate };
}

/** Plain http to a host outside private networks: credentials and tokens travel unencrypted. */
export function isInsecureRemote(baseUrl: string): boolean {
  const parsed = parseUrl(baseUrl);
  return parsed?.scheme === 'http' && !isPrivateHost(parsed.host);
}

/** Human-friendly form of a base URL (no scheme for https, no trailing slash). */
export function displayServerUrl(baseUrl: string): string {
  return baseUrl.replace(/^https:\/\//, '').replace(/\/+$/, '');
}
