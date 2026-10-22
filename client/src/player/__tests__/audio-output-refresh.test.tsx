import type { MediaCapsReport } from '@modules/media-caps';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import { loadDetectedCaps, remeasureAudioOutput, useCapsRefresh } from '@/player/device-profile';

const stereo: MediaCapsReport = {
  platform: 'androidtv',
  device: { isTV: true, isEmulator: false },
  videoDecoders: [],
  audioDecoders: [],
  display: { hdrTypes: [] },
  audioOutput: { devices: [], passthrough: [], maxChannels: 2, api: 'media3' },
};
// The receiver is switched on: its EDID adds the Dolby bitstreams.
const receiver: MediaCapsReport = {
  ...stereo,
  audioOutput: {
    ...stereo.audioOutput,
    passthrough: ['ac3', 'eac3', 'truehd'],
    passthroughChannels: { ac3: 6, eac3: 8, truehd: 8 },
    maxChannels: 8,
  },
};

let mockReport = stereo;
jest.mock('@modules/media-caps/src/MediaCapsModule', () => ({
  getCapabilitiesAsync: () => Promise.resolve(mockReport),
  readCodecLogAsync: () => Promise.resolve([]),
}));

describe('device caps follow the audio output (ROCK 4D, task audio)', () => {
  it('re-measures a changed output and refreshes the profile and versions queries', async () => {
    const client = new QueryClient();
    const invalidate = jest.spyOn(client, 'invalidateQueries');
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    renderHook(() => useCapsRefresh(), { wrapper });

    expect((await loadDetectedCaps()).report.audioOutput.passthrough).toEqual([]);

    // A burst without a real change (device callback on registration) refreshes nothing.
    expect(await remeasureAudioOutput()).toBe(false);
    expect(invalidate).not.toHaveBeenCalled();

    mockReport = receiver;
    expect(await remeasureAudioOutput()).toBe(true);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['device'] });
    const native = (await loadDetectedCaps()).profile.engines[0]!;
    expect(native.audioCodecs).toEqual(
      expect.arrayContaining([{ codec: 'truehd', passthrough: true }])
    );
    expect(native.maxAudioChannels).toBe(8);
  });
});
