import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import {
  createTestDownloads,
  DownloadsTestProvider,
  fakeOfflineDownload,
} from '../../../jest/downloads';
import { useDownloadSpace } from '../candidates';
import { useDownloadStorage } from '../hooks';
import { STORAGE_RESERVE_BYTES } from '../manager';

const GB = 1024 ** 3;

function render<T>(hook: () => T, test = createTestDownloads()) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <DownloadsTestProvider test={test}>{children}</DownloadsTestProvider>
  );
  return { test, rendered: renderHook(hook, { wrapper }) };
}

describe('download storage', () => {
  it('C1-07: bytes a running download writes are not counted twice before the next sample', async () => {
    const test = createTestDownloads();
    test.engine.controls.setStorage({ freeBytes: 3 * GB + STORAGE_RESERVE_BYTES });
    test.store.put(
      fakeOfflineDownload({ id: 'running', state: 'downloading', sizeBytes: GB, bytesWritten: 0 })
    );
    const { rendered } = render(useDownloadStorage, test);
    const { result, unmount } = await rendered;
    await waitFor(() => expect(result.current?.availableBytes).toBe(2 * GB));
    await act(() => {
      test.engine.controls.setStorage({ freeBytes: 2.5 * GB + STORAGE_RESERVE_BYTES });
      test.store.update('running', { bytesWritten: GB / 2 });
    });
    expect(result.current!.availableBytes).toBe(2 * GB);
    expect(result.current!.freeBytes).toBe(2.5 * GB + STORAGE_RESERVE_BYTES);
    await unmount();
  });

  it('C1-07: unknown free space never reads as "fits"', async () => {
    const test = createTestDownloads();
    jest.spyOn(test.engine, 'storage').mockImplementation(() => new Promise(() => undefined));
    const { rendered } = render(useDownloadSpace, test);
    const { result, unmount } = await rendered;
    expect(result.current.availableBytes).toBeNull();
    expect(result.current.verdict(100)).toMatchObject({ fits: false, unknown: true });
    await unmount();
  });
});
