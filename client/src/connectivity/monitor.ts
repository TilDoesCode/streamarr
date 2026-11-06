import { AppError, isAppError } from '@/api/errors';
import { createTimeoutFetch, type FetchLike } from '@/api/http';

/** Reachability of the active server: NetInfo plus a health probe (no network vs server unreachable, 5–30 s retries). */
export type ConnectivityState =
  'online' | 'checking' | 'offline_no_network' | 'offline_server_unreachable';

export type ConnectivitySnapshot = {
  state: ConnectivityState;
  /** The active profile's server the probe checks (null without a profile: always online). */
  serverUrl: string | null;
  /** NetInfo: false = no network at all; null = unknown. */
  networkConnected: boolean | null;
  /** Epoch ms of the current state. */
  since: number;
  lastOnlineAt: number | null;
  /** Epoch ms of the next probe while offline. */
  nextProbeAt: number | null;
};

export const isOfflineState = (state: ConnectivityState) =>
  state === 'offline_no_network' || state === 'offline_server_unreachable';

/** Transport failures that mean "the server cannot be reached" (the service-status rule, `statusView`). */
export const UNREACHABLE_CODES: ReadonlySet<string> = new Set([
  'network_unreachable',
  'timeout',
  'tls_error',
]);

/** A gateway or proxy in front of the server answering instead of it (502/503/504). */
const UNAVAILABLE_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);

export const isUnreachableError = (error: unknown) =>
  isAppError(error) &&
  (UNREACHABLE_CODES.has(error.code) || UNAVAILABLE_STATUSES.has(error.status ?? 0));

export const PROBE_TIMEOUT_MS = 4_000;
/** A request that still failed after its own retries is enough: the health probe decides. */
export const FAILURES_BEFORE_PROBE = 1;
export const PROBE_BACKOFF_MS = [5_000, 10_000, 20_000, 30_000] as const;
/** A Wi-Fi ↔ cellular handover reports "no network" for a moment: only a longer loss counts. */
export const NETWORK_GRACE_MS = 3_000;

export type NetworkState = { isConnected: boolean | null; type?: string };
export type NetworkSource = {
  subscribe(listener: (state: NetworkState) => void): () => void;
  fetch(): Promise<NetworkState>;
};

/** Resolves true when the server answers its anonymous health endpoint (any non-5xx answer). */
export type HealthProbe = (serverUrl: string) => Promise<boolean>;

export function createHealthProbe(
  baseFetch: FetchLike = (input, init) => globalThis.fetch(input, init),
  timeoutMs = PROBE_TIMEOUT_MS
): HealthProbe {
  const fetch = createTimeoutFetch(baseFetch, timeoutMs, timeoutMs);
  return async (serverUrl) => {
    try {
      const response = await fetch(new Request(`${serverUrl}/api/v1/health`), {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });
      return response.status < 500;
    } catch {
      return false;
    }
  };
}

export type ConnectivityMonitorOptions = {
  probe: HealthProbe;
  network?: NetworkSource;
  now?: () => number;
};

export class ConnectivityMonitor {
  private snapshot: ConnectivitySnapshot;
  private readonly listeners = new Set<() => void>();
  private readonly probeServer: HealthProbe;
  private readonly network?: NetworkSource;
  private readonly now: () => number;
  private failures = 0;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  private probing: { generation: number; run: Promise<void> } | null = null;
  private unsubscribe: (() => void) | null = null;
  private generation = 0;

  constructor(options: ConnectivityMonitorOptions) {
    this.probeServer = options.probe;
    this.network = options.network;
    this.now = options.now ?? Date.now;
    const now = this.now();
    this.snapshot = {
      state: 'online',
      serverUrl: null,
      networkConnected: null,
      since: now,
      lastOnlineAt: now,
      nextProbeAt: null,
    };
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): ConnectivitySnapshot => this.snapshot;

  get offline(): boolean {
    return isOfflineState(this.snapshot.state);
  }

