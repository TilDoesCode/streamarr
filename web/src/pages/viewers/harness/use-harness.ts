import { createContext, useCallback, useContext, useEffect, useState, useSyncExternalStore } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/api/queries";
import { ViewerClient, type ViewerLogEntry, type ViewerTokens } from "@/lib/viewer-client";

export interface Harness {
  client: ViewerClient;
  tokens: ViewerTokens | null;
  log: ViewerLogEntry[];
  clearLog: () => void;
}

const LOG_LIMIT = 200;
const HARNESS_CLIENT = "Streamarr test harness";

export const harnessKeys = {
  options: [...queryKeys.viewerHarness, "options"] as const,
  sessions: [...queryKeys.viewerHarness, "session"] as const,
  session: (sid: string) => [...queryKeys.viewerHarness, "session", sid] as const,
  me: (sid: string) => [...harnessKeys.session(sid), "me"] as const,
  devices: (sid: string) => [...harnessKeys.session(sid), "devices"] as const,
  watch: (sid: string) => [...harnessKeys.session(sid), "watch"] as const,
  resume: (sid: string) => [...harnessKeys.watch(sid), "resume"] as const,
  nextUp: (sid: string) => [...harnessKeys.watch(sid), "next-up"] as const,
  history: (sid: string) => [...harnessKeys.watch(sid), "history"] as const,
};

export const harnessClientName = HARNESS_CLIENT;

/** Owns one in-memory viewer client for the lifetime of the page (survives tab switches, not reloads). */
export function useHarnessState(): Harness {
  const qc = useQueryClient();
  const [client] = useState(() => new ViewerClient());
  const subscribe = useCallback((listener: () => void) => client.onTokens(listener), [client]);
  const tokens = useSyncExternalStore(subscribe, () => client.tokens);
  const [log, setLog] = useState<ViewerLogEntry[]>([]);

  useEffect(() => client.onLog((entry) => setLog((previous) => [entry, ...previous].slice(0, LOG_LIMIT))), [client]);

  useEffect(() => {
    let sessionId = client.tokens?.sessionId ?? null;
    return client.onTokens((next) => {
      const nextId = next?.sessionId ?? null;
      if (nextId === sessionId) return;
      sessionId = nextId;
      if (!next) qc.removeQueries({ queryKey: harnessKeys.sessions });
      // Sign-in and sign-out change the device counts shown under Accounts.
      void qc.invalidateQueries({ queryKey: queryKeys.viewers, exact: true });
    });
  }, [client, qc]);

  // Leaving the page drops the tokens; they were never persisted anywhere.
  useEffect(
    () => () => {
      client.forget();
      qc.removeQueries({ queryKey: harnessKeys.sessions });
    },
    [client, qc],
  );

  const clearLog = useCallback(() => setLog([]), []);
  return { client, tokens, log, clearLog };
}

export const HarnessContext = createContext<Harness | null>(null);

export function useHarness(): Harness {
  const harness = useContext(HarnessContext);
  if (!harness) throw new Error("useHarness must be used inside the viewer test harness.");
  return harness;
}

/** The signed-in session id; components below the session gate may assume it exists. */
export function useSessionId(): string {
  return useHarness().tokens?.sessionId ?? "";
}

export function useAuthOptions() {
  const { client } = useHarness();
  return useQuery({
    queryKey: harnessKeys.options,
    queryFn: () => client.authOptions(),
    retry: false,
    staleTime: 0,
  });
}

export function useViewerProfile() {
  const { client, tokens } = useHarness();
  const sid = tokens?.sessionId ?? "";
  return useQuery({
    queryKey: harnessKeys.me(sid),
    queryFn: () => client.me(),
    enabled: !!sid,
    retry: false,
    staleTime: 0,
  });
}

/** Refetch everything that depends on watch state after a report or a played/unplayed mark. */
export function useInvalidateWatch() {
  const qc = useQueryClient();
  const sid = useSessionId();
  return useCallback(() => {
    void qc.invalidateQueries({ queryKey: harnessKeys.watch(sid) });
    void qc.invalidateQueries({ queryKey: queryKeys.viewers, exact: true });
  }, [qc, sid]);
}

/** Current time, re-rendered every `intervalMs` (countdowns). */
export function useNow(intervalMs = 1_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const handle = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(handle);
  }, [intervalMs]);
  return now;
}
