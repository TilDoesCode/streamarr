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
});
