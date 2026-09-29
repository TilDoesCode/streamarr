import { AppError } from '@/api/errors';
import type { ProbeResponse, ProbeTransport } from '@/api/http';
import { OPTIONS_PATH, probeServer } from '@/api/probe';
import {
  displayServerUrl,
  isInsecureRemote,
  isPrivateHost,
  parseServerInput,
} from '@/api/server-url';

describe('parseServerInput', () => {
  it.each([
    ['192.168.1.20:8080', ['http://192.168.1.20:8080', 'https://192.168.1.20:8080']],
    ['  10.0.2.2:39300/ ', ['http://10.0.2.2:39300', 'https://10.0.2.2:39300']],
    ['nas.local', ['http://nas.local', 'https://nas.local']],
    ['nas', ['http://nas', 'https://nas']],
    ['streamarr.example.com', ['https://streamarr.example.com', 'http://streamarr.example.com']],
    ['HTTPS://Media.Example.com/Streamarr/', ['https://media.example.com/Streamarr']],
    ['http://127.0.0.1:39300/api/v1/viewer/auth/options', ['http://127.0.0.1:39300']],
    ['https://example.com/base/api?x=1#y', ['https://example.com/base']],
    ['[::1]:39300', ['http://[::1]:39300', 'https://[::1]:39300']],
    ['http://[fd00::12]:8096', ['http://[fd00::12]:8096']],
  ])('%s → %j', (input, candidates) => {
    expect(parseServerInput(input).candidates).toEqual(candidates);
  });

  it.each([
    '',
    '   ',
    'ftp://example.com',
    'http://user:pass@example.com',
    'not a host',
    'http://',
    'example.com:99999',
    'exa mple.com',
    'http://exa_mple.com:0',
  ])('rejects %j', (input) => {
    expect(() => parseServerInput(input)).toThrow(expect.objectContaining({ code: 'invalid_url' }));
  });
});

describe('private networks', () => {
  it.each([
    ['localhost', true],
    ['127.0.0.1', true],
    ['10.0.2.2', true],
    ['172.16.0.5', true],
    ['172.31.255.1', true],
    ['172.32.0.1', false],
    ['192.168.188.58', true],
    ['169.254.10.1', true],
    ['100.96.227.66', true],
    ['100.128.0.1', false],
    ['nas.local', true],
    ['router.home.arpa', true],
    ['nas', true],
    ['::1', true],
    ['[fd12:3456::1]', true],
    ['fe80::1', true],
    ['2001:db8::1', false],
    ['8.8.8.8', false],
    ['streamarr.example.com', false],
  ])('%s → %s', (host, expected) => {
    expect(isPrivateHost(host)).toBe(expected);
  });

  it('warns only for plain http outside private networks', () => {
    expect(isInsecureRemote('http://media.example.com')).toBe(true);
    expect(isInsecureRemote('https://media.example.com')).toBe(false);
    expect(isInsecureRemote('http://192.168.1.2:8080')).toBe(false);
    expect(displayServerUrl('https://media.example.com/')).toBe('media.example.com');
    expect(displayServerUrl('http://10.0.2.2:39300')).toBe('http://10.0.2.2:39300');
  });
});

const OPTIONS = {
  serverName: 'Streamarr Dev World',
  passwordLogin: true,
  emailCodeLogin: true,
  passwordReset: true,
  twoFactor: true,
  passwordMinLength: 8,
};

type Route = ProbeResponse | Error;

function transport(routes: Record<string, Route>) {
  const calls: string[] = [];
  const fn: ProbeTransport = async (url) => {
    calls.push(url);
    const route = routes[url];
    if (!route) throw new AppError('network_unreachable');
    if (route instanceof Error) throw route;
    return route;
  };
  return { fn, calls };
}

const ok = (body: unknown, status = 200): ProbeResponse => ({
  status,
  body: typeof body === 'string' ? body : JSON.stringify(body),
  contentType: 'application/json',
});

describe('probeServer', () => {
  it('accepts a Streamarr server with the viewer module', async () => {
    const { fn, calls } = transport({ [`http://10.0.2.2:39300${OPTIONS_PATH}`]: ok(OPTIONS) });
    await expect(probeServer('10.0.2.2:39300', fn)).resolves.toEqual({
      baseUrl: 'http://10.0.2.2:39300',
      name: 'Streamarr Dev World',
      options: OPTIONS,
      insecure: false,
    });
    expect(calls).toEqual([`http://10.0.2.2:39300${OPTIONS_PATH}`]);
  });

  it('falls back from https to http for public hosts and flags the insecure result', async () => {
    const { fn, calls } = transport({
      [`http://media.example.com${OPTIONS_PATH}`]: ok({ ...OPTIONS, serverName: null }),
    });
    const info = await probeServer('media.example.com', fn);
    expect(calls).toEqual([
      `https://media.example.com${OPTIONS_PATH}`,
      `http://media.example.com${OPTIONS_PATH}`,
    ]);
    expect(info).toMatchObject({
      baseUrl: 'http://media.example.com',
      name: 'media.example.com',
      insecure: true,
    });
  });

  it('reports module_disabled', async () => {
    const { fn } = transport({
      [`http://nas:8080${OPTIONS_PATH}`]: ok(
        { error: { code: 'module_disabled', message: "The 'viewers' module is disabled." } },
        404
      ),
    });
    await expect(probeServer('nas:8080', fn)).rejects.toMatchObject({ code: 'module_disabled' });
  });

  it('reports a web page or another API as not_streamarr', async () => {
    const { fn } = transport({ [`http://nas:8080${OPTIONS_PATH}`]: ok('<!doctype html>') });
    await expect(probeServer('nas:8080', fn)).rejects.toMatchObject({ code: 'not_streamarr' });
    const { fn: jsonFn } = transport({ [`http://nas:8080${OPTIONS_PATH}`]: ok({ Version: 10 }) });
    await expect(probeServer('nas:8080', jsonFn)).rejects.toMatchObject({ code: 'not_streamarr' });
  });

  it('keeps the most specific failure across candidates', async () => {
    const { fn } = transport({
      [`https://media.example.com${OPTIONS_PATH}`]: new AppError('tls_error'),
    });
    await expect(probeServer('media.example.com', fn)).rejects.toMatchObject({ code: 'tls_error' });
    const { fn: down, calls } = transport({});
    await expect(probeServer('192.168.1.9:1', down)).rejects.toMatchObject({
      code: 'network_unreachable',
    });
    expect(calls).toHaveLength(2);
  });

  it('rejects an invalid address before any request', async () => {
    const { fn, calls } = transport({});
    await expect(probeServer('ftp://nas', fn)).rejects.toMatchObject({ code: 'invalid_url' });
    expect(calls).toEqual([]);
  });
});
