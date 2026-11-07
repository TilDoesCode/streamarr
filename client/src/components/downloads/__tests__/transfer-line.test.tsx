import { act, renderHook } from '@testing-library/react-native';

import i18n from '@/i18n';
import { useFormat } from '@/i18n/format';

import { fakeOfflineDownload } from '../../../../jest/downloads';
import { transferLine } from '../downloads-library';

const MB = 1_000_000;

async function line(language: 'en' | 'de', speed: number) {
  await act(async () => {
    await i18n.changeLanguage(language);
  });
  const { result } = await renderHook(() => useFormat());
  const download = fakeOfflineDownload({
    state: 'downloading',
    bytesWritten: 3 * MB,
    sizeBytes: 12 * MB,
  });
  return transferLine(i18n.t, result.current, download, speed);
}

describe('downloads library transfer line', () => {
  it('shows a slow transfer in kilobytes, never as 0.0 MB/s', async () => {
    expect(await line('en', 37_923)).toBe('Downloading · 3 MB of 12 MB · 38 KB/s');
    expect(await line('de', 400)).toMatch(/· 1 KB\/s$/);
  });

  it('keeps megabytes from 1 MB/s on', async () => {
    expect(await line('en', 2.4 * MB)).toBe('Downloading · 3 MB of 12 MB · 2 MB/s');
  });
});
