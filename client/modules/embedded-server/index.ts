import { requireOptionalNativeModule } from 'expo';
import { Platform } from 'react-native';

import { mockEmbeddedServer } from './mock';
import type {
  EmbeddedServerApi,
  EmbeddedServerCredentials,
  EmbeddedServerStatus,
} from './types';

export type * from './types';

type NativeEmbeddedServer = {
  getStatus(): Promise<EmbeddedServerStatus>;
  start(): Promise<EmbeddedServerStatus>;
  stop(): Promise<EmbeddedServerStatus>;
  setAutostart(enabled: boolean): Promise<EmbeddedServerStatus>;
  setPort(port: number): Promise<EmbeddedServerStatus>;
  getCredentials(): Promise<EmbeddedServerCredentials>;
  resetAdminPassword(): Promise<EmbeddedServerCredentials>;
  getLogs(maxLines: number): Promise<string[]>;
  addListener(event: 'onStatusChange', listener: (status: EmbeddedServerStatus) => void): { remove(): void };
};

const useMock = process.env.EXPO_PUBLIC_EMBEDDED_SERVER_MOCK === '1';

// Android only; every other platform (and a build without the server bundle) reports `supported: false`.
const native =
  !useMock && Platform.OS === 'android'
    ? requireOptionalNativeModule<NativeEmbeddedServer>('EmbeddedServer')
    : null;

const unsupported = (): never => {
  throw new Error('embedded server is not available on this device');
};

const nativeApi: EmbeddedServerApi = {
  supported: native !== null,
  getStatus: () => (native ? native.getStatus() : unsupported()),
  start: () => (native ? native.start() : unsupported()),
  stop: () => (native ? native.stop() : unsupported()),
  setAutostart: (enabled) => (native ? native.setAutostart(enabled) : unsupported()),
  setPort: (port) => (native ? native.setPort(port) : unsupported()),
  getCredentials: () => (native ? native.getCredentials() : unsupported()),
  resetAdminPassword: () => (native ? native.resetAdminPassword() : unsupported()),
  getLogs: (maxLines = 200) => (native ? native.getLogs(maxLines) : unsupported()),
  addStatusListener: (listener) =>
    native ? native.addListener('onStatusChange', listener) : { remove: () => {} },
};

/** The Core Server bundled into the Android TV app ("server on this device"). */
export const embeddedServer: EmbeddedServerApi = useMock ? mockEmbeddedServer : nativeApi;
