import { renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import { useDownloadStorage } from '@/downloads/hooks';
import { bytesOnDevice } from '@/downloads/library';
import { remainingBytes, STORAGE_RESERVE_BYTES } from '@/downloads/manager';

import {
  createTestDownloads,
  DownloadsTestProvider,
  fakeOfflineDownload,
} from '../../../jest/downloads';

/** DL-C-verify2 positive check plus C2-03: storage accounting of removing records and pending cleanups. */
it('removing records count as zero committed/library bytes without inventing reclaimed physical space', async () => {
  const test = createTestDownloads();
  const GB = 1024 ** 3;
  const removing = fakeOfflineDownload({
    id: 'removing',
    state: 'removing',
    bytesWritten: GB / 2,
    sizeBytes: GB,
  });
  test.store.put(removing);
  test.engine.controls.setStorage({ freeBytes: 2 * GB + STORAGE_RESERVE_BYTES });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <DownloadsTestProvider test={test}>{children}</DownloadsTestProvider>
  );
  const { result, unmount } = await renderHook(useDownloadStorage, { wrapper });
  try {
    await waitFor(() => expect(result.current?.availableBytes).toBe(2 * GB));
    expect(remainingBytes(removing)).toBe(0);
    expect(bytesOnDevice(removing)).toBe(0);
    expect(result.current?.freeBytes).toBe(2 * GB + STORAGE_RESERVE_BYTES);
  } finally {
    await unmount();
    test.manager.dispose();
  }
});

it('C2-03: the bytes of a pending cleanup job stay counted as used until the files are gone', async () => {
  const test = createTestDownloads();
  const GB = 1024 ** 3;
  test.store.setCleanupJobs([
    {
      id: 'gone-record',
      accountKey: 'http://dev.test#v-anna',
      volumeId: 'internal',
      paths: ['a/gone-record/Movie.mkv', 'a/gone-record'],
      bytes: GB,
      attempts: 1,
      nextAt: 0,
    },
  ]);
  test.engine.controls.setStorage({ freeBytes: 2 * GB + STORAGE_RESERVE_BYTES });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <DownloadsTestProvider test={test}>{children}</DownloadsTestProvider>
  );
  const { result, unmount } = await renderHook(useDownloadStorage, { wrapper });
  try {
    await waitFor(() => expect(result.current?.usedBytes).toBe(GB));
    expect(result.current?.availableBytes).toBe(2 * GB);
  } finally {
    await unmount();
    test.manager.dispose();
  }
});