  private patch(patch: Partial<ConnectivitySnapshot>): void {
    const next = { ...this.snapshot, ...patch };
    if (patch.state && patch.state !== this.snapshot.state) {
      next.since = this.now();
      if (patch.state === 'online') next.lastOnlineAt = next.since;
    }
    if (
      next.state === this.snapshot.state &&
      next.serverUrl === this.snapshot.serverUrl &&
      next.networkConnected === this.snapshot.networkConnected &&
      next.nextProbeAt === this.snapshot.nextProbeAt
    )
      return;
    this.snapshot = next;
    this.listeners.forEach((listener) => listener());
  }

  /** Follows NetInfo; the first probe runs at once (a cold start without the server goes offline within seconds). */
  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe =
      this.network?.subscribe((state) => this.onNetwork(state)) ?? (() => undefined);
    void this.network
      ?.fetch()
      .then((state) => this.onNetwork(state))
      .catch(() => undefined);
    if (this.snapshot.serverUrl) void this.check();
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.clearTimer();
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.graceTimer = null;
  }

  setServer(serverUrl: string | null): void {
    if (serverUrl === this.snapshot.serverUrl) return;
    this.generation += 1;
    this.probing = null;
    this.failures = 0;
    this.attempt = 0;
    this.clearTimer();
    this.patch({ serverUrl, state: 'online', nextProbeAt: null });
    if (serverUrl && this.unsubscribe) void this.check();
  }

  private onNetwork(state: NetworkState): void {
    const before = this.snapshot.networkConnected;
    this.patch({ networkConnected: state.isConnected });
    if (!this.snapshot.serverUrl) return;
    if (state.isConnected === false) {
      this.generation += 1;
      this.probing = null;
      this.clearTimer();
      this.graceTimer ??= setTimeout(() => {
        this.graceTimer = null;
        if (this.snapshot.networkConnected !== false) return;
        this.patch({ state: 'offline_no_network', nextProbeAt: null });
        this.scheduleProbe();
      }, NETWORK_GRACE_MS);
      return;
    }
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.graceTimer = null;
    if (state.isConnected && before === false) {
      this.attempt = 0;
      void this.check();
    }
  }

  /** A transport failure or a 502/503/504 answer triggers the probe. */
  reportFailure(error: unknown): void {
    if (!isUnreachableError(error) || !this.snapshot.serverUrl) return;
    this.failures += 1;
    if (this.snapshot.state === 'online' && this.failures >= FAILURES_BEFORE_PROBE)
      void this.check();
  }

  reportSuccess(): void {
    this.failures = 0;
  }

  /** "Try again": probes now and restarts the backoff. */
  retry(): Promise<void> {
    this.attempt = 0;
    return this.check();
  }

  /** App back in the foreground: re-check right away when offline. */
  resume(): void {
    if (this.offline) void this.check();
  }

  private check(): Promise<void> {
    const generation = this.generation;
    if (this.probing?.generation !== generation) {
      const run = this.runProbe(generation).finally(() => {
        if (this.probing?.run === run) this.probing = null;
      });
      this.probing = { generation, run };
    }
    return this.probing.run;
  }

  private async runProbe(generation: number): Promise<void> {
    const serverUrl = this.snapshot.serverUrl;
    if (!serverUrl) return;
    this.clearTimer();
    if (this.snapshot.state === 'online') this.patch({ state: 'checking' });
    const reachable = await this.probeServer(serverUrl).catch(() => false);
    // A server switch or a network change since the start makes this answer stale.
    if (generation !== this.generation) return;
    if (reachable) {
      this.failures = 0;
      this.attempt = 0;
      this.patch({ state: 'online', nextProbeAt: null });
      return;
    }
    const noNetwork = this.snapshot.networkConnected === false;
    this.patch({ state: noNetwork ? 'offline_no_network' : 'offline_server_unreachable' });
    this.scheduleProbe();
  }

  private scheduleProbe(): void {
    this.clearTimer();
    const delay = PROBE_BACKOFF_MS[Math.min(this.attempt, PROBE_BACKOFF_MS.length - 1)] ?? 30_000;
    this.attempt += 1;
    this.patch({ nextProbeAt: this.now() + delay });
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.check();
    }, delay);
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

/** For tests: an AppError the monitor counts as a transport failure. */
export const unreachableError = () => new AppError('network_unreachable');
