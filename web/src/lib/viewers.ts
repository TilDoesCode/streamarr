import type { ViewerPermissionsDto } from "@/api/types";

/** .NET ticks per second (100 ns units), as used by every watch-state position. */
export const TICKS_PER_SECOND = 10_000_000;

/** Age limits the server accepts; `null` means unrestricted. */
export const AGE_LIMITS = [0, 6, 12, 16, 18] as const;

export function ageLimitLabel(maxAge?: number | null): string {
  if (maxAge == null) return "Unrestricted";
  if (maxAge === 0) return "All ages (0)";
  return `${maxAge}+`;
}

export function permissionsSummary(permissions?: ViewerPermissionsDto | null): string[] {
  const notes: string[] = [];
  if (permissions?.blockUnrated) notes.push("blocks unrated");
  if (permissions?.allowTranscoding === false) notes.push("no transcoding");
  if (permissions?.maxConcurrentStreams != null) {
    notes.push(`max ${permissions.maxConcurrentStreams} stream${permissions.maxConcurrentStreams === 1 ? "" : "s"}`);
  }
  return notes;
}

export type EmailMode = "disabled" | "smtp" | "outbox";

export function emailModeLabel(mode?: string | null): string {
  switch ((mode ?? "").toLowerCase()) {
    case "smtp":
      return "SMTP";
    case "outbox":
      return "Test outbox";
    default:
      return "Off";
  }
}

const ACCESS_REASONS: Record<string, string> = {
  unrestricted: "No age limit on this account",
  within_age_limit: "Rating is within the age limit",
  above_age_limit: "Rating is above the age limit",
  unrated_allowed: "No rating found — unrated content is allowed",
  unrated_blocked: "No rating found — unrated content is blocked",
  rating_unavailable: "TMDB could not be asked for the rating",
};

export function accessReasonLabel(reason?: string | null): string {
  return (reason && ACCESS_REASONS[reason]) || reason || "Unknown";
}

export interface ParsedWorkId {
  kind: "movie" | "episode" | "season" | "series";
  tmdbId: number;
  season?: number;
  episode?: number;
}

/** Mirrors the server's canonical `tmdb-(movie|tv)-{id}[-sNN[eNN]]` work-id grammar. */
export function parseWorkId(value: string): ParsedWorkId | null {
  const match = /^tmdb-(movie|tv)-([1-9]\d{0,9})(?:-s(\d{2,4})(?:e(\d{2,4}))?)?$/.exec(value.trim());
  if (!match) return null;
  const tmdbId = Number(match[2]);
  if (match[1] === "movie") return match[3] ? null : { kind: "movie", tmdbId };
  if (match[4]) return { kind: "episode", tmdbId, season: Number(match[3]), episode: Number(match[4]) };
  if (match[3]) return { kind: "season", tmdbId, season: Number(match[3]) };
  return { kind: "series", tmdbId };
}

export function episodeWorkId(tmdbId: number, season: number, episode: number): string {
  const pad = (value: number) => String(Math.max(0, Math.trunc(value))).padStart(2, "0");
  return `tmdb-tv-${Math.trunc(tmdbId)}-s${pad(season)}e${pad(episode)}`;
}

export function episodeLabel(season?: number | null, episode?: number | null): string {
  if (season == null || episode == null) return "";
  return `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}`;
}

/** Sign-in and reset codes look like "ABCD-EFGH". */
export function extractCodes(text?: string | null): string[] {
  if (!text) return [];
  return [...new Set(text.match(/\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/g) ?? [])];
}

export function ticksToSeconds(ticks?: number | null): number {
  return ticks ? ticks / TICKS_PER_SECOND : 0;
}

export function secondsToTicks(seconds: number): number {
  return Math.max(0, Math.round(seconds * TICKS_PER_SECOND));
}

/** 3725 → "1:02:05", 65 → "1:05". */
export function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

/** Random id that also works outside secure contexts (plain-HTTP LAN), where `crypto.randomUUID` is missing. */
export function randomId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function initials(name?: string | null): string {
  const words = (name ?? "").split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const lettered = words.filter((word) => /^\p{L}/u.test(word));
  const parts = lettered.length > 0 ? lettered : words;
  if (parts.length === 0) return "?";
  return (parts.length === 1 ? parts[0].slice(0, 2) : parts[0][0] + parts[1][0]).toUpperCase();
}

export function formatDateTime(iso?: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}
