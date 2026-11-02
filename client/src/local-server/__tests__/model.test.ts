import { AppError } from '@/api/errors';

import {
  localBaseUrl,
  parseFailure,
  parsePort,
  qrAddress,
  readiness,
  runningPort,
  sortedAddresses,
  STARTUP_GRACE_MS,
  toLocalServerError,
} from '../model';

const lan = { kind: 'lan' as const, url: 'http://192.168.1.20:8080' };
const tailscale = { kind: 'tailscale' as const, url: 'http://100.101.102.103:8080' };
const loopback = { kind: 'loopback' as const, url: 'http://127.0.0.1:8080' };
const other = { kind: 'other' as const, url: 'http://10.8.0.2:8080' };

describe('QR address', () => {
  it('prefers LAN, then Tailscale, then other, never loopback', () => {
    expect(qrAddress([loopback, tailscale, lan])).toBe(lan);
    expect(qrAddress([loopback, other, tailscale])).toBe(tailscale);
    expect(qrAddress([loopback, other])).toBe(other);
    expect(qrAddress([loopback])).toBeUndefined();
    expect(qrAddress([])).toBeUndefined();
  });

  it('lists the QR address first and loopback last', () => {
    expect(sortedAddresses([loopback, other, tailscale, lan])).toEqual([
      lan,
      tailscale,
      other,
      loopback,
    ]);
  });
});

describe('ports', () => {
  it.each([
    ['', { problem: 'empty' }],
    ['  ', { problem: 'empty' }],
    ['80a', { problem: 'notNumber' }],
    ['-1', { problem: 'notNumber' }],
    ['1', { problem: 'range' }],
    ['1023', { problem: 'range' }],
    ['65536', { problem: 'range' }],
    ['1024', { port: 1024 }],
    [' 9000 ', { port: 9000 }],
    ['65535', { port: 65535 }],
  ])('parses %j', (input, expected) => {
    expect(parsePort(input)).toEqual(expected);
  });

  it('reads the running port from the address list', () => {
    expect(runningPort({ port: 9000, addresses: [lan, loopback] })).toBe(8080);
    expect(runningPort({ port: 9000, addresses: [] })).toBe(9000);
    expect(localBaseUrl({ port: 9000, addresses: [lan, loopback] })).toBe('http://127.0.0.1:8080');
    expect(localBaseUrl({ port: 9000, addresses: [] })).toBe('http://127.0.0.1:9000');
  });
});

describe('errors', () => {
  const native = (code: string, detail: string) =>
    Object.assign(new Error(`${code}: ${detail}`), { code });

  it('maps the native rejection codes to localized client codes, the message as detail', () => {
    expect(
      toLocalServerError(native('port_in_use', 'no free port between 8080 and 8099'))
    ).toMatchObject({
      code: 'local_server_port_in_use',
      detail: 'no free port between 8080 and 8099',
    });
    expect(toLocalServerError(native('bundle_missing', 'native host missing')).code).toBe(
      'local_server_bundle_missing'
    );
    expect(toLocalServerError(native('service_unavailable', 'x')).code).toBe(
      'local_server_service_unavailable'
    );
    expect(toLocalServerError(native('start_failed', 'x')).code).toBe('local_server_start_failed');
    expect(toLocalServerError(native('stop_failed', 'x')).code).toBe('local_server_stop_failed');
    expect(toLocalServerError(native('not_supported', 'x')).code).toBe('local_server_unavailable');
  });

  it('reads the code from the message when the error lost its property, else falls back', () => {
    expect(toLocalServerError(new Error('port_in_use: taken'))).toMatchObject({
      code: 'local_server_port_in_use',
      detail: 'taken',
    });
    expect(toLocalServerError(new Error('bind failed'))).toMatchObject({
      code: 'local_server_failed',
      detail: 'bind failed',
    });
    expect(toLocalServerError(native('surprise', 'new code')).code).toBe('local_server_failed');
    const known = new AppError('timeout');
    expect(toLocalServerError(known)).toBe(known);
  });

  it('splits a coded lastError into code and detail', () => {
    expect(parseFailure('start_failed: Cannot run program')).toEqual({
      code: 'local_server_start_failed',
      detail: 'Cannot run program',
    });
    expect(parseFailure('port_in_use:')).toEqual({ code: 'local_server_port_in_use' });
    expect(parseFailure('The server exited with code 137')).toEqual({
      detail: 'The server exited with code 137',
    });
    expect(parseFailure(undefined)).toEqual({});
  });
});

describe('readiness', () => {
  const now = 1_000_000;
  const ok = { status: 'success' as const };
  const pending = { status: 'pending' as const };
  const failed = (code: string) => ({ status: 'error' as const, error: new AppError(code) });
  const states = (input: Parameters<typeof readiness>[0]) =>
    readiness(input).checks.map((check) => [check.id, check.state, check.problem]);
  const running = { state: 'running' as const, startedAt: now - STARTUP_GRACE_MS - 1 };

  it('waits for a start', () => {
    expect(states({ status: { state: 'stopped' }, health: pending, viewer: pending, now })).toEqual(
      [
        ['running', 'todo', 'stopped'],
        ['api', 'todo', undefined],
        ['viewer', 'todo', undefined],
        ['ready', 'todo', undefined],
      ]
    );
    expect(states({ status: null, health: pending, viewer: pending, now })[0]).toEqual([
      'running',
      'todo',
      'stopped',
    ]);
  });

  it('shows a start in progress and a failed start', () => {
    expect(
      states({ status: { state: 'starting' }, health: pending, viewer: pending, now })[0]
    ).toEqual(['running', 'checking', undefined]);
    expect(
      states({ status: { state: 'failed' }, health: pending, viewer: pending, now })[0]
    ).toEqual(['running', 'failed', 'failed']);
  });

  it('checks the API, then viewer accounts, then is ready', () => {
    expect(states({ status: running, health: pending, viewer: pending, now }).slice(1, 3)).toEqual([
      ['api', 'checking', undefined],
      ['viewer', 'todo', undefined],
    ]);
    expect(states({ status: running, health: ok, viewer: pending, now }).slice(1, 3)).toEqual([
      ['api', 'done', undefined],
      ['viewer', 'checking', undefined],
    ]);
    const result = readiness({ status: running, health: ok, viewer: ok, now });
    expect(result.ready).toBe(true);
    expect(result.checks.every((check) => check.state === 'done')).toBe(true);
  });

  it('asks to turn on viewer accounts when the module is off', () => {
    const result = readiness({
      status: running,
      health: ok,
      viewer: failed('module_disabled'),
      now,
    });
    expect(result.ready).toBe(false);
    expect(result.checks[2]).toEqual({
      id: 'viewer',
      state: 'failed',
      problem: 'module_disabled',
    });
  });

  it('keeps checking right after a start, then reports an unreachable API', () => {
    const fresh = { state: 'running' as const, startedAt: now - 1000 };
    expect(
      readiness({ status: fresh, health: failed('network_unreachable'), viewer: pending, now })
        .checks[1]
    ).toEqual({ id: 'api', state: 'checking' });
    expect(
      readiness({ status: running, health: failed('network_unreachable'), viewer: pending, now })
        .checks[1]
    ).toEqual({ id: 'api', state: 'failed', problem: 'unreachable' });
    expect(
      readiness({ status: running, health: failed('not_streamarr'), viewer: pending, now })
        .checks[1]
    ).toEqual({ id: 'api', state: 'failed', problem: 'other' });
  });
});
