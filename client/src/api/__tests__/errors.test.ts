import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { CODE_CATEGORY, ERROR_CATEGORIES } from '@/api/error-categories';
import { CLIENT_ERROR_CODES, isKnownErrorCode, VIEWER_ERROR_CODES } from '@/api/error-codes';
import { describeError } from '@/api/error-text';
import {
  AppError,
  errorFromResponse,
  errorFromTransport,
  isAppError,
  toAppError,
} from '@/api/errors';
import i18n from '@/i18n';

const DOCS = join(__dirname, '../../../../docs');

function headers(values: Record<string, string> = {}) {
  return new Headers(values);
}

describe('errorFromResponse', () => {
  it('reads the error envelope with params and Retry-After', () => {
    const error = errorFromResponse(
      { status: 403, headers: headers({ 'Retry-After': '3' }) },
      {
        error: {
          code: 'age_restricted',
          message: 'Too old for you',
          params: { reason: 'above_age_limit', rating: 'R', ignored: 5 },
        },
      }
    );
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({
      code: 'age_restricted',
      status: 403,
      params: { reason: 'above_age_limit', rating: 'R' },
      detail: 'Too old for you',
      retryAfter: 3,
      isTransient: false,
    });
  });

  it.each([
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [404, 'not_found'],
    [429, 'rate_limited'],
    [502, 'server_error'],
    [418, 'unknown'],
  ])('maps a %i without envelope to %s', (status, code) => {
    const error = errorFromResponse({ status, headers: headers() }, '<html>proxy</html>');
    expect(error.code).toBe(code);
    expect(error.detail).toBe('<html>proxy</html>');
  });

  it('marks 5xx and 429 as transient', () => {
    expect(errorFromResponse({ status: 503, headers: headers() }, {}).isTransient).toBe(true);
    expect(errorFromResponse({ status: 429, headers: headers() }, {}).isTransient).toBe(true);
    expect(errorFromResponse({ status: 400, headers: headers() }, {}).isTransient).toBe(false);
  });
});

describe('errorFromTransport', () => {
  it.each([
    [
      'java.security.cert.CertPathValidatorException: Trust anchor for certification path not found.',
      'tls_error',
    ],
    ['javax.net.ssl.SSLHandshakeException: Handshake failed', 'tls_error'],
    [
      'An SSL error has occurred and a secure connection to the server cannot be made.',
      'tls_error',
    ],
    ['The certificate for this server is invalid.', 'tls_error'],
    ['net::ERR_CERT_AUTHORITY_INVALID', 'tls_error'],
    ['Failed to connect to /10.0.2.2:1', 'network_unreachable'],
    ['Network request failed', 'network_unreachable'],
    ['Network request timed out', 'timeout'],
  ])('classifies "%s" as %s', (message, code) => {
    const error = errorFromTransport(new TypeError(message));
    expect(error.code).toBe(code);
    expect(error.status).toBe(0);
    expect(error.isTransient).toBe(true);
  });

  it('prefers the timeout flag and recognises aborts', () => {
    expect(errorFromTransport(new Error('AbortError'), true).code).toBe('timeout');
    const abort = new Error('The operation was aborted');
    abort.name = 'AbortError';
    expect(errorFromTransport(abort).code).toBe('aborted');
  });

  it('toAppError keeps AppErrors and wraps everything else', () => {
    const original = new AppError('invalid_code', { status: 401 });
    expect(toAppError(original)).toBe(original);
    expect(toAppError(new TypeError('Failed to fetch')).code).toBe('network_unreachable');
    expect(toAppError('boom').code).toBe('unknown');
    expect(isAppError(toAppError(null))).toBe(true);
  });
});

