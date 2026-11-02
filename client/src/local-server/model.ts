import type {
  EmbeddedServerAddress,
  EmbeddedServerState,
  EmbeddedServerStatus,
} from '@modules/embedded-server';

import { AppError, isAppError } from '@/api/errors';

export const PORT_MIN = 1024;
export const PORT_MAX = 65535;

/** The app reaches its own server over loopback, like any other server. */
export function loopbackUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

/** Loopback base URL of the running process (its address list), else the configured port's. */
export function localBaseUrl(status: Pick<EmbeddedServerStatus, 'port' | 'addresses'>): string {
  return status.addresses.find((a) => a.kind === 'loopback')?.url ?? loopbackUrl(status.port);
}

/** Port the running process listens on; differs from `status.port` after a change until the next start. */
export function runningPort(status: Pick<EmbeddedServerStatus, 'port' | 'addresses'>) {
  const match = /:(\d+)(?:\/|$)/.exec(status.addresses[0]?.url ?? '');
  return match ? Number(match[1]) : status.port;
}

const QR_ORDER: readonly EmbeddedServerAddress['kind'][] = ['lan', 'tailscale', 'other'];

/** Address the phone scans: LAN first, then Tailscale, never loopback (the phone is another device). */
export function qrAddress(addresses: readonly EmbeddedServerAddress[]) {
  for (const kind of QR_ORDER) {
    const match = addresses.find((address) => address.kind === kind);
    if (match) return match;
  }
  return undefined;
}

/** Addresses in display order (the QR's first, loopback last). */
export function sortedAddresses(addresses: readonly EmbeddedServerAddress[]) {
  const rank = (kind: EmbeddedServerAddress['kind']) =>
    kind === 'loopback' ? QR_ORDER.length : QR_ORDER.indexOf(kind);
  return [...addresses].sort((a, b) => rank(a.kind) - rank(b.kind));
}

export type PortProblem = 'empty' | 'notNumber' | 'range';

export function parsePort(text: string): { port: number } | { problem: PortProblem } {
  const trimmed = text.trim();
  if (!trimmed) return { problem: 'empty' };
  if (!/^\d+$/.test(trimmed)) return { problem: 'notNumber' };
  const port = Number(trimmed);
  return port < PORT_MIN || port > PORT_MAX ? { problem: 'range' } : { port };
}

export type StateTone = 'success' | 'warning' | 'danger' | 'neutral';

export const STATE_TONE: Record<EmbeddedServerState, StateTone> = {
  running: 'success',
  starting: 'warning',
  stopping: 'warning',
  stopped: 'neutral',
  failed: 'danger',
};

export const isTransitioning = (state: EmbeddedServerState) =>
  state === 'starting' || state === 'stopping';

/** Native rejections (plain Errors) become AppErrors; the message stays a detail, never the UI text. */
export function toLocalServerError(error: unknown): AppError {
  if (isAppError(error)) return error;
  const detail = error instanceof Error ? error.message : String(error);
  return new AppError(
    /not available/i.test(detail) ? 'local_server_unavailable' : 'local_server_failed',
    {
      detail,
      cause: error,
    }
  );
}

export type CheckId = 'running' | 'api' | 'viewer' | 'ready';
export type CheckState = 'done' | 'checking' | 'failed' | 'todo';
export type CheckProblem = 'stopped' | 'failed' | 'unreachable' | 'module_disabled' | 'other';
export type Check = { id: CheckId; state: CheckState; problem?: CheckProblem };

type Probe = { status: 'pending' | 'success' | 'error'; error?: unknown };

export type ReadinessInput = {
  status: Pick<EmbeddedServerStatus, 'state' | 'startedAt'> | null;
  health: Probe;
  viewer: Probe;
  now: number;
};

/** Right after a start the API needs a moment: failures in this window still read as "checking". */
export const STARTUP_GRACE_MS = 30_000;

/** Server running → API reachable → viewer accounts on → ready; each line waits for the one before. */
export function readiness({ status, health, viewer, now }: ReadinessInput): {
  checks: Check[];
  ready: boolean;
} {
  const state = status?.state;
  const fresh = !!status?.startedAt && now - status.startedAt < STARTUP_GRACE_MS;
  const running: Check =
    state === 'running'
      ? { id: 'running', state: 'done' }
      : state === 'starting'
        ? { id: 'running', state: 'checking' }
        : state === 'failed'
          ? { id: 'running', state: 'failed', problem: 'failed' }
          : { id: 'running', state: 'todo', problem: 'stopped' };
  const probe = (id: CheckId, result: Probe, gate: Check): Check => {
    if (gate.state !== 'done') return { id, state: 'todo' };
    if (result.status === 'success') return { id, state: 'done' };
    if (result.status === 'pending') return { id, state: 'checking' };
    const code = isAppError(result.error) ? result.error.code : 'unknown';
    if (code === 'module_disabled') return { id, state: 'failed', problem: 'module_disabled' };
    if (fresh) return { id, state: 'checking' };
    const unreachable = code === 'network_unreachable' || code === 'timeout';
    return { id, state: 'failed', problem: unreachable ? 'unreachable' : 'other' };
  };
  const api = probe('api', health, running);
  const viewerCheck = probe('viewer', viewer, api);
  const ready = viewerCheck.state === 'done';
  return {
    checks: [running, api, viewerCheck, { id: 'ready', state: ready ? 'done' : 'todo' }],
    ready,
  };
}
