import {
  decideRetry,
  disallowedHeaders,
  httpStatusAction,
  MAX_RETRY_AFTER_MS,
  MIN_RETRY_MS,
  parseRetryAfter,
  RESERVE_BYTES,
} from './http-policy';
import type {
  DownloadEngine,
  DownloadEngineError,
  DownloadEngineErrorCode,
  DownloadError,
  DownloadErrorKind,
  DownloadProgressEvent,
  DownloadSettings,
  DownloadSpec,
  DownloadState,
  DownloadStateEvent,
  DownloadTask,
  NotificationPermission,
  StorageInfo,
  StorageVolume,
} from './types';

export type FakeNetwork = 'wifi' | 'metered' | 'none';

export type FakeDownloadEngineOptions = {
  rootUri?: string;
  settings?: Partial<DownloadSettings>;
  /** Internal volume. */
  storage?: Partial<StorageInfo>;
  /** Extra (SD/USB) volumes besides `internal`. */
  volumes?: StorageVolume[];
  network?: FakeNetwork;
  notificationPermission?: NotificationPermission;
  /** Answer of `contentUriFor` (iOS returns null). */
  contentUris?: boolean;
  /** Injected monotonic clock: retry deadlines are then processed by `controls.tick()` (no timers). */
  now?: () => number;
  /** Wall clock for the displayed `retryAt` (default: `now`, else `Date.now`); moving it never moves a deadline (N2-04). */
  wallNow?: () => number;
  /**
   * Start of `clock()` (default 0 ms, boot id `fake-boot-1`). It moves only by `controls.advanceElapsed` when `now` is
   * injected, else with `performance.now()`; never with `wallNow` or `now`.
   */
  elapsedMs?: number;
  bootId?: string;
};

/** Test controls: drive the fake like the native engine would (events fire synchronously). */
export type FakeDownloadControls = {
  tasks(): DownloadTask[];
  /** Moves a task to `running` with these bytes and emits a progress event. */
  progress(
    id: string,
    bytesWritten: number,
    options?: { totalBytes?: number; bytesPerSecond?: number }
  ): void;
  /** Manual override: writes the file (size = total, expected or written bytes), emits `completed`, then one final progress. */
  complete(id: string): void;
  /** Manual override: `failed` with this error, no retry. */
  fail(id: string, error: DownloadErrorKind | DownloadError): void;
  /** A response status with the native retry rules (backoff, 8 attempts, Retry-After ≥ 2 s, 12 h server wait). */
  httpStatus(
    id: string,
    status: number,
    options?: { retryAfterMs?: number; retryAfter?: string; progressBytes?: number }
  ): void;
  /** A connection error (reset, timeout, invalid 206) with the native retry rules. */
  networkError(id: string, options?: { message?: string; progressBytes?: number }): void;
  /** Manual override: any state with an optional patch; emits a state event. */
  setState(id: string, state: DownloadState, patch?: Partial<DownloadTask>): void;
  /**
   * The viewer cancelled outside the app (Android notification Cancel): the partial is deleted, the path is free and
   * the task stays in `list()` as a `cancelled` tombstone (bytes 0, no error) until `remove`. Finished tasks reject.
   */
  userCancel(id: string): void;
  /**
   * The task's transfer will not end on its own (a read the OS cannot interrupt): `cancel` / `remove` reject with `io`
   * `cancel_pending` / `remove_pending` and the path stays claimed until `releaseDrain(id)` (N2-06).
   */
  stallDrain(id: string): void;
  /** The stalled transfer ended: its partial is deleted and its path freed; a retried `cancel` / `remove` resolves. */
  releaseDrain(id: string): void;
  setNetwork(network: FakeNetwork): void;
  setStorage(storage: Partial<StorageInfo>): void;
  setNotificationPermission(permission: NotificationPermission): void;
  /** SD card / USB stick appears (tasks failed with `volume_unavailable` continue). */
  mountVolume(volume: StorageVolume): void;
  /** Its unfinished tasks fail with `file_system` / `volume_unavailable`. */
  unmountVolume(id: string): void;
  /** Starts tasks whose retry deadline passed (with an injected clock). */
  tick(): void;
  /** `clock().elapsedMs` moves forward by `ms` (a device sleeping or time passing offline). */
  advanceElapsed(ms: number): void;
  /** A reboot as `clock()` sees it: a new boot id and elapsed back to 0 (tasks are untouched). */
  reboot(): void;
  /** Seeds a file, e.g. a download that finished in an earlier session. */
  writeFile(relativePath: string, size: number, volumeId?: string): void;
  /** Sizes by `<volumeId>:<relativePath>`, partial files end in `.part`. */
  files(): Record<string, number>;
  /** Moves every running task forward on a timer (dev mock); returns a stop function. */
  autoRun(options?: { bytesPerTick?: number; tickMs?: number }): () => void;
  calls: string[];
};

