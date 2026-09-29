import { Platform } from 'react-native';

import { AppError, errorFromResponse, isAppError } from './errors';
import { PROBE_TIMEOUT_MS, xhrTransport, type ProbeTransport } from './http';
import type { components } from './schema';
import { isInsecureRemote, parseServerInput } from './server-url';

export type AuthOptions = components['schemas']['ViewerAuthOptionsResponse'];

export type ServerInfo = {
  baseUrl: string;
  /** Server name from the options (admin-configurable); falls back to the host. */
  name: string;
  options: AuthOptions;
  /** Plain http outside private networks. */
  insecure: boolean;
};

export const OPTIONS_PATH = '/api/v1/viewer/auth/options';

// When every candidate fails, report the most specific reason.
const RANK: Record<string, number> = {
  module_disabled: 6,
  not_streamarr: 5,
  rate_limited: 4,
  server_error: 4,
  tls_error: 3,
  mixed_content: 3,
  timeout: 2,
  network_unreachable: 1,
};

function isAuthOptions(value: unknown): value is AuthOptions {
  const options = value as Partial<AuthOptions> | null;
  return (
    !!options &&
    typeof options === 'object' &&
    typeof options.passwordLogin === 'boolean' &&
    typeof options.passwordMinLength === 'number'
  );
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

function pageIsSecure(): boolean {
  return Platform.OS === 'web' && typeof location !== 'undefined' && location.protocol === 'https:';
}

async function probeCandidate(
  baseUrl: string,
  host: string,
  transport: ProbeTransport,
  timeoutMs: number
): Promise<ServerInfo> {
  if (pageIsSecure() && baseUrl.startsWith('http:')) throw new AppError('mixed_content');
  const response = await transport(`${baseUrl}${OPTIONS_PATH}`, timeoutMs);
  const json = parseJson(response.body);
  if (response.status === 200 && isAuthOptions(json)) {
    return {
      baseUrl,
      name: json.serverName?.trim() || host,
      options: json,
      insecure: isInsecureRemote(baseUrl),
    };
  }
  const error = errorFromResponse({ status: response.status, headers: new Headers() }, json);
  if (error.code === 'module_disabled' || error.code === 'rate_limited') throw error;
  if (response.status >= 500 && !json)
    throw new AppError('server_error', { status: response.status });
  throw new AppError('not_streamarr', {
    status: response.status,
    detail: response.body.slice(0, 200),
  });
}

/** Normalises the typed address and asks the viewer auth options of each candidate URL. */
export async function probeServer(
  input: string,
  transport: ProbeTransport = xhrTransport,
  timeoutMs = PROBE_TIMEOUT_MS
): Promise<ServerInfo> {
  const address = parseServerInput(input);
  let best: AppError | undefined;
  for (const candidate of address.candidates) {
    try {
      return await probeCandidate(candidate, address.host, transport, timeoutMs);
    } catch (error) {
      const appError = isAppError(error) ? error : new AppError('unknown', { cause: error });
      if ((RANK[appError.code] ?? 0) > (best ? (RANK[best.code] ?? 0) : -1)) best = appError;
    }
  }
  throw best ?? new AppError('network_unreachable');
}
