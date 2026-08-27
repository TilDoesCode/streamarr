// Small, pure formatting helpers shared across the stream-details sub screens.
import { formatBytes } from "@/lib/utils";

export function percent(value: number, total: number) {
  if (!total || total <= 0) return 0;
  return Math.max(0, Math.min(100, (value / total) * 100));
}

export function formatRate(bytesPerSecond: number) {
  return `${formatBytes(Math.max(0, bytesPerSecond))}/s`;
}

export function formatRateCompact(bytesPerSecond: number) {
  if (bytesPerSecond <= 0) return "0";
  if (bytesPerSecond >= 1024 * 1024) return `${(bytesPerSecond / 1024 / 1024).toFixed(0)}M`;
  return `${(bytesPerSecond / 1024).toFixed(0)}K`;
}

export function formatDuration(seconds?: number | null) {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "calculating";
  if (seconds < 60) return `${Math.max(0, Math.round(seconds))}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${Math.round(seconds % 60)}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export function formatCountdown(iso: string | undefined, now: number) {
  if (!iso) return "—";
  const seconds = (Date.parse(iso) - now) / 1_000;
  return seconds <= 0 ? "due now" : formatDuration(seconds);
}

export function formatTimestamp(iso?: string) {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", month: "short", day: "2-digit" }).format(date);
}

export function formatMs(ms: number) {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)}s`;
}

export function mimeFor(container?: string | null) {
  const value = container?.toLowerCase();
  if (value === "mkv") return "video/x-matroska";
  if (value === "mp4" || value === "m4v") return "video/mp4";
  if (value === "webm") return "video/webm";
  if (value === "ts" || value === "m2ts") return "video/mp2t";
  return value ? `video/${value}` : "application/octet-stream";
}