export type FakeDownloadEngine = DownloadEngine & { controls: FakeDownloadControls };

const DEFAULT_ROOT = 'file:///data/user/0/dev.streamarr.app/files/downloads/';
/** Suffix of the file a download writes before it completes; a task path may not end in it (N2-01). */
const STAGING = '.part';
const GB = 1024 ** 3;
const INTERNAL = 'internal';
const ACTIVE: DownloadState[] = [
  'queued',
  'running',
  'waiting_network',
  'waiting_wifi',
  'retrying',
];

function engineError(code: DownloadEngineErrorCode, detail: string): DownloadEngineError {
  return Object.assign(new Error(`${code}: ${detail}`), { code });
}

/** Diagnostics only (English, never shown as UI text). */
const failure = (kind: DownloadErrorKind, detail: string): DownloadError => ({
  kind,
  message: detail,
});

function fakeHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0').repeat(8);
}

/** `a//b/./c` → `a/b/c`; rejects empty paths and `..` like the native resolver. */
function normalizePath(relativePath: string): string {
  const parts = relativePath.split('/').filter((part) => part !== '' && part !== '.');
  if (parts.length === 0) throw engineError('invalid_argument', 'empty path');
  if (parts.includes('..')) {
    throw engineError('invalid_argument', `path escapes the download root: ${relativePath}`);
  }
  return parts.join('/');
}

