import {
  downloadEngine,
  nativeDownloadEngine,
  platformSupportsDownloads,
  toDownloadEngineError,
  unsupportedDownloadEngine,
} from '..';

describe('download engine entry', () => {
  it('supports iOS and Android (incl. Android TV), not web or Apple TV', () => {
    expect(platformSupportsDownloads('ios', false)).toBe(true);
    expect(platformSupportsDownloads('android', true)).toBe(true);
    expect(platformSupportsDownloads('ios', true)).toBe(false);
    expect(platformSupportsDownloads('web', false)).toBe(false);
  });

  it('falls back to the unsupported stub without the native module', async () => {
    expect(downloadEngine.isSupported).toBe(false);
    expect(downloadEngine.rootUri).toBeNull();
    await expect(downloadEngine.list()).rejects.toMatchObject({ code: 'not_supported' });
    expect(() => unsupportedDownloadEngine.uriFor('a')).toThrow('not_supported');
    expect(() => downloadEngine.addStateListener(() => {}).remove()).not.toThrow();
  });

  it('maps native rejections to engine error codes', async () => {
    expect(
      toDownloadEngineError(new Error('Call to function failed: not_found: no download x'))
    ).toMatchObject({
      code: 'not_found',
      message: 'not_found: no download x',
    });
    expect(toDownloadEngineError(new Error('boom')).code).toBe('io');
    const native = {
      rootUri: 'file:///root/',
      pause: jest.fn().mockRejectedValue(new Error('invalid_state: done')),
    };
    const engine = nativeDownloadEngine(native as never);
    await expect(engine.pause('x')).rejects.toMatchObject({ code: 'invalid_state' });
  });

  it('keeps the whole message of an unknown native error (N1-17)', () => {
    expect(toDownloadEngineError(new Error('disk unavailable'))).toMatchObject({
      code: 'io',
      message: 'io: disk unavailable',
    });
    expect(toDownloadEngineError('plain string')).toMatchObject({
      code: 'io',
      message: 'io: plain string',
    });
  });

  it('rejects headers outside the allowlist before they reach native (N1-12)', async () => {
    const native = { rootUri: 'file:///root/', start: jest.fn(), resume: jest.fn() };
    const engine = nativeDownloadEngine(native as never);
    const spec = { id: 'a', url: 'https://s/offline/cap', relativePath: 'a/b.mkv' };
    await expect(
      engine.start({ ...spec, headers: { Authorization: 'Bearer secret' } })
    ).rejects.toMatchObject({
      code: 'invalid_argument',
      message: 'invalid_argument: headers not allowed: Authorization',
    });
    await expect(
      engine.resume('a', { headers: { 'X-Capability-Key': 'k' } })
    ).rejects.toMatchObject({
      code: 'invalid_argument',
    });
    expect(native.start).not.toHaveBeenCalled();
    expect(native.resume).not.toHaveBeenCalled();
    await engine.start({ ...spec, headers: { 'Accept-Language': 'de', 'user-agent': 'x' } });
    expect(native.start).toHaveBeenCalledTimes(1);
  });
});
