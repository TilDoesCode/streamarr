import { getDeviceProfileAsync, type MediaCapsReport } from '@modules/media-caps';
import { QueryClient } from '@tanstack/react-query';
import { userEvent, within } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { Stack } from 'expo-router';
import { act, renderRouter, screen, waitFor } from 'expo-router/testing-library';
import type { ReactNode } from 'react';

import { AccountStore, type KeyValueStorage } from '@/accounts/account-store';
import { AccountsProvider } from '@/accounts/accounts-provider';
import { createMemoryVault } from '@/accounts/types';
import { ToastProvider } from '@/components/ui/toast';
import { setLanguagePreference } from '@/i18n';
import { deviceSettings } from '@/lib/storage';
import { storedCapabilityOverrides } from '@/player/capability-overrides';
import * as deviceProfile from '@/player/device-profile';
import { loadDeviceCaps } from '@/player/device-profile';
import { DesignProvider } from '@/theme';

import { appRoutes } from '../../../../jest/app-routes';

// expo-router/testing-library installs its own Reanimated mock, which lacks useReducedMotion and makeMutable.
const reanimatedMock = jest.requireMock<Record<string, unknown>>('react-native-reanimated');
reanimatedMock.useReducedMotion = () => false;
reanimatedMock.makeMutable = reanimatedMock.useSharedValue;

/** An Android TV box on a 4K HDR10 TV that reports no AC3 decoder and no bitstream output. */
const report: MediaCapsReport = {
  platform: 'androidtv',
  device: { isTV: true, isEmulator: false, manufacturer: 'Radxa', model: 'ROCK 4D' },
  videoDecoders: [
    {
      name: 'c2.rk.avc.decoder',
      codec: 'h264',
      hardware: true,
      softwareOnly: false,
      maxWidth: 3840,
      maxHeight: 2160,
      maxBitDepth: 8,
      hdrFormats: [],
    },
    {
      name: 'c2.rk.hevc.decoder',
      codec: 'hevc',
      hardware: true,
      softwareOnly: false,
      maxWidth: 3840,
      maxHeight: 2160,
      maxBitDepth: 10,
      hdrFormats: ['hdr10'],
      profiles: ['main', 'main10'],
    },
  ],
  audioDecoders: [
    {
      name: 'c2.android.aac.decoder',
      codec: 'aac',
      hardware: false,
      softwareOnly: true,
      maxChannels: 8,
    },
  ],
  display: { width: 3840, height: 2160, refreshRate: 60, hdrTypes: ['hdr10'] },
  audioOutput: { devices: [], passthrough: [], maxChannels: 2, api: 'test' },
};

// Rockchip decoders report 7680×4320; a test swaps in such a report.
let mockReport: MediaCapsReport = report;
jest.mock('@modules/media-caps/src/MediaCapsModule', () => ({
  getCapabilitiesAsync: () => Promise.resolve(mockReport),
  readCodecLogAsync: () => Promise.resolve([]),
  addListener: () => ({ remove: () => undefined }),
}));

type Handler = (url: URL, request: Request) => Response | Promise<Response>;
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const WAIT = { timeout: 5000 };

let handlers: Record<string, Handler> = {};
let store: AccountStore;

async function fakeServer(input: Request): Promise<Response> {
  const handler = handlers[new URL(input.url).pathname];
  if (handler) return handler(new URL(input.url), input);
  return json(404, { error: { code: 'not_found', message: 'nope' } });
}

function memoryStorage(): KeyValueStorage {
  const map = new Map<string, string>();
  return {
    getString: (key) => map.get(key),
    set: (key, value) => void map.set(key, value),
    remove: (key) => map.delete(key),
  };
}

function RootLayout() {
  return (
    <Providers>
      <Stack screenOptions={{ headerShown: false }} />
    </Providers>
  );
}