/** In-memory engine with the native semantics (queue, retries, space, ownership, files) for tests and the dev mock. */
export function createFakeDownloadEngine(
  options: FakeDownloadEngineOptions = {}
): FakeDownloadEngine {
  const rootUri = options.rootUri ?? DEFAULT_ROOT;
  const injectedClock = options.now !== undefined;
  const now = options.now ?? Date.now;
  const wallNow = options.wallNow ?? now;
  /** Retry deadlines on the monotonic clock; `retryAt` on the task is only their wall-clock display. */
  const due = new Map<string, number>();
  /** Stopped transfers that have not ended yet: they keep their task's claims (N2-02). */
  const drains = new Map<string, DownloadTask>();
  const stalled = new Set<string>();
  /** Ids whose cancel/remove timed out and has since finished: a retry resolves. */
  const settled = new Set<string>();
  const tasks = new Map<string, DownloadTask>();
  const specs = new Map<string, DownloadSpec>();
  const files = new Map<string, number>();
  const attemptStart = new Map<string, number>();
  const waitingSince = new Map<string, number | null>();
  const progressListeners = new Set<(event: DownloadProgressEvent) => void>();
  const stateListeners = new Set<(event: DownloadStateEvent) => void>();
  const calls: string[] = [];
  let settings: DownloadSettings = { wifiOnly: true, maxConcurrent: 2, ...options.settings };
  let boots = 1;
  let bootId = options.bootId ?? 'fake-boot-1';
  let elapsedBase = options.elapsedMs ?? 0;
  let elapsedOrigin = performance.now();
  const elapsedNow = () => elapsedBase + (injectedClock ? 0 : performance.now() - elapsedOrigin);
  let storage: StorageInfo = { freeBytes: 20 * GB, totalBytes: 64 * GB, ...options.storage };
  const extraVolumes = new Map((options.volumes ?? []).map((volume) => [volume.id, volume]));
  let network: FakeNetwork = options.network ?? 'wifi';
  let permission: NotificationPermission = options.notificationPermission ?? 'granted';
  let deadline: ReturnType<typeof setTimeout> | null = null;

  const key = (relativePath: string, volumeId = INTERNAL) =>
    `${volumeId}:${normalizePath(relativePath)}`;
  const partKey = (task: DownloadTask) => key(`${task.relativePath}.part`, task.volumeId);
  /** The fake keeps files only: a path with files below it is a directory. */
  const isDirectory = (relativePath: string, volumeId = INTERNAL) => {
    const prefix = `${key(relativePath, volumeId)}/`;
    return [...files.keys()].some((name) => name.startsWith(prefix));
  };
  const directoryError = (relativePath: string) =>
    `${normalizePath(relativePath).split('/').pop()} is a directory`;
  const snapshot = (task: DownloadTask): DownloadTask => ({
    ...task,
    error: task.error ? { ...task.error } : undefined,
  });

  const need = (id: string) => {
    const task = tasks.get(id);
    if (!task) throw engineError('not_found', `no download ${id}`);
    return task;
  };

  const hasVolume = (volumeId: string) => volumeId === INTERNAL || extraVolumes.has(volumeId);
  const needVolume = (volumeId = INTERNAL) => {
    if (!hasVolume(volumeId)) throw engineError('not_found', `unknown volume ${volumeId}`);
    return volumeId;
  };

  const checkHeaders = (headers: Record<string, string> | undefined) => {
    const rejected = disallowedHeaders(headers);
    if (rejected.length > 0) {
      throw engineError('invalid_argument', `headers not allowed: ${rejected.join(', ')}`);
    }
  };

  /** A task's final and staging path: case-insensitive, trailing dots and spaces ignored as FAT/exFAT do (N2-01, N3-03). */
  const claimsOf = (path: string, volumeId: string) => {
    const segments = path
      .toLowerCase()
      .split('/')
      .map((segment) => segment.replace(/[. ]+$/, ''));
    const claim = `${volumeId}:${segments.join('/')}`;
    return [claim, `${claim}${STAGING}`];
  };
  /** Equal, ancestor directory or descendant. */
  const overlaps = (a: string, b: string) =>
    a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
  const touches = (task: DownloadTask, path: string, volumeId: string) =>
    claimsOf(task.relativePath, task.volumeId).some((claim) =>
      claimsOf(path, volumeId).some((other) => overlaps(claim, other))
    );

  /** Owns its paths until cancel/remove (a cancelled tombstone owns nothing) or while its transfer drains. */
  const ownerOf = (path: string, volumeId: string) =>
    [...tasks.values()].find(
      (task) => task.state !== 'cancelled' && touches(task, path, volumeId)
    ) ?? [...drains.values()].find((task) => touches(task, path, volumeId));

  /** Registered unfinished task (any state but completed or a tombstone) or a draining one whose paths `path` touches (N3-02). */
  const liveOwnerTouching = (path: string, volumeId: string) =>
    [...tasks.values()].find(
      (task) =>
        task.state !== 'cancelled' && task.state !== 'completed' && touches(task, path, volumeId)
    ) ?? [...drains.values()].find((task) => touches(task, path, volumeId));

  function emitState(task: DownloadTask, state: DownloadState = task.state) {
    const event = { id: task.id, state, task: snapshot({ ...task, state }) };
    stateListeners.forEach((listener) => listener(event));
  }

  function emitProgress(task: DownloadTask, bytesPerSecond: number) {
    const event = {
      id: task.id,
      bytesWritten: task.bytesWritten,
      totalBytes: task.totalBytes,
      bytesPerSecond,
    };
    progressListeners.forEach((listener) => listener(event));
  }

  function setState(task: DownloadTask, state: DownloadState, patch: Partial<DownloadTask> = {}) {
    if ('retryAt' in patch && patch.retryAt === undefined) due.delete(task.id);
    const changed = task.state !== state || Object.keys(patch).length > 0;
    Object.assign(task, patch, { state, updatedAt: now() });
    if (changed) emitState(task);
  }

  function blockedState(): DownloadState | null {
    if (network === 'none') return 'waiting_network';
    if (network === 'metered' && settings.wifiOnly) return 'waiting_wifi';
    return null;
  }

  const totalOf = (task: DownloadTask) =>
    task.totalBytes ?? specs.get(task.id)?.expectedBytes ?? null;

  /** Native free-space rule: remaining bytes of this and every other running task plus 64 MiB. */
  function spaceError(task: DownloadTask): DownloadError | null {
    const total = totalOf(task);
    if (total === null) return null;
    const needed = total - task.bytesWritten;
    const reserved = [...tasks.values()]
      .filter((other) => other !== task && other.state === 'running')
      .filter((other) => other.volumeId === task.volumeId)
      .reduce((sum, other) => sum + Math.max(0, (totalOf(other) ?? 0) - other.bytesWritten), 0);
    if (storage.freeBytes - reserved >= needed + RESERVE_BYTES) return null;
    return failure('disk_full', `needs ${needed} bytes, ${storage.freeBytes - reserved} free`);
  }

  function startRunning(task: DownloadTask) {
    if (!hasVolume(task.volumeId)) {
      setState(task, 'failed', { error: failure('file_system', 'volume_unavailable') });
      return false;
    }
    const full = spaceError(task);
    if (full) {
      setState(task, 'failed', { error: full, retryAt: undefined });
      return false;
    }
    attemptStart.set(task.id, task.bytesWritten);
    setState(task, 'running', { totalBytes: totalOf(task), retryAt: undefined });
    return true;
  }

  function scheduleDeadline() {
    if (injectedClock) return;
    if (deadline !== null) clearTimeout(deadline);
    deadline = null;
    const next = Math.min(
      ...[...tasks.values()]
        .filter((task) => ACTIVE.includes(task.state) && due.has(task.id))
        .map((task) => due.get(task.id)!)
    );
    if (!Number.isFinite(next)) return;
    deadline = setTimeout(pump, Math.max(0, next - now()));
    (deadline as { unref?: () => void }).unref?.();
  }

  function pump() {
    const at = now();
    const active = [...tasks.values()].filter((task) => ACTIVE.includes(task.state));
    const blocked = blockedState();
    if (blocked) {
      // A pending retryAt survives network changes (the server cooldown is never shortened).
      active.forEach((task) => setState(task, blocked));
      scheduleDeadline();
      return;
    }
    let slots = settings.maxConcurrent - active.filter((task) => task.state === 'running').length;
    for (const task of active) {
      if (task.state === 'running') continue;
      const deadline = due.get(task.id);
      if (deadline !== undefined && deadline > at) {
        if (task.state !== 'retrying') setState(task, 'retrying');
        continue;
      }
      if (slots > 0 && startRunning(task)) slots -= 1;
      else if (task.state !== 'failed') setState(task, 'queued', { retryAt: undefined });
    }
    scheduleDeadline();
  }

  function writeProgress(task: DownloadTask, bytesWritten: number, bytesPerSecond: number) {
    task.bytesWritten = bytesWritten;
    task.updatedAt = now();
    files.set(partKey(task), bytesWritten);
    emitProgress(task, bytesPerSecond);
  }

  function complete(task: DownloadTask) {
    // The publish never replaces a directory (N8-03, N9-02): not retried, the partial stays.
    if (isDirectory(task.relativePath, task.volumeId)) {
      const error = failure('file_system', `invalid_state: ${directoryError(task.relativePath)}`);
      setState(task, 'failed', { error, retryAt: undefined });
      pump();
      return;
    }
    const size = totalOf(task) ?? task.bytesWritten;
    files.delete(partKey(task));
    files.set(key(task.relativePath, task.volumeId), size);
    storage = { ...storage, freeBytes: Math.max(0, storage.freeBytes - size) };
    waitingSince.delete(task.id);
    setState(task, 'completed', {
      bytesWritten: size,
      totalBytes: size,
      attempts: 0,
      error: undefined,
      retryAt: undefined,
    });
    emitProgress(task, 0);
    pump();
  }

  /** A failed attempt through the shared retry rules (same as Android and iOS). */
  function attemptFailed(
    task: DownloadTask,
    error: DownloadError,
    retryable: boolean,
    retryAfterMs: number | null,
    progressBytes: number | undefined
  ) {
    if (!ACTIVE.includes(task.state)) return;
    const at = now();
    const written =
      progressBytes ?? task.bytesWritten - (attemptStart.get(task.id) ?? task.bytesWritten);
    if (retryable && network === 'none') {
      setState(task, 'waiting_network', { error });
      return;
    }
    const decision = decideRetry(
      { attempts: task.attempts, waitingSince: waitingSince.get(task.id) ?? null },
      { now: at, retryable, retryAfterMs, progressBytes: written }
    );
    waitingSince.set(task.id, decision.waitingSince);
    const reported = retryAfterMs === null ? error : { ...error, retryAfterMs };
    if (decision.action === 'retry') {
      due.set(task.id, decision.retryAt!);
      setState(task, 'retrying', {
        error: reported,
        attempts: decision.attempts,
        retryAt: wallNow() + (decision.retryAt! - at),
      });
      scheduleDeadline();
    } else {
      setState(task, 'failed', {
        error: reported,
        attempts: decision.attempts,
        retryAt: undefined,
      });
      pump();
    }
  }

  const uriFor = (relativePath: string, volumeId = INTERNAL) => {
    needVolume(volumeId);
    const path = normalizePath(relativePath);
    return volumeId === INTERNAL
      ? `${rootUri}${path}`
      : `file:///storage/${volumeId}/Android/data/dev.streamarr.app/files/downloads/${path}`;
  };

  /** Deletes a file or a directory with everything below it; returns the freed bytes. */
  const deleteKeys = (relativePath: string, volumeId = INTERNAL) => {
    const exact = key(relativePath, volumeId);
    let freed = 0;
    for (const [name, size] of [...files.entries()]) {
      if (name === exact || name.startsWith(`${exact}/`)) {
        files.delete(name);
        freed += size;
      }
    }
    return freed;
  };

  const controls: FakeDownloadControls = {
    calls,
    tasks: () => [...tasks.values()].map(snapshot),
    progress(id, bytesWritten, progressOptions = {}) {
      const task = need(id);
      if (progressOptions.totalBytes !== undefined) task.totalBytes = progressOptions.totalBytes;
      if (task.state !== 'running') setState(task, 'running');
      if (bytesWritten > task.bytesWritten) waitingSince.delete(id);
      writeProgress(task, bytesWritten, progressOptions.bytesPerSecond ?? 0);
    },
    complete: (id) => complete(need(id)),
    fail(id, error) {
      const task = need(id);
      const detail = typeof error === 'string' ? failure(error, `fake ${error}`) : error;
      setState(task, 'failed', { error: detail, attempts: task.attempts + 1, retryAt: undefined });
      pump();
    },
    httpStatus(id, status, statusOptions = {}) {
      const task = need(id);
      const retryable = httpStatusAction(status) === 'retry';
      let retryAfterMs: number | null = null;
      if (retryable && statusOptions.retryAfter !== undefined) {
        retryAfterMs = parseRetryAfter(statusOptions.retryAfter, now());
      } else if (retryable && statusOptions.retryAfterMs !== undefined) {
        retryAfterMs = Math.min(
          MAX_RETRY_AFTER_MS,
          Math.max(MIN_RETRY_MS, statusOptions.retryAfterMs)
        );
      }
      const error: DownloadError = { ...failure('http', `HTTP ${status}`), httpStatus: status };
      attemptFailed(task, error, retryable, retryAfterMs, statusOptions.progressBytes);
    },
    networkError(id, errorOptions = {}) {
      const task = need(id);
      const error = failure('network', errorOptions.message ?? 'fake connection reset');
      attemptFailed(task, error, true, null, errorOptions.progressBytes);
    },
    setState(id, state, patch) {
      const task = need(id);
      if (patch?.retryAt !== undefined) due.set(id, now() + (patch.retryAt - wallNow()));
      setState(task, state, patch);
    },
    userCancel(id) {
      const task = need(id);
      if (task.state === 'cancelled') return;
      if (task.state === 'completed' || task.state === 'failed') {
        throw engineError('invalid_state', `download ${id} is ${task.state}`);
      }
      attemptStart.delete(id);
      waitingSince.delete(id);
      if (stalled.has(id)) drains.set(id, { ...task });
      else files.delete(partKey(task));
      setState(task, 'cancelled', { bytesWritten: 0, error: undefined, retryAt: undefined });
      pump();
    },
    stallDrain(id) {
      stalled.add(id);
    },
    releaseDrain(id) {
      stalled.delete(id);
      const drained = drains.get(id);
      if (!drained) return;
      drains.delete(id);
      settled.add(id);
      files.delete(partKey(drained));
      pump();
    },
    setNetwork(next) {
      network = next;
      pump();
    },
    setStorage(next) {
      storage = { ...storage, ...next };
    },
    setNotificationPermission(next) {
      permission = next;
    },
    mountVolume(volume) {
      extraVolumes.set(volume.id, volume);
      for (const task of tasks.values()) {
        if (task.volumeId === volume.id && task.error?.message === 'volume_unavailable') {
          setState(task, 'queued', { error: undefined, attempts: 0 });
        }
      }
      pump();
    },
    unmountVolume(id) {
      extraVolumes.delete(id);
      for (const task of tasks.values()) {
        if (task.volumeId === id && ACTIVE.includes(task.state)) {
          setState(task, 'failed', { error: failure('file_system', 'volume_unavailable') });
        }
      }
      pump();
    },
    tick: () => pump(),
    writeFile(relativePath, size, volumeId) {
      files.set(key(relativePath, volumeId), size);
    },
    files: () => Object.fromEntries(files),
    advanceElapsed(ms) {
      elapsedBase += Math.max(0, ms);
    },
    reboot() {
      boots += 1;
      bootId = `fake-boot-${boots}`;
      elapsedBase = 0;
      elapsedOrigin = performance.now();
    },
    autoRun({ bytesPerTick = 64 * 1024 ** 2, tickMs = 500 } = {}) {
      const timer = setInterval(() => {
        for (const task of tasks.values()) {
          if (task.state !== 'running') continue;
          const total = totalOf(task) ?? 512 * 1024 ** 2;
          task.totalBytes = total;
          const next = Math.min(total, task.bytesWritten + bytesPerTick);
          writeProgress(task, next, (bytesPerTick * 1000) / tickMs);
          if (next >= total) complete(task);
        }
      }, tickMs);
      return () => clearInterval(timer);
    },
  };

  const internalVolume = (): StorageVolume => ({
    id: INTERNAL,
    uri: rootUri,
    removable: false,
    ...storage,
  });

  const engine: FakeDownloadEngine = {
    isSupported: true,
    rootUri,
    controls,
    clock: () => ({ elapsedMs: elapsedNow(), bootId }),
    async storage(volumeId) {
      if (volumeId === undefined || volumeId === INTERNAL) return { ...storage };
      const volume = extraVolumes.get(needVolume(volumeId))!;
      return { freeBytes: volume.freeBytes, totalBytes: volume.totalBytes };
    },
    volumes: async () => [internalVolume(), ...[...extraVolumes.values()].map((v) => ({ ...v }))],
    async start(spec) {
      calls.push(`start:${spec.id}`);
      const existing = tasks.get(spec.id);
      if (existing) return snapshot(existing);
      if (!/^https?:\/\//.test(spec.url))
        throw engineError('invalid_argument', 'url must be http(s)');
      checkHeaders(spec.headers);
      const volumeId = needVolume(spec.volumeId);
      const relativePath = normalizePath(spec.relativePath);
      if (relativePath.toLowerCase().endsWith(STAGING)) {
        throw engineError('invalid_argument', `a download path may not end in ${STAGING}`);
      }
      // FAT/exFAT drop trailing dots and spaces, so such a name would alias another (N3-03).
      if (relativePath.split('/').some((segment) => /[. ]$/.test(segment))) {
        throw engineError(
          'invalid_argument',
          `a path segment may not end in a dot or space: ${relativePath}`
        );
      }
      const owner = ownerOf(relativePath, volumeId);
      if (owner) {
        throw engineError('invalid_state', `path ${relativePath} belongs to download ${owner.id}`);
      }
      if (
        isDirectory(relativePath, volumeId) ||
        isDirectory(`${relativePath}${STAGING}`, volumeId)
      ) {
        throw engineError('invalid_state', `path ${relativePath} is a directory`);
      }
      const created = now();
      const task: DownloadTask = {
        id: spec.id,
        url: spec.url,
        relativePath,
        volumeId,
        uri: uriFor(relativePath, volumeId),
        state: 'queued',
        bytesWritten: 0,
        totalBytes: spec.expectedBytes ?? null,
        etag: spec.etag ?? null,
        restarts: 0,
        attempts: 0,
        createdAt: created,
        updatedAt: created,
      };
      tasks.set(spec.id, task);
      specs.set(spec.id, { ...spec, relativePath, volumeId });
      emitState(task);
      pump();
      return snapshot(task);
    },
    async pause(id) {
      calls.push(`pause:${id}`);
      const task = need(id);
      if (ACTIVE.includes(task.state)) setState(task, 'paused', { retryAt: undefined });
      pump();
    },
    async resume(id, update) {
      calls.push(`resume:${id}`);
      const task = need(id);
      if (update?.url !== undefined && !/^https?:\/\//.test(update.url)) {
        throw engineError('invalid_argument', 'url must be http(s)');
      }
      checkHeaders(update?.headers);
      if (update?.url) task.url = update.url;
      if (update?.headers) specs.set(id, { ...specs.get(id)!, headers: update.headers });
      if (task.state === 'paused' || task.state === 'failed') {
        waitingSince.delete(id);
        setState(task, 'queued', { attempts: 0, error: undefined, retryAt: undefined });
      } else if (task.state === 'retrying') {
        setState(task, 'queued', { retryAt: undefined });
      }
      pump();
    },
    async cancel(id) {
      calls.push(`cancel:${id}`);
      const task = tasks.get(id);
      if (!task) {
        // A retry after `cancel_pending` waits for the same drain; once it ended the retry resolves.
        if (drains.has(id)) throw engineError('io', 'cancel_pending');
        if (settled.delete(id)) return;
        throw engineError('not_found', `no download ${id}`);
      }
      tasks.delete(id);
      attemptStart.delete(id);
      waitingSince.delete(id);
      due.delete(id);
      // A tombstone is only forgotten; one whose transfer still drains is waited for like `remove` (N3-06).
      if (task.state === 'cancelled') {
        if (drains.has(id)) throw engineError('io', 'cancel_pending');
        return;
      }
      emitState({ ...task, error: failure('cancelled', 'cancelled') }, 'cancelled');
      pump();
      if (stalled.has(id)) {
        drains.set(id, { ...task });
        throw engineError('io', 'cancel_pending');
      }
      files.delete(partKey(task));
    },
    async remove(id) {
      calls.push(`remove:${id}`);
      const task = tasks.get(id);
      if (!task) {
        if (drains.has(id)) throw engineError('io', 'remove_pending');
        settled.delete(id);
        return;
      }
      if (ACTIVE.includes(task.state) || task.state === 'paused') {
        throw engineError('invalid_state', `download ${id} is ${task.state}`);
      }
      tasks.delete(id);
      attemptStart.delete(id);
      waitingSince.delete(id);
      // A failed task's transfer may still be ending (missing volume, failure): it keeps the path until then (N2-02).
      if (stalled.has(id) && task.state === 'failed') {
        drains.set(id, { ...task });
        throw engineError('io', 'remove_pending');
      }
      if (drains.has(id)) throw engineError('io', 'remove_pending');
      if (task.state === 'failed') files.delete(partKey(task));
    },
    list: async () => controls.tasks(),
    get: async (id) => {
      const task = tasks.get(id);
      return task ? snapshot(task) : null;
    },
    getSettings: async () => ({ ...settings }),
    async setWifiOnly(wifiOnly) {
      settings = { ...settings, wifiOnly };
      pump();
    },
    async setMaxConcurrent(maxConcurrent) {
      settings = {
        ...settings,
        maxConcurrent: Math.min(6, Math.max(1, Math.round(maxConcurrent))),
      };
      const running = [...tasks.values()].filter((task) => task.state === 'running');
      running.slice(settings.maxConcurrent).forEach((task) => setState(task, 'queued'));
      pump();
    },
    getNotificationPermission: async () => permission,
    async requestNotificationPermission() {
      if (permission === 'undetermined') permission = 'granted';
      return permission;
    },
    addProgressListener(listener) {
      progressListeners.add(listener);
      return { remove: () => progressListeners.delete(listener) };
    },
    addStateListener(listener) {
      stateListeners.add(listener);
      return { remove: () => stateListeners.delete(listener) };
    },
    uriFor,
    contentUriFor: async (relativePath, uriOptions) =>
      options.contentUris === false
        ? null
        : `content://dev.streamarr.app.offline-downloads/${uriOptions?.volumeId ?? INTERNAL}/${normalizePath(relativePath)}`,
    exists: async (relativePath, volumeId) => files.has(key(relativePath, needVolume(volumeId))),
    fileSize: async (relativePath, volumeId) =>
      files.get(key(relativePath, needVolume(volumeId))) ?? null,
    async deletePath(relativePath, volumeId = INTERNAL) {
      const path = normalizePath(relativePath);
      const owner = liveOwnerTouching(path, needVolume(volumeId));
      if (owner)
        throw engineError('invalid_state', `${path} belongs to unfinished download ${owner.id}`);
      storage = { ...storage, freeBytes: storage.freeBytes + deleteKeys(path, volumeId) };
    },
    async move(from, to, volumeId = INTERNAL) {
      needVolume(volumeId);
      for (const path of [normalizePath(from), normalizePath(to)]) {
        const owner = liveOwnerTouching(path, volumeId);
        if (owner)
          throw engineError('invalid_state', `${path} belongs to unfinished download ${owner.id}`);
      }
      const source = key(from, volumeId);
      if (!files.has(source)) throw engineError('not_found', `missing ${from}`);
      if (isDirectory(to, volumeId)) throw engineError('invalid_state', directoryError(to));
      files.set(key(to, volumeId), files.get(source)!);
      files.delete(source);
    },
    async sha256(relativePath, volumeId) {
      const size = files.get(key(relativePath, needVolume(volumeId)));
      if (size === undefined) throw engineError('not_found', `missing ${relativePath}`);
      return fakeHash(`${normalizePath(relativePath)}:${size}`);
    },
  };
  return engine;
}