describe('localized error text', () => {
  const codes = [...CLIENT_ERROR_CODES, ...VIEWER_ERROR_CODES];

  afterAll(async () => {
    await i18n.changeLanguage('en');
  });

  it.each(['en', 'de'])('every known code has its own title and message in %s', async (lng) => {
    await i18n.changeLanguage(lng);
    const generic = describeError(i18n.t, { code: 'unknown' });
    for (const code of codes) {
      const text = describeError(i18n.t, { code });
      expect(text.title).not.toMatch(/errors\.codes/);
      expect(text.message).not.toMatch(/errors\.codes/);
      expect(text.title.length).toBeGreaterThan(3);
      if (code !== 'unknown') expect(text).not.toEqual(generic);
    }
  });

  it('unknown codes get their category text, never the generic one (F10 S1, matrix B12)', async () => {
    await i18n.changeLanguage('en');
    const generic = describeError(i18n.t, { code: 'unknown' });
    const category = (key: string) => ({
      title: i18n.t(`errors.categories.${key}.title` as 'errors.categories.T1.title'),
      message: i18n.t(`errors.categories.${key}.message` as 'errors.categories.T1.message'),
    });
    expect(describeError(i18n.t, { code: 'brand_new_code', status: 503 })).toEqual(category('T4'));
    expect(describeError(i18n.t, { code: 'brand_new_code' })).toEqual(category('T11'));
    for (const lng of ['en', 'de']) {
      await i18n.changeLanguage(lng);
      for (const key of ERROR_CATEGORIES) {
        expect(category(key).title).not.toMatch(/errors\./);
        expect(category(key)).not.toEqual(describeError(i18n.t, { code: 'unknown' }));
      }
    }
    await i18n.changeLanguage('en');
    expect(generic.title).toBe('Something went wrong');
  });

  it('uses the age gate reason and the device of a concurrent stream', async () => {
    await i18n.changeLanguage('en');
    const reasons = ['above_age_limit', 'unrated_blocked', 'rating_unavailable', undefined].map(
      (reason) =>
        describeError(i18n.t, {
          code: 'age_restricted',
          params: reason ? { reason } : undefined,
        }).message
    );
    expect(new Set(reasons).size).toBe(4);
    expect(
      describeError(i18n.t, { code: 'too_many_streams', params: { device: 'Living room TV' } })
        .message
    ).toContain('Living room TV');
    await i18n.changeLanguage('de');
    expect(
      describeError(i18n.t, { code: 'age_restricted', params: { reason: 'unrated_blocked' } })
        .message
    ).toBe('Dieses Profil darf nur Titel mit bekannter Altersfreigabe sehen.');
  });
});

describe('documented viewer error codes', () => {
  // Every "`NNN code`" of the viewer sections and every failed-playback code in the docs has text.
  function documentedCodes(): string[] {
    const api = readFileSync(join(DOCS, 'api.md'), 'utf8');
    const viewerApi = api.slice(api.indexOf('## 12.'), api.indexOf('## See also'));
    const viewers = readFileSync(join(DOCS, 'viewers.md'), 'utf8');
    const http = [...`${viewerApi}\n${viewers}`.matchAll(/`\d{3} ([a-z_]+)`/g)].map(
      (match) => match[1]!
    );
    const failed = viewerApi.slice(
      viewerApi.indexOf('**Failed.**'),
      viewerApi.indexOf('HTTP errors')
    );
    const table = failed
      .split('\n')
      .filter(
        (line) => line.startsWith('| `') || line.startsWith('| a ') || /^\| `?[a-z]/.test(line)
      )
      .map((line) => line.split('|')[1] ?? '');
    const failures = table.flatMap((cell) => [...cell.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]!));
    return [...new Set([...http, ...failures])];
  }

  it('finds the documented codes', () => {
    const codes = documentedCodes();
    expect(codes).toEqual(
      expect.arrayContaining(['invalid_credentials', 'refresh_token_reused', 'release_dead'])
    );
    expect(codes.length).toBeGreaterThan(30);
  });

  it('every documented code is known and translated', () => {
    const missing = documentedCodes().filter((code) => !isKnownErrorCode(code));
    expect(missing).toEqual([]);
  });
});

describe('documented media delivery codes (F10 S1 drift test)', () => {
  // docs/api.md §5 (stream) and §11 (transcoding): "`NNN code` / `code` / …" chains and the 422 planning list.
  function mediaCodes(): string[] {
    const api = readFileSync(join(DOCS, 'api.md'), 'utf8');
    const section = (from: string, to: string) => api.slice(api.indexOf(from), api.indexOf(to));
    const text = `${section('## 5.', '## 6.')}\n${section('## 11.', '## 12.')}`;
    const chains = [...text.matchAll(/`\d{3} [a-z_]+`(?:\s*\/\s*`[a-z_]+`)*/g)].flatMap((chain) =>
      [...chain[0].matchAll(/`(?:\d{3} )?([a-z_]+)`/g)].map((match) => match[1]!)
    );
    const planning = /`422` planning errors \(([^)]*)\)/.exec(text)?.[1] ?? '';
    return [...new Set([...chains, ...[...planning.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]!)])];
  }

  it('finds the documented codes', () => {
    expect(mediaCodes()).toEqual(
      expect.arrayContaining([
        'unknown_stream',
        'unknown_transcode',
        'end_of_stream',
        'no_video_stream',
      ])
    );
  });

  it('every documented media code is known, translated and has a category', () => {
    const codes = mediaCodes();
    expect(codes.filter((code) => !isKnownErrorCode(code))).toEqual([]);
    for (const code of codes)
      expect(CODE_CATEGORY[code as keyof typeof CODE_CATEGORY]).toBeDefined();
  });
});
