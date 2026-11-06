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
} from './types';

export type FakeNetwork = 'wifi' | 'metered' | 'none';

export type FakeDownloadEngineOptions = {
  rootUri?: string;
  settings?: Partial<DownloadSettings>;
  storage?: Partial<StorageInfo>;
  network?: FakeNetwork;
  notificationPermission?: NotificationPermission;
  /** Answer of `contentUriFor` (iOS returns null). */
  contentUris?: boolean;
  now?: () => number;
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
  /** Writes the file (size = total, expected or written bytes) and emits `completed`. */
  complete(id: string): void;
  fail(id: string, error: DownloadErrorKind | DownloadError): void;
  /** Any state (e.g. `retrying`, `waiting_network`) with an optional patch; emits a state event. */
  setState(id: string, state: DownloadState, patch?: Partial<DownloadTask>): void;
  setNetwork(network: FakeNetwork): void;
  setStorage(storage: Partial<StorageInfo>): void;
  setNotificationPermission(permission: NotificationPermission): void;
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
const GB = 1024 ** 3;
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

function fakeHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0').repeat(8);
}

/** In-memory engine with the native semantics (queue, concurrency, Wi-Fi only, files) for tests and the dev mock. */
export function createFakeDownloadEngine(
  options: FakeDownloadEngineOptions = {}
): FakeDownloadEngine {
  const rootUri = options.rootUri ?? DEFAULT_ROOT;
  const now = options.now ?? Date.now;
  const tasks = new Map<string, DownloadTask>();
  const specs = new Map<string, DownloadSpec>();
  const files = new Map<string, number>();
  const progressListeners = new Set<(event: DownloadProgressEvent) => void>();
  const stateListeners = new Set<(event: DownloadStateEvent) => void>();
  const calls: string[] = [];
  let settings: DownloadSettings = { wifiOnly: true, maxConcurrent: 2, ...options.settings };
  let storage: StorageInfo = { freeBytes: 20 * GB, totalBytes: 64 * GB, ...options.storage };
  let network: FakeNetwork = options.network ?? 'wifi';
  let permission: NotificationPermission = options.notificationPermission ?? 'granted';

  const key = (relativePath: string, volumeId = 'internal') => `${volumeId}:${relativePath}`;
  const partKey = (task: DownloadTask) => key(`${task.relativePath}.part`, task.volumeId);
  const snapshot = (task: DownloadTask): DownloadTask => ({
    ...task,
    error: task.error ? { ...task.error } : undefined,
  });

  const need = (id: string) => {
    const task = tasks.get(id);
    if (!task) throw engineError('not_found', `no download ${id}`);
    return task;
  };

  function emitState(task: DownloadTask, state: DownloadState = task.state) {
    const event = { id: task.id, state, task: snapshot({ ...task, state }) };
    stateListeners.forEach((listener) => listener(event));
  }

  function setState(task: DownloadTask, state: DownloadState, patch: Partial<DownloadTask> = {}) {
    const changed = task.state !== state || Object.keys(patch).length > 0;
    Object.assign(task, patch, { state, updatedAt: now() });
    if (changed) emitState(task);
  }

  function blockedState(): DownloadState | null {
    if (network === 'none') return 'waiting_network';
    if (network === 'metered' && settings.wifiOnly) return 'waiting_wifi';
    return null;
  }

  function startRunning(task: DownloadTask) {
    const total = task.totalBytes ?? specs.get(task.id)?.expectedBytes ?? null;
    if (total !== null && total - task.bytesWritten > storage.freeBytes) {
      setState(task, 'failed', {
        error: { kind: 'disk_full', message: `needs ${total - task.bytesWritten} bytes` },
      });
      return false;
    }
    setState(task, 'running', { totalBytes: total, retryAt: undefined });
    return true;
  }

  function pump() {
    const active = [...tasks.values()].filter((task) => ACTIVE.includes(task.state));
    const blocked = blockedState();
    if (blocked) {
      active.forEach((task) => setState(task, blocked));
      return;
    }
    let slots = settings.maxConcurrent - active.filter((task) => task.state === 'running').length;
    for (const task of active) {
      if (task.state === 'running' || task.state === 'retrying') continue;
      if (slots > 0 && startRunning(task)) slots -= 1;
      else if (task.state !== 'failed') setState(task, 'queued');
    }
  }

  function writeProgress(task: DownloadTask, bytesWritten: number, bytesPerSecond: number) {
    task.bytesWritten = bytesWritten;
    task.updatedAt = now();
    files.set(partKey(task), bytesWritten);
    const event = { id: task.id, bytesWritten, totalBytes: task.totalBytes, bytesPerSecond };
    progressListeners.forEach((listener) => listener(event));
  }

  function complete(task: DownloadTask) {
    const size = task.totalBytes ?? specs.get(task.id)?.expectedBytes ?? task.bytesWritten;
    files.delete(partKey(task));
    files.set(key(task.relativePath, task.volumeId), size);
    storage = { ...storage, freeBytes: Math.max(0, storage.freeBytes - size) };
    setState(task, 'completed', {
      bytesWritten: size,
      totalBytes: size,
      attempts: 0,
      error: undefined,
    });
    pump();
  }

  const uriFor = (relativePath: string, volumeId = 'internal') =>
    volumeId === 'internal'
      ? `${rootUri}${relativePath}`
      : `file:///storage/${volumeId}/downloads/${relativePath}`;

  const deleteKeys = (relativePath: string, volumeId = 'internal') => {
    const exact = key(relativePath, volumeId);
    for (const name of [...files.keys()]) {
      if (name === exact || name.startsWith(`${exact}/`)) files.delete(name);
    }
  };

  const controls: FakeDownloadControls = {
    calls,
    tasks: () => [...tasks.values()].map(snapshot),
    progress(id, bytesWritten, progressOptions = {}) {
      const task = need(id);
      if (progressOptions.totalBytes !== undefined) task.totalBytes = progressOptions.totalBytes;
      if (task.state !== 'running') setState(task, 'running');
      writeProgress(task, bytesWritten, progressOptions.bytesPerSecond ?? 0);
    },
    complete: (id) => complete(need(id)),
    fail(id, error) {
      const task = need(id);
      const detail = typeof error === 'string' ? { kind: error, message: `fake ${error}` } : error;
      setState(task, 'failed', { error: detail, attempts: task.attempts + 1 });
      pump();
    },
    setState(id, state, patch) {
      setState(need(id), state, patch);
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
    writeFile(relativePath, size, volumeId) {
      files.set(key(relativePath, volumeId), size);
    },
    files: () => Object.fromEntries(files),
    autoRun({ bytesPerTick = 64 * 1024 ** 2, tickMs = 500 } = {}) {
      const timer = setInterval(() => {
        for (const task of tasks.values()) {
          if (task.state !== 'running') continue;
          const total = task.totalBytes ?? specs.get(task.id)?.expectedBytes ?? 512 * 1024 ** 2;
          task.totalBytes = total;
          const next = Math.min(total, task.bytesWritten + bytesPerTick);
          writeProgress(task, next, (bytesPerTick * 1000) / tickMs);
          if (next >= total) complete(task);
        }
      }, tickMs);
      return () => clearInterval(timer);
    },
  };

  const engine: FakeDownloadEngine = {
    isSupported: true,
    rootUri,
    controls,
    storage: async () => ({ ...storage }),
    volumes: async () => [{ id: 'internal', uri: rootUri, removable: false, ...storage }],
    async start(spec) {
      calls.push(`start:${spec.id}`);
      const existing = tasks.get(spec.id);
      if (existing) return snapshot(existing);
      if (!/^https?:\/\//.test(spec.url))
        throw engineError('invalid_argument', 'url must be http(s)');
      if (!spec.relativePath || spec.relativePath.includes('..')) {
        throw engineError('invalid_argument', `bad path ${spec.relativePath}`);
      }
      const created = now();
      const task: DownloadTask = {
        id: spec.id,
        url: spec.url,
        relativePath: spec.relativePath,
        volumeId: spec.volumeId ?? 'internal',
        uri: uriFor(spec.relativePath, spec.volumeId),
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
      specs.set(spec.id, spec);
      emitState(task);
      pump();
      return snapshot(task);
    },
    async pause(id) {
      calls.push(`pause:${id}`);
      const task = need(id);
      if (ACTIVE.includes(task.state)) setState(task, 'paused');
      pump();
    },
    async resume(id, update) {
      calls.push(`resume:${id}`);
      const task = need(id);
      if (update?.url) task.url = update.url;
      if (update?.headers) specs.set(id, { ...specs.get(id)!, headers: update.headers });
      if (task.state === 'paused' || task.state === 'failed' || task.state === 'retrying') {
        setState(task, 'queued', { attempts: 0, error: undefined, retryAt: undefined });
      }
      pump();
    },
    async cancel(id) {
      calls.push(`cancel:${id}`);
      const task = need(id);
      tasks.delete(id);
      files.delete(partKey(task));
      emitState({ ...task, error: { kind: 'cancelled', message: 'cancelled' } }, 'cancelled');
      pump();
    },
    async remove(id) {
      calls.push(`remove:${id}`);
      const task = need(id);
      if (ACTIVE.includes(task.state) || task.state === 'paused') {
        throw engineError('invalid_state', `download ${id} is ${task.state}`);
      }
      tasks.delete(id);
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
        : `content://dev.streamarr.app.offline-downloads/${uriOptions?.volumeId ?? 'internal'}/${relativePath}`,
    exists: async (relativePath, volumeId) => files.has(key(relativePath, volumeId)),
    fileSize: async (relativePath, volumeId) => files.get(key(relativePath, volumeId)) ?? null,
    async deletePath(relativePath, volumeId) {
      const size = files.get(key(relativePath, volumeId)) ?? 0;
      deleteKeys(relativePath, volumeId);
      storage = { ...storage, freeBytes: storage.freeBytes + size };
    },
    async move(from, to, volumeId) {
      const source = key(from, volumeId);
      if (!files.has(source)) throw engineError('not_found', `missing ${from}`);
      files.set(key(to, volumeId), files.get(source)!);
      files.delete(source);
    },
    async sha256(relativePath, volumeId) {
      const size = files.get(key(relativePath, volumeId));
      if (size === undefined) throw engineError('not_found', `missing ${relativePath}`);
      return fakeHash(`${relativePath}:${size}`);
    },
  };
  return engine;
}