function Providers({ children }: { children: ReactNode }) {
  return (
    <DesignProvider>
      <ToastProvider>
        <AccountsProvider
          store={store}
          queryClient={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
          fetch={fakeServer}>
          {children}
        </AccountsProvider>
      </ToastProvider>
    </DesignProvider>
  );
}

async function openSettings() {
  const anna = await store.addSignedIn(
    { url: 'http://dev.test', name: 'Dev World' },
    { id: 'v-anna', username: 'anna', displayName: 'Anna', mustChangePassword: false },
    {
      sessionId: 's1',
      accessToken: 'sva_1',
      accessExpiresAt: Date.now() + 3_600_000,
      refreshToken: 'svr_1',
      refreshExpiresAt: Date.now() + 3_600_000,
    }
  );
  store.setActive(anna.id);
  await renderRouter({ _layout: RootLayout, ...appRoutes }, { initialUrl: '/settings' });
}

beforeEach(async () => {
  deviceSettings.remove('capabilities.overrides');
  store = new AccountStore({ storage: memoryStorage(), vault: createMemoryVault() });
  handlers = {
    '/api/v1/viewer/watch/resume': () => json(200, []),
    '/api/v1/viewer/watch/next-up': () => json(200, { items: [] }),
    '/api/v1/health': () => json(200, { version: '1.0.0' }),
    '/api/v1/viewer/me': () => json(200, { id: 'v-anna', username: 'anna', permissions: {} }),
    '/api/v1/viewer/me/sessions': () => json(200, []),
  };
  global.fetch = jest.fn(fakeServer) as unknown as typeof fetch;
  await act(async () => {
    await setLanguagePreference('en');
  });
});

describe('Device capabilities (settings)', () => {
  it('opens from Settings and shows the detected capabilities per area', async () => {
    const user = userEvent.setup();
    await openSettings();
    await user.press(await screen.findByTestId('settings-capabilities'));
    expect(await screen.findByTestId('capabilities-display', {}, WAIT)).toBeOnTheScreen();
    expect(screen.getByTestId('capabilities-display-hdr')).toHaveTextContent('HDR10');
    // No `dev.streamybox.dolby_vision` on this device.
    expect(screen.getByTestId('capabilities-dolby-vision-player')).toHaveTextContent('Unavailable');
    expect(screen.getByText('Radxa · ROCK 4D')).toBeOnTheScreen();
    const hevc = screen.getByTestId('capabilities-video-hevc');
    expect(within(hevc).getByText('up to 4K · 10-bit · HDR10 · Hardware')).toBeOnTheScreen();
    expect(within(hevc).getByText('Profiles: main, main10')).toBeOnTheScreen();
    expect(screen.getByTestId('capabilities-video-hevc-true')).toBeSelected();
    expect(screen.getByTestId('capabilities-audio-ac3-off')).toBeSelected();
    expect(screen.getByTestId('capabilities-vlc')).toBeOnTheScreen();
    expect(screen.queryByTestId('capabilities-audio-ac3-overridden')).toBeNull();
  });

  it('names the Streamybox Dolby Vision player without claiming DV in the profile', async () => {
    mockReport = { ...report, streamyboxDolbyVision: true };
    // The app measures once per run; this screen reads the report with the feature.
    const caps = await getDeviceProfileAsync({ vlc: true });
    const detected = jest.spyOn(deviceProfile, 'loadDetectedCaps').mockResolvedValue(caps);
    try {
      const user = userEvent.setup();
      await openSettings();
      await user.press(await screen.findByTestId('settings-capabilities'));
      expect(
        await screen.findByTestId('capabilities-dolby-vision-player', {}, WAIT)
      ).toHaveTextContent('Streamybox Player');
      expect(screen.getByText('Dolby Vision player')).toBeOnTheScreen();
      // Detection only: the profile still goes out without dolbyvision (the external player has no handoff yet).
      expect(caps.report.streamyboxDolbyVision).toBe(true);
      expect(
        caps.profile.engines[0]!.videoCodecs.find((codec) => codec.codec === 'hevc')!.hdrFormats
      ).toEqual(['hdr10']);
    } finally {
      mockReport = report;
      detected.mockRestore();
    }
  });

  it('explains why HDMI bitstream formats are not passed through (IEC 61937 only)', async () => {
    mockReport = {
      ...report,
      audioOutput: {
        ...report.audioOutput,
        devices: [{ type: 'hdmi', name: 'LG TV', channelCounts: [2, 6, 8], encodings: [5, 6, 14] }],
        hdmiEncodings: ['ac3', 'eac3', 'truehd'],
        directProfiles: [
          { format: 'ac3', iec61937: true, channels: 2 },
          { format: 'truehd', iec61937: true, channels: 8 },
        ],
        surroundMode: 'auto',
        tvMode: true,
      },
    };
    const caps = await getDeviceProfileAsync({ vlc: true });
    const detected = jest.spyOn(deviceProfile, 'loadDetectedCaps').mockResolvedValue(caps);
    try {
      const user = userEvent.setup();
      await openSettings();
      await user.press(await screen.findByTestId('settings-capabilities'));
      const formats = await screen.findByTestId('capabilities-hdmi-formats', {}, WAIT);
      expect(formats).toHaveTextContent('ac3, eac3, truehd');
      const refused = screen.getByTestId('capabilities-passthrough-refused');
      expect(refused).toHaveTextContent(/IEC 61937/);
      expect(
        screen.getByText('Not passed through: Dolby Digital, Dolby Digital+, TrueHD')
      ).toBeOnTheScreen();
      // Nothing the player refuses reaches the profile as a bitstream.
      expect(screen.getByTestId('capabilities-audio-truehd-off')).toBeSelected();
    } finally {
      mockReport = report;
      detected.mockRestore();
    }
  });

  it('asks once before the first override, marks it and feeds the playback profile', async () => {
    const user = userEvent.setup();
    await openSettings();
    await user.press(await screen.findByTestId('settings-capabilities'));
    await user.press(await screen.findByTestId('capabilities-audio-ac3-passthrough', {}, WAIT));
    const dialog = screen.getByTestId('capabilities-confirm');
    expect(within(dialog).getByText('Change capabilities at your own risk?')).toBeOnTheScreen();
    expect(storedCapabilityOverrides()).toEqual({});

    await user.press(within(dialog).getByRole('button', { name: 'Change' }));
    expect(storedCapabilityOverrides()).toEqual({ audio: { ac3: 'passthrough' } });
    expect(screen.getByTestId('capabilities-audio-ac3-overridden')).toBeOnTheScreen();
    expect(screen.getByText('Detected: Off')).toBeOnTheScreen();
    expect(
      (await loadDeviceCaps()).profile.engines[0]?.audioCodecs.find((c) => c.codec === 'ac3')
    ).toEqual({ codec: 'ac3', passthrough: true });

    // Further changes apply without asking again.
    await user.press(screen.getByTestId('capabilities-video-hevc-false'));
    expect(screen.queryByTestId('capabilities-confirm')).toBeNull();
    expect(storedCapabilityOverrides()).toEqual({
      audio: { ac3: 'passthrough' },
      video: { hevc: false },
    });
    expect(screen.getByText(/2 values differ from the detected ones/)).toBeOnTheScreen();

    // Picking the detected value again is no override.
    await user.press(screen.getByTestId('capabilities-video-hevc-true'));
    expect(storedCapabilityOverrides()).toEqual({ audio: { ac3: 'passthrough' } });

    await user.press(screen.getByTestId('capabilities-reset'));
    await waitFor(() => expect(storedCapabilityOverrides()).toEqual({}));
    expect(screen.queryByTestId('capabilities-audio-ac3-overridden')).toBeNull();
    expect(await screen.findByText('Detected values restored')).toBeOnTheScreen();
  });

  it('cancelling the confirmation changes nothing', async () => {
    const user = userEvent.setup();
    await openSettings();
    await user.press(await screen.findByTestId('settings-capabilities'));
    await user.press(await screen.findByTestId('capabilities-max-height-1080', {}, WAIT));
    await user.press(
      within(screen.getByTestId('capabilities-confirm')).getByRole('button', { name: 'Cancel' })
    );
    expect(storedCapabilityOverrides()).toEqual({});
    expect(screen.getByTestId('capabilities-max-height-2160')).toBeSelected();
  });

  it('stacks rows with many choices so their label keeps the full width', async () => {
    const user = userEvent.setup();
    await openSettings();
    await user.press(await screen.findByTestId('settings-capabilities'));
    const direction = (testID: string) =>
      StyleSheet.flatten(screen.getByTestId(testID).props.style).flexDirection;
    await screen.findByTestId('capabilities-bitrate', {}, WAIT);
    expect(direction('capabilities-video-hevc')).toBe('row');
    expect(direction('capabilities-bitrate')).toBe('column');
    await user.press(screen.getByTestId('capabilities-bitrate-8000'));
    await user.press(
      within(screen.getByTestId('capabilities-confirm')).getByRole('button', { name: 'Change' })
    );
    const bitrate = screen.getByTestId('capabilities-bitrate');
    expect(within(bitrate).getByText('Maximum bitrate')).toBeOnTheScreen();
    expect(within(bitrate).getByTestId('capabilities-bitrate-overridden')).toBeOnTheScreen();
  });

  it('offers 8K where the decoders reach it and keeps it as the detected value', async () => {
    const decoders = report.videoDecoders.map((decoder) => ({
      ...decoder,
      maxWidth: 7680,
      maxHeight: 4320,
    }));
    mockReport = { ...report, videoDecoders: decoders };
    // The app measures once per run; this screen reads the 8K device instead.
    const caps = await getDeviceProfileAsync({ vlc: true });
    const detected = jest.spyOn(deviceProfile, 'loadDetectedCaps').mockResolvedValue(caps);
    try {
      const user = userEvent.setup();
      await openSettings();
      await user.press(await screen.findByTestId('settings-capabilities'));
      expect(await screen.findByTestId('capabilities-max-height-4320', {}, WAIT)).toBeSelected();
      expect(screen.getByTestId('capabilities-max-height-2160')).not.toBeSelected();
      const hevc = screen.getByTestId('capabilities-video-hevc');
      expect(within(hevc).getByText('up to 8K · 10-bit · HDR10 · Hardware')).toBeOnTheScreen();

      await user.press(screen.getByTestId('capabilities-max-height-2160'));
      await user.press(
        within(screen.getByTestId('capabilities-confirm')).getByRole('button', { name: 'Change' })
      );
      expect(storedCapabilityOverrides()).toEqual({ maxHeight: 2160 });
      expect(screen.getByTestId('capabilities-max-height-2160')).toBeSelected();
      expect(screen.getByText('Detected: 8K')).toBeOnTheScreen();
    } finally {
      mockReport = report;
      detected.mockRestore();
    }
  });

  it('keeps the detected value when the chip it shows as is picked (4096×2304 decoder)', async () => {
    const decoders = report.videoDecoders.map((decoder) => ({
      ...decoder,
      maxWidth: 4096,
      maxHeight: 2304,
    }));
    mockReport = { ...report, videoDecoders: decoders };
    const caps = await getDeviceProfileAsync({ vlc: true });
    const detected = jest.spyOn(deviceProfile, 'loadDetectedCaps').mockResolvedValue(caps);
    try {
      const user = userEvent.setup();
      await openSettings();
      await user.press(await screen.findByTestId('settings-capabilities'));
      const uhd = await screen.findByTestId('capabilities-max-height-2160', {}, WAIT);
      expect(uhd).toBeSelected();
      await user.press(uhd);
      expect(screen.queryByTestId('capabilities-confirm')).toBeNull();
      expect(storedCapabilityOverrides()).toEqual({});

      await user.press(screen.getByTestId('capabilities-max-height-1080'));
      await user.press(
        within(screen.getByTestId('capabilities-confirm')).getByRole('button', { name: 'Change' })
      );
      expect(storedCapabilityOverrides()).toEqual({ maxHeight: 1080 });
      expect(screen.getByTestId('capabilities-max-height-overridden')).toBeOnTheScreen();

      // Back to the chip the detected 2304 shows as: the override is gone, not recorded as 2160.
      await user.press(screen.getByTestId('capabilities-max-height-2160'));
      expect(storedCapabilityOverrides()).toEqual({});
      expect(screen.queryByTestId('capabilities-max-height-overridden')).toBeNull();
      expect(screen.getByTestId('capabilities-max-height-2160')).toBeSelected();
    } finally {
      mockReport = report;
      detected.mockRestore();
    }
  });
});
