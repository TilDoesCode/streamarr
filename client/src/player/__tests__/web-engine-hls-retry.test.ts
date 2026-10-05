import { HLS_IMPORT_RETRY_MS, loadHls } from '@/player/engines/web-engine.web';

const mockImport = jest.fn();
jest.mock('@/player/engines/hls-import', () => ({ importHls: () => mockImport() }));

describe('hls.js chunk import (D06)', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('retries a failed chunk twice before giving up', async () => {
    mockImport.mockRejectedValue(new Error('Loading chunk failed'));
    const loading = loadHls();
    const failed = expect(loading).rejects.toThrow('Loading chunk failed');
    await jest.advanceTimersByTimeAsync(HLS_IMPORT_RETRY_MS.reduce((sum, ms) => sum + ms, 0));
    await failed;
    expect(mockImport).toHaveBeenCalledTimes(3);
  });

  it('loads when a retry succeeds', async () => {
    mockImport.mockReset();
    mockImport.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ default: {} });
    const loading = loadHls();
    await jest.advanceTimersByTimeAsync(HLS_IMPORT_RETRY_MS[0]!);
    await expect(loading).resolves.toEqual({ default: {} });
    expect(mockImport).toHaveBeenCalledTimes(2);
  });
});
