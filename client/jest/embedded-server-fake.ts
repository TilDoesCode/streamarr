import type {
  EmbeddedServerApi,
  EmbeddedServerCredentials,
  EmbeddedServerStatus,
} from '@modules/embedded-server';

/** Controllable stand-in for `embeddedServer` (tests flip `supported` and push states with `emit`). */
export type FakeEmbeddedServer = EmbeddedServerApi & {
  supported: boolean;
  credentials: EmbeddedServerCredentials;
  logs: string[];
  emit(next: Partial<EmbeddedServerStatus>): EmbeddedServerStatus;
  emitCredentials(next: EmbeddedServerCredentials): void;
  reset(next?: Partial<EmbeddedServerStatus>): void;
  calls: string[];
};

export const STOPPED: EmbeddedServerStatus = {
  state: 'stopped',
  port: 8080,
  autostart: true,
  restartCount: 0,
  addresses: [],
  dataPath: '/data/server',
  bundleVersion: '1.2.3',
};

export const RUNNING_ADDRESSES = [
  { kind: 'loopback' as const, url: 'http://127.0.0.1:8080' },
  { kind: 'tailscale' as const, url: 'http://100.101.102.103:8080', interfaceName: 'tun0' },
  { kind: 'lan' as const, url: 'http://192.168.1.20:8080', interfaceName: 'wlan0' },
];

export function createFakeEmbeddedServer(): FakeEmbeddedServer {
  const listeners = new Set<(status: EmbeddedServerStatus) => void>();
  const credentialsListeners = new Set<(credentials: EmbeddedServerCredentials) => void>();
  let status = STOPPED;
  const fake: FakeEmbeddedServer = {
    supported: true,
    credentials: { username: 'admin', password: 'Secret-123' },
    logs: [],
    calls: [],
    emit(next) {
      status = { ...status, ...next };
      listeners.forEach((listener) => listener(status));
      return status;
    },
    emitCredentials(next) {
      fake.credentials = next;
      credentialsListeners.forEach((listener) => listener(next));
    },
    reset(next = {}) {
      status = { ...STOPPED, ...next };
      fake.supported = true;
      fake.credentials = { username: 'admin', password: 'Secret-123' };
      fake.logs = [];
      fake.calls = [];
      listeners.clear();
      credentialsListeners.clear();
    },
    getStatus: async () => status,
    start: async () => {
      fake.calls.push('start');
      return fake.emit({
        state: 'starting',
        runningPort: undefined,
        startedAt: undefined,
        addresses: [],
      });
    },
    stop: async () => {
      fake.calls.push('stop');
      return fake.emit({
        state: 'stopping',
        runningPort: undefined,
        startedAt: undefined,
        addresses: [],
      });
    },
    restart: async () => {
      fake.calls.push('restart');
      return fake.emit({ state: 'starting', runningPort: undefined, addresses: [] });
    },
    setAutostart: async (enabled) => {
      fake.calls.push(`autostart:${enabled}`);
      return fake.emit({ autostart: enabled });
    },
    setPort: async (port) => {
      fake.calls.push(`port:${port}`);
      return fake.emit({ port });
    },
    getCredentials: async () => fake.credentials,
    resetAdminPassword: async () => {
      fake.calls.push('reset');
      fake.emitCredentials({ username: 'admin', password: 'Fresh-456' });
      return fake.credentials;
    },
    getLogs: async (maxLines = 200) => fake.logs.slice(-maxLines),
    addStatusListener: (listener) => {
      listeners.add(listener);
      return { remove: () => listeners.delete(listener) };
    },
    addCredentialsListener: (listener) => {
      credentialsListeners.add(listener);
      return { remove: () => credentialsListeners.delete(listener) };
    },
  };
  return fake;
}
