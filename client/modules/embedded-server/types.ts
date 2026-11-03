export type EmbeddedServerState = 'stopped' | 'starting' | 'running' | 'stopping' | 'failed';

export type EmbeddedServerAddress = {
  kind: 'lan' | 'tailscale' | 'loopback' | 'other';
  /** Base URL of the management UI and API, e.g. http://192.168.1.20:8080 */
  url: string;
  interfaceName?: string;
};

/** Stable codes of rejected calls: `error.code`, and the message starts with the code ("port_in_use: …"). */
export type EmbeddedServerErrorCode =
  | 'port_in_use'
  | 'bundle_missing'
  | 'service_unavailable'
  | 'start_failed'
  | 'stop_failed'
  | 'not_supported';

export type EmbeddedServerError = Error & { code: EmbeddedServerErrorCode };

export type EmbeddedServerStatus = {
  state: EmbeddedServerState;
  /** Configured port (applies on the next start). */
  port: number;
  /** The port the process actually bound; undefined while not running. */
  runningPort?: number;
  autostart: boolean;
  /** Core Server version once the process reported it. */
  version?: string;
  /** Epoch milliseconds of the current start; undefined in every state but running. */
  startedAt?: number;
  pid?: number;
  /** Last failure, English and not localized (shown as a detail). */
  lastError?: string;
  /** Automatic restarts since the last manual start. */
  restartCount: number;
  /** Empty while not running; kinds repeat when several interfaces are up (eth0 and wlan0 are both lan). */
  addresses: EmbeddedServerAddress[];
  dataPath: string;
  diskFreeBytes?: number;
  /** Version of the bundled server (dotnet publish + ffmpeg bundle). */
  bundleVersion: string;
};

/** `password` is null once the admin password was changed in the web UI. */
export type EmbeddedServerCredentials = { username: string; password: string | null };

export type EmbeddedServerApi = {
  /** Native module present (Android arm64 build with the server bundle) or the dev mock is on. */
  readonly supported: boolean;
  getStatus(): Promise<EmbeddedServerStatus>;
  start(): Promise<EmbeddedServerStatus>;
  stop(): Promise<EmbeddedServerStatus>;
  /** Stop, then start again (a changed port applies). */
  restart(): Promise<EmbeddedServerStatus>;
  setAutostart(enabled: boolean): Promise<EmbeddedServerStatus>;
  /** Applies on the next start. */
  setPort(port: number): Promise<EmbeddedServerStatus>;
  getCredentials(): Promise<EmbeddedServerCredentials>;
  /** Restarts the server with a fresh bootstrap admin password. */
  resetAdminPassword(): Promise<EmbeddedServerCredentials>;
  getLogs(maxLines?: number): Promise<string[]>;
  addStatusListener(listener: (status: EmbeddedServerStatus) => void): { remove(): void };
  /** After `resetAdminPassword`, and when the server reports the password was changed in the web UI (`password: null`). */
  addCredentialsListener(listener: (credentials: EmbeddedServerCredentials) => void): {
    remove(): void;
  };
};
