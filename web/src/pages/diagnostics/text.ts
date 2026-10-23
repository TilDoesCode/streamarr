/** Human explanations for the stable diagnostics hint codes (docs/api.md, most severe first). */
export const HINT_TEXT: Record<string, { title: string; action: string }> = {
  database_unreachable: {
    title: "The Streamarr database cannot be reached.",
    action: "Check that the data volume is mounted, writable and not full, then restart the server.",
  },
  no_providers: {
    title: "No Usenet provider is configured, so nothing can be streamed.",
    action: "Add at least one provider under Usenet Providers.",
  },
  all_providers_down: {
    title: "Every Usenet provider is unreachable — playback cannot work.",
    action: "Check host, port and SSL under Usenet Providers, and the server's outbound network/DNS.",
  },
  provider_auth_failed: {
    title: "A Usenet provider rejects the login.",
    action: "Check username and password under Usenet Providers, and that the account is still active.",
  },
  some_providers_down: {
    title: "Some Usenet providers are unreachable; the others take over.",
    action: "Check the failing providers' host, port and SSL settings under Usenet Providers.",
  },
  provider_slow: {
    title: "A Usenet provider answers slowly (over 2 s), so playback may start late.",
    action: "Try a closer server address from your provider or lower its priority under Usenet Providers.",
  },
  no_indexers: {
    title: "No indexer is configured, so search finds nothing.",
    action: "Add a Newznab indexer under Indexers.",
  },
  all_indexers_down: {
    title: "Every indexer is unreachable — search cannot work.",
    action: "Check the indexer URLs and API keys under Indexers, and the server's outbound network/DNS.",
  },
  indexer_auth_failed: {
    title: "An indexer rejects its API key (wrong key or suspended account).",
    action: "Check the API key under Indexers and your account on the indexer's website.",
  },
  some_indexers_down: {
    title: "Some indexers are unreachable; search results may be incomplete.",
    action: "Check the failing indexers' URL and API key under Indexers.",
  },
  indexer_slow: {
    title: "An indexer answers slowly (over 3 s), so searches take longer.",
    action: "Check the indexer's status page, or lower its priority under Indexers.",
  },
  tmdb_unreachable: {
    title: "TMDB metadata cannot be reached — posters and titles may be missing.",
    action: "Check the TMDB API key under Settings and the server's outbound network/DNS.",
  },
  tmdb_not_configured: {
    title: "No TMDB API key is set, so search results are not matched to movies and shows.",
    action: "Add a TMDB API key under Settings.",
  },
  tmdb_slow: {
    title: "TMDB answers slowly (over 2 s), so browsing feels sluggish.",
    action: "This is usually temporary; check the server's network if it persists.",
  },
  disk_low: {
    title: "The cache volume is below its free-space floor; pre-downloads are paused.",
    action: "Free up space on the cache volume, e.g. by removing cached files under Files.",
  },
  connections_exhausted: {
    title: "All NNTP connections are in use; new streams have to wait.",
    action: "Close idle streams under Streams, or raise the connection budget under Settings and the provider connection limits.",
  },
};

export function hintText(code: string): { title: string; action: string } {
  return (
    HINT_TEXT[code] ?? {
      title: `Unrecognised hint "${code}".`,
      action: "Update the web UI or check the server logs for details.",
    }
  );
}

export const ERROR_CODE_LABELS: Record<string, string> = {
  timeout: "Timed out",
  auth_failed: "Login rejected",
  unreachable: "Unreachable",
  http_error: "HTTP error",
  invalid_response: "Invalid response",
  not_configured: "Not configured",
  slow: "Slow",
  low_space: "Low disk space",
  exhausted: "Connections exhausted",
  circuit_open: "Circuit open (paused after failures)",
};

export function errorCodeLabel(code?: string | null): string | null {
  if (!code) return null;
  return ERROR_CODE_LABELS[code] ?? code.replace(/_/g, " ");
}

export const KIND_LABELS: Record<string, string> = {
  database: "Database",
  metadata: "Metadata",
  provider: "Usenet provider",
  indexer: "Indexer",
  disk: "Disk",
  streams: "Streams",
};

export const VERDICT_TEXT: Record<string, { title: string; body: string }> = {
  ok: { title: "Everything looks healthy", body: "All checked components respond normally." },
  degraded: {
    title: "Streamarr works, but something needs attention",
    body: "Some components are slow or partly failing. Playback and search may be affected.",
  },
  down: {
    title: "Streamarr cannot work right now",
    body: "A component that playback or search depends on is failing.",
  },
};

/** Seconds → "3d 4h", "2h 05m", "12m 30s", "42s". */
export function formatUptime(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return "—";
  const s = Math.floor(totalSeconds);
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n: number) => n.toString().padStart(2, "0");
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${pad(m)}m`;
  if (m > 0) return `${m}m ${pad(s % 60)}s`;
  return `${s}s`;
}
