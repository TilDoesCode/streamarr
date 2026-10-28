/**
 * Streaming path verdict: Usenet → Server (server-side Usenet speed test) and Server → This browser
 * (browser speed test). The slower measured leg limits what plays smoothly.
 */

/** Same bitrate-peak headroom the server applies for `bandwidthFit`. */
export const STREAMING_PATH_HEADROOM = 1.3;

/** Typical bitrates, highest first; a tier plays smoothly at bitrate × headroom. */
export const STREAMING_PATH_TIERS = [
  { id: "4k-remux", label: "4K remux", mbps: 80 },
  { id: "4k-web", label: "4K WEB", mbps: 25 },
  { id: "1080p", label: "1080p", mbps: 10 },
  { id: "720p", label: "720p", mbps: 5 },
] as const;

export function tierThreshold(mbps: number): number {
  return mbps * STREAMING_PATH_HEADROOM;
}

export const BROWSER_RESULT_KEY = "streamarr.speedtest.browser.v1";

export interface StoredBrowserResult {
  downloadMbps: number;
  uploadMbps?: number;
  pingMs?: number;
  measuredAt: string;
}

export type Leg = "usenet" | "browser";

export interface StreamingPathVerdict {
  /** The slower measured leg in Mbit/s; null when nothing is measured. */
  limitMbps: number | null;
  /** The leg that limits playback; null unless both legs are measured. */
  bottleneck: Leg | null;
  /** Legs without a measurement. */
  missing: Leg[];
  /** What plays at `limitMbps`; null when nothing is measured. */
  capability: string | null;
  /** One plain sentence for the card. */
  text: string;
}

/** What plays smoothly at `mbps` (thresholds 104 / 32.5 / 13 / 6.5 Mbit/s). */
export function playbackCapability(mbps: number): string {
  const [remux, web, hd, sd] = STREAMING_PATH_TIERS.map((tier) => tierThreshold(tier.mbps));
  if (mbps >= remux) return "everything plays, including 4K remuxes";
  if (mbps >= web) return "4K WEB and 1080p play smoothly; 4K remuxes (~80 Mbit/s) will buffer";
  if (mbps >= hd) return "1080p plays; 4K will buffer";
  if (mbps >= sd) return "only 720p plays smoothly; 1080p and 4K will buffer";
  return "too slow even for 720p";
}

export function formatMbit(mbps: number): string {
  return mbps < 10 ? `${mbps.toFixed(1)} Mbit/s` : `${Math.round(mbps)} Mbit/s`;
}

function measured(value?: number | null): value is number {
  return value != null && Number.isFinite(value) && value >= 0;
}

export function streamingPathVerdict(usenetMbps?: number | null, browserMbps?: number | null): StreamingPathVerdict {
  const hasUsenet = measured(usenetMbps);
  const hasBrowser = measured(browserMbps);
  const missing: Leg[] = [];
  if (!hasUsenet) missing.push("usenet");
  if (!hasBrowser) missing.push("browser");

  if (hasUsenet && hasBrowser) {
    const bottleneck: Leg = browserMbps <= usenetMbps ? "browser" : "usenet";
    const limitMbps = Math.min(usenetMbps, browserMbps);
    const capability = playbackCapability(limitMbps);
    const who = bottleneck === "browser" ? "This browser is the bottleneck" : "Usenet is the bottleneck";
    return { limitMbps, bottleneck, missing, capability, text: `${who}: ~${formatMbit(limitMbps)} → ${capability}.` };
  }
  if (hasUsenet) {
    const capability = playbackCapability(usenetMbps);
    return {
      limitMbps: usenetMbps,
      bottleneck: null,
      missing,
      capability,
      text: `Usenet delivers ~${formatMbit(usenetMbps)} → ${capability}. Server → This browser is not measured yet, so the browser could still be slower.`,
    };
  }
  if (hasBrowser) {
    const capability = playbackCapability(browserMbps);
    return {
      limitMbps: browserMbps,
      bottleneck: null,
      missing,
      capability,
      text: `This browser gets ~${formatMbit(browserMbps)} from the server → ${capability}. Usenet → Server is not measured yet, so Usenet could still be slower.`,
    };
  }
  return {
    limitMbps: null,
    bottleneck: null,
    missing,
    capability: null,
    text: "Neither leg is measured yet — run “Measure all” to see what plays smoothly.",
  };
}

export function loadBrowserResult(storage: Storage | undefined = globalThis.localStorage): StoredBrowserResult | null {
  try {
    const raw = storage?.getItem(BROWSER_RESULT_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<StoredBrowserResult>;
    if (!measured(value.downloadMbps) || typeof value.measuredAt !== "string") return null;
    return {
      downloadMbps: value.downloadMbps,
      uploadMbps: measured(value.uploadMbps) ? value.uploadMbps : undefined,
      pingMs: measured(value.pingMs) ? value.pingMs : undefined,
      measuredAt: value.measuredAt,
    };
  } catch {
    return null;
  }
}

export function saveBrowserResult(result: StoredBrowserResult, storage: Storage | undefined = globalThis.localStorage): void {
  try {
    storage?.setItem(BROWSER_RESULT_KEY, JSON.stringify(result));
  } catch {
    // storage full or disabled: the result just won't survive a reload
  }
}

const USENET_CODE_LABELS: Record<string, string> = {
  connect_failed: "Could not connect",
  auth_failed: "Login rejected",
  no_article: "No test article found",
  timeout: "Timed out",
  no_data: "No data received",
  no_free_connections: "No free connections",
  error: "Unexpected error",
  no_providers: "No Usenet providers configured",
};

export function usenetCodeLabel(code?: string | null): string {
  if (!code) return "Failed";
  return USENET_CODE_LABELS[code] ?? code;
}

export interface UsenetProviderLike {
  index: number;
  role: string | null;
  name?: string | null;
}

/** "Primary · Newshosting", "Backup #2 · Eweka", or without the name for viewers. */
export function usenetProviderLabel(provider: UsenetProviderLike): string {
  const role = provider.role === "primary" ? "Primary" : `Backup #${provider.index}`;
  return provider.name ? `${role} · ${provider.name}` : role;
}
