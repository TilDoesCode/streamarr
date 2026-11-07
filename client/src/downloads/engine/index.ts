import { requireOptionalNativeModule } from 'expo';
import { Platform } from 'react-native';

import { createFakeDownloadEngine } from './fake';
import { disallowedHeaders } from './http-policy';
import type {
  DownloadEngine,
  EngineClock,
  DownloadEngineError,
  DownloadEngineErrorCode,
  DownloadProgressEvent,
  DownloadSettings,
  DownloadSpec,
  DownloadStateEvent,
  DownloadTask,
  NotificationPermission,
  StorageInfo,
  StorageVolume,
} from './types';

export type * from './types';

type NativeOfflineDownloads = {
  rootUri: string;
  /** Synchronous; missing in native builds before fix round 3b. */
  clock?: () => EngineClock;
  storage(volumeId: string | null): Promise<StorageInfo>;
  volumes(): Promise<StorageVolume[]>;
  start(spec: DownloadSpec): Promise<DownloadTask>;
  pause(id: string): Promise<void>;
  resume(id: string, url: string | null, headers: Record<string, string> | null): Promise<void>;
  cancel(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  list(): Promise<DownloadTask[]>;
  get(id: string): Promise<DownloadTask | null>;
  getSettings(): Promise<DownloadSettings>;
  setWifiOnly(wifiOnly: boolean): Promise<void>;
  setMaxConcurrent(maxConcurrent: number): Promise<void>;
  getNotificationPermission(): Promise<NotificationPermission>;
  requestNotificationPermission(): Promise<NotificationPermission>;
  uriFor(relativePath: string, volumeId: string | null): string;
  contentUriFor(
    relativePath: string,
    volumeId: string | null,
    grantPackage: string | null
  ): Promise<string | null>;
  exists(relativePath: string, volumeId: string | null): Promise<boolean>;
  fileSize(relativePath: string, volumeId: string | null): Promise<number | null>;
  deletePath(relativePath: string, volumeId: string | null): Promise<void>;
  move(from: string, to: string, volumeId: string | null): Promise<void>;
  sha256(relativePath: string, volumeId: string | null): Promise<string>;
  addListener(
    event: 'onProgress',
    listener: (event: DownloadProgressEvent) => void
  ): { remove(): void };
  addListener(event: 'onState', listener: (event: DownloadStateEvent) => void): { remove(): void };
};

const CODES: DownloadEngineErrorCode[] = [
  'not_supported',
  'not_found',
  'invalid_argument',
  'invalid_state',
  'io',
];

/** Builds a rejection the way the native module does: `code` plus a message prefixed with it. */
export function downloadEngineError(
  code: DownloadEngineErrorCode,
  detail: string
): DownloadEngineError {
  return Object.assign(new Error(`${code}: ${detail}`), { code });
}

/** Native rejections carry the code as the message prefix ("not_found: …"); anything else becomes `io` with its full message. */
export function toDownloadEngineError(error: unknown): DownloadEngineError {
  const message = error instanceof Error ? error.message : String(error);
  const native = (error as { code?: unknown } | null)?.code;
  const code =
    CODES.find((candidate) => message.includes(`${candidate}:`)) ??
    CODES.find((candidate) => candidate === native);
  if (!code) return downloadEngineError('io', message);
  const at = message.indexOf(`${code}:`);
  const detail = at < 0 ? message : message.slice(at + code.length + 1).trim() || message;
  return downloadEngineError(code, detail);
}

/** Capability URLs need no headers and redirects may leave the origin: only harmless ones pass. */
function checkHeaders(headers: Record<string, string> | undefined): void {
  const rejected = disallowedHeaders(headers);
  if (rejected.length > 0) {
    throw downloadEngineError('invalid_argument', `headers not allowed: ${rejected.join(', ')}`);
  }
}

const call = async <T>(run: () => Promise<T>): Promise<T> => {
  try {
    return await run();
  } catch (error) {
    throw toDownloadEngineError(error);
  }
};

/** Downloads exist on iOS/iPadOS and Android (incl. Android TV), not on web or Apple TV. */
export function platformSupportsDownloads(
  os: string = Platform.OS,
  isTV: boolean = Platform.isTV
): boolean {
  return os === 'android' || (os === 'ios' && !isTV);
}

const PROCESS_BOOT_ID = `process-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/** Where the native clock is missing: monotonic within this process only, so its id is per process. */
export function processClock(): EngineClock {
  return { elapsedMs: performance.now(), bootId: PROCESS_BOOT_ID };
}

const isClock = (value: unknown): value is EngineClock =>
  typeof (value as EngineClock | null)?.elapsedMs === 'number' &&
  Number.isFinite((value as EngineClock).elapsedMs) &&
  typeof (value as EngineClock).bootId === 'string' &&
  (value as EngineClock).bootId.length > 0;

const unsupported = (): never => {
  throw downloadEngineError('not_supported', 'downloads are not available on this device');
};

/** Every call rejects with `not_supported`; listeners are no-ops. */
export const unsupportedDownloadEngine: DownloadEngine = {
  isSupported: false,
  rootUri: null,
  clock: processClock,
  storage: async () => unsupported(),
  volumes: async () => unsupported(),
  start: async () => unsupported(),
  pause: async () => unsupported(),
  resume: async () => unsupported(),
  cancel: async () => unsupported(),
  remove: async () => unsupported(),
  list: async () => unsupported(),
  get: async () => unsupported(),
  getSettings: async () => unsupported(),
  setWifiOnly: async () => unsupported(),
  setMaxConcurrent: async () => unsupported(),
  getNotificationPermission: async () => unsupported(),
  requestNotificationPermission: async () => unsupported(),
  addProgressListener: () => ({ remove: () => {} }),
  addStateListener: () => ({ remove: () => {} }),
  uriFor: () => unsupported(),
  contentUriFor: async () => unsupported(),
  exists: async () => unsupported(),
  fileSize: async () => unsupported(),
  deletePath: async () => unsupported(),
  move: async () => unsupported(),
  sha256: async () => unsupported(),
};

export function nativeDownloadEngine(native: NativeOfflineDownloads): DownloadEngine {
  return {
    isSupported: true,
    rootUri: native.rootUri,
    clock: () => {
      try {
        const value = native.clock?.();
        if (isClock(value)) return { elapsedMs: value.elapsedMs, bootId: value.bootId };
      } catch {
        // Never fails: the process clock stands in.
      }
      return processClock();
    },
    storage: (volumeId) => call(() => native.storage(volumeId ?? null)),
    volumes: () => call(() => native.volumes()),
    start: (spec) =>
      call(async () => {
        checkHeaders(spec.headers);
        return native.start(spec);
      }),
    pause: (id) => call(() => native.pause(id)),
    resume: (id, update) =>
      call(async () => {
        checkHeaders(update?.headers);
        return native.resume(id, update?.url ?? null, update?.headers ?? null);
      }),
    cancel: (id) => call(() => native.cancel(id)),
    remove: (id) => call(() => native.remove(id)),
    list: () => call(() => native.list()),
    get: (id) => call(() => native.get(id)),
    getSettings: () => call(() => native.getSettings()),
    setWifiOnly: (wifiOnly) => call(() => native.setWifiOnly(wifiOnly)),
    setMaxConcurrent: (maxConcurrent) => call(() => native.setMaxConcurrent(maxConcurrent)),
    getNotificationPermission: () => call(() => native.getNotificationPermission()),
    requestNotificationPermission: () => call(() => native.requestNotificationPermission()),
    addProgressListener: (listener) => native.addListener('onProgress', listener),
    addStateListener: (listener) => native.addListener('onState', listener),
    uriFor: (relativePath, volumeId) => {
      try {
        return native.uriFor(relativePath, volumeId ?? null);
      } catch (error) {
        throw toDownloadEngineError(error);
      }
    },
    contentUriFor: (relativePath, options) =>
      call(() =>
        native.contentUriFor(relativePath, options?.volumeId ?? null, options?.grantPackage ?? null)
      ),
    exists: (relativePath, volumeId) => call(() => native.exists(relativePath, volumeId ?? null)),
    fileSize: (relativePath, volumeId) =>
      call(() => native.fileSize(relativePath, volumeId ?? null)),
    deletePath: (relativePath, volumeId) =>
      call(() => native.deletePath(relativePath, volumeId ?? null)),
    move: (from, to, volumeId) => call(() => native.move(from, to, volumeId ?? null)),
    sha256: (relativePath, volumeId) => call(() => native.sha256(relativePath, volumeId ?? null)),
  };
}

function createDownloadEngine(): DownloadEngine {
  // Dev mock (EXPO_PUBLIC_DOWNLOAD_ENGINE_MOCK=1): simulated transfers, so UI work needs no native rebuild.
  if (process.env.EXPO_PUBLIC_DOWNLOAD_ENGINE_MOCK === '1') {
    const fake = createFakeDownloadEngine();
    fake.controls.autoRun();
    return fake;
  }
  if (!platformSupportsDownloads()) return unsupportedDownloadEngine;
  const native = requireOptionalNativeModule<NativeOfflineDownloads>('OfflineDownloads');
  return native ? nativeDownloadEngine(native) : unsupportedDownloadEngine;
}

/** The device's download engine; `isSupported` is false on web, Apple TV and builds without the native module. */
export const downloadEngine: DownloadEngine = createDownloadEngine();

// Dev builds: reachable from Argent's debugger-evaluate (device tests drive the engine directly).
if (__DEV__)
  (globalThis as { __streamarrDownloads?: DownloadEngine }).__streamarrDownloads = downloadEngine;
