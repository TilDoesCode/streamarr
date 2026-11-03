import type { EmbeddedServerApi, EmbeddedServerCredentials, EmbeddedServerStatus } from './types';

// Dev mock (EXPO_PUBLIC_EMBEDDED_SERVER_MOCK=1): a fake state machine so the UI can be built without the bundle.
const listeners = new Set<(status: EmbeddedServerStatus) => void>();
const credentialsListeners = new Set<(credentials: EmbeddedServerCredentials) => void>();
let credentials: EmbeddedServerCredentials = { username: 'admin', password: 'mock-Passw0rd-xyz' };
let status: EmbeddedServerStatus = {
  state: 'stopped',
  port: 8080,
  autostart: true,
  restartCount: 0,
  addresses: [],
  dataPath: '/data/user/0/dev.streamarr.app/files/server',
  diskFreeBytes: 42 * 1024 * 1024 * 1024,
  bundleVersion: '0.0.0-mock',
};
const logs: string[] = [];

function emit(next: Partial<EmbeddedServerStatus>) {
  status = { ...status, ...next };
  listeners.forEach((listener) => listener(status));
  return status;
}

function emitCredentials(next: EmbeddedServerCredentials) {
  credentials = next;
  credentialsListeners.forEach((listener) => listener(credentials));
  return credentials;
}

function addresses(port: number) {
  return [
    { kind: 'lan' as const, url: `http://192.168.1.20:${port}`, interfaceName: 'wlan0' },
    { kind: 'tailscale' as const, url: `http://100.101.102.103:${port}`, interfaceName: 'tun0' },
    { kind: 'loopback' as const, url: `http://127.0.0.1:${port}` },
  ];
}

export const mockEmbeddedServer: EmbeddedServerApi = {
  supported: true,
  getStatus: async () => status,
  start: async () => {
    if (status.state === 'running') return status;
    logs.push(`[${new Date().toISOString()}] starting Streamarr.Server on :${status.port}`);
    emit({
      state: 'starting',
      lastError: undefined,
      runningPort: undefined,
      startedAt: undefined,
      addresses: [],
    });
    setTimeout(() => {
      // Port 1 simulates a start failure.
      if (status.port === 1) {
        logs.push('bind failed: EACCES');
        emit({ state: 'failed', lastError: 'Port 1: permission denied' });
        return;
      }
      logs.push('Now listening on: http://0.0.0.0:' + status.port);
      emit({
        state: 'running',
        runningPort: status.port,
        startedAt: Date.now(),
        pid: 4242,
        version: '0.21.0',
        addresses: addresses(status.port),
      });
    }, 1500);
    return status;
  },
  stop: async () => {
    if (status.state === 'stopped') return status;
    emit({ state: 'stopping', runningPort: undefined, startedAt: undefined, addresses: [] });
    setTimeout(
      () =>
        emit({
          state: 'stopped',
          runningPort: undefined,
          startedAt: undefined,
          pid: undefined,
          addresses: [],
        }),
      800
    );
    return status;
  },
  restart: async () => {
    await mockEmbeddedServer.stop();
    setTimeout(() => void mockEmbeddedServer.start(), 900);
    return status;
  },
  setAutostart: async (enabled) => emit({ autostart: enabled }),
  setPort: async (port) => emit({ port }),
  getCredentials: async () => credentials,
  resetAdminPassword: async () =>
    emitCredentials({
      username: 'admin',
      password: `mock-${Math.random().toString(36).slice(2, 10)}`,
    }),
  getLogs: async (maxLines = 200) => logs.slice(-maxLines),
  addStatusListener: (listener) => {
    listeners.add(listener);
    return { remove: () => listeners.delete(listener) };
  },
  addCredentialsListener: (listener) => {
    credentialsListeners.add(listener);
    return { remove: () => credentialsListeners.delete(listener) };
  },
};
