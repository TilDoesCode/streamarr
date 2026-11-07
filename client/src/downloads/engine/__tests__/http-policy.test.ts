import corpus from '@modules/offline-downloads/test-vectors/http-policy.json';

import { createHash } from 'node:crypto';

import {
  backoffMs,
  decideRetry,
  diagnosticLine,
  DIAGNOSTIC_READ_BYTES,
  disallowedHeaders,
  httpStatusAction,
  MAX_ATTEMPTS,
  MAX_BACKOFF_MS,
  MAX_RETRY_AFTER_MS,
  MAX_SERVER_WAIT_MS,
  MIN_RETRY_MS,
  parseRetryAfter,
  PROGRESS_RESETS_ATTEMPTS_BYTES,
  RESERVE_BYTES,
  restoreWait,
  type RetryState,
} from '../http-policy';

type Step = {
  at: number;
  status?: number;
  retryAfter?: string;
  network?: boolean;
  invalid206?: boolean;
  progressBytes: number;
  expect: { action: string; attempts: number; retryAt: number | null; waitingSince: number | null };
};

// The same corpus runs in HttpPolicyTest.kt (JUnit) and Tests/HttpPolicyCheck.swift.
describe('download engine HTTP policy (shared corpus)', () => {
  it('uses the shared constants', () => {
    expect({
      maxAttempts: MAX_ATTEMPTS,
      minRetryMs: MIN_RETRY_MS,
      maxBackoffMs: MAX_BACKOFF_MS,
      maxRetryAfterMs: MAX_RETRY_AFTER_MS,
      maxServerWaitMs: MAX_SERVER_WAIT_MS,
      progressResetsAttemptsBytes: PROGRESS_RESETS_ATTEMPTS_BYTES,
      reserveBytes: RESERVE_BYTES,
    }).toEqual(corpus.constants);
  });

  it.each(corpus.status.retry)('%i retries natively', (status) => {
    expect(httpStatusAction(status)).toBe('retry');
  });

  it.each(corpus.status.fail)('%i fails at once', (status) => {
    expect(httpStatusAction(status)).toBe('fail');
  });

  it('classifies every status 100–599', () => {
    for (let status = 100; status <= 599; status += 1) {
      const retry = [408, 425, 429].includes(status) || status >= 500;
      expect(httpStatusAction(status)).toBe(retry ? 'retry' : 'fail');
    }
  });

  it.each(corpus.retryAfter.cases.map((item) => [JSON.stringify(item.header), item]))(
    'Retry-After %s',
    (_label, item) => {
      expect(parseRetryAfter(item.header, corpus.retryAfter.now)).toBe(item.ms);
    }
  );

  it.each(corpus.backoff.map((item) => [item.attempts, item.ms]))(
    'backoff after %i attempts is %i ms',
    (attempts, ms) => {
      expect(backoffMs(attempts)).toBe(ms);
    }
  );

  it.each(corpus.retrySequences.map((sequence) => [sequence.name, sequence]))(
    '%s',
    (_name, sequence) => {
      let state: RetryState = sequence.start;
      for (const step of sequence.steps as Step[]) {
        const retryable = step.status === undefined || httpStatusAction(step.status) === 'retry';
        const decision = decideRetry(state, {
          now: step.at,
          retryable,
          retryAfterMs: retryable ? parseRetryAfter(step.retryAfter, step.at) : null,
          progressBytes: step.progressBytes,
        });
        expect({ at: step.at, ...decision }).toEqual({
          at: step.at,
          action: step.expect.action,
          attempts: step.expect.attempts,
          retryAt: step.expect.retryAt,
          waitingSince: step.expect.waitingSince,
        });
        state = decision;
      }
    }
  );

  it.each(corpus.waitRestore.map((item) => [item.name, item]))(
    'restores a wait: %s',
    (_name, item) => {
      expect(restoreWait(item.wait, item.change)).toEqual(item.expect);
    }
  );

  it('allows only Accept-Language and User-Agent as request headers', () => {
    expect(disallowedHeaders(undefined)).toEqual([]);
    expect(disallowedHeaders({ 'accept-language': 'de', 'User-Agent': 'x' })).toEqual([]);
    expect(disallowedHeaders({ Authorization: 'Bearer x', 'X-Capability-Key': 'y' })).toEqual([
      'Authorization',
      'X-Capability-Key',
    ]);
  });

  it.each(corpus.diagnostics.map((item) => [item.name, item]))('diagnostics: %s', (_name, item) => {
    const body = new Uint8Array(Buffer.from(item.body, 'utf8'));
    expect(
      diagnosticLine(item.status, item.contentType, item.length, body, item.cut, item.requestUrls)
    ).toBe(item.expect);
  });

  it('redaction fuzz: no capability window survives and every line matches the corpus digest (N4-01)', () => {
    const spec = corpus.redactionFuzz;
    let x = spec.seed >>> 0;
    const next = () => {
      x = (x ^ (x << 13)) >>> 0;
      x = (x ^ (x >>> 17)) >>> 0;
      x = (x ^ (x << 5)) >>> 0;
      return x;
    };
    const int = (n: number) => next() % n;
    const pick = <T>(list: readonly T[]) => list[int(list.length)];
    const lines: string[] = [];
    let leaks = 0;
    for (let index = 0; index < spec.cases; index++) {
      const cap = Array.from({ length: 64 }, () => spec.hex[int(16)]).join('');
      const host = pick(spec.hosts);
      const q = int(4);
      const query =
        q === 0 ? '' : `?${Array.from({ length: q }, () => pick([...spec.queryChars])).join('')}`;
      const prefix = pick(spec.prefixes);
      const scheme = int(2) === 0 ? 'https' : 'http';
      const path = `/api/v1/offline/${cap}`;
      const url = `${scheme}://${host}${prefix}${path}${query}`;
      const values: Record<string, string> = {
        path,
        query,
        url,
        cap,
        CAP: cap.toUpperCase(),
        filler: 'x'.repeat(int(300)),
      };
      const fill = (template: string) =>
        ['path', 'query', 'url', 'cap', 'CAP', 'filler'].reduce(
          (text, key) => text.split(`{${key}}`).join(values[key]),
          template
        );
      const target = pick(spec.targets);
      const parts: Buffer[] = [];
      let size = 0;
      while (size < target) {
        for (const text of [fill(pick(spec.pieces)), pick(spec.delimiters)]) {
          const bytes = Buffer.from(text, 'utf8');
          parts.push(bytes);
          size += bytes.length;
        }
      }
      if (int(8) === 0) {
        parts.push(Buffer.from([0xff, 0xfe, 0x80]));
        size += 3;
      }
      const all = Buffer.concat(parts);
      const cut = all.length > spec.readBytes;
      const head = new Uint8Array(all.subarray(0, spec.readBytes));
      const type = pick(spec.contentTypes);
      const length = int(2) === 0 ? all.length : -1;
      const urls = int(2) === 0 ? [url, fill(spec.redirect)] : [url];
      const line = diagnosticLine(
        spec.status,
        type === null ? null : fill(type),
        length,
        head,
        cut,
        urls
      );
      const lower = line.toLowerCase();
      if (
        Array.from({ length: 53 }, (_, at) => cap.slice(at, at + 12)).some((window) =>
          lower.includes(window)
        )
      ) {
        leaks += 1;
      }
      lines.push(line);
    }
    expect(spec.readBytes).toBe(DIAGNOSTIC_READ_BYTES);
    expect(leaks).toBe(0);
    expect(createHash('sha256').update(lines.join('\n'), 'utf8').digest('hex')).toBe(spec.digest);
  });
});
