import { QueryClient } from '@tanstack/react-query';
import { userEvent } from '@testing-library/react-native';
import { Stack } from 'expo-router';
import { act, renderRouter, screen, waitFor } from 'expo-router/testing-library';
import type { TFunction } from 'i18next';
import type { ReactNode } from 'react';

import { AccountStore, type KeyValueStorage } from '@/accounts/account-store';
import { AccountsProvider } from '@/accounts/accounts-provider';
import { createMemoryVault } from '@/accounts/types';
import { ToastProvider } from '@/components/ui/toast';
import i18n, { setLanguagePreference } from '@/i18n';
import { accountKey } from '@/query/keys';
import { DesignProvider } from '@/theme';

import { appRoutes } from '../../../../jest/app-routes';
import {
  currentRankingLabel,
  profileSummary,
  type RankingProfileOption,
  type RankingProfileState,
} from '../ranking-profile';

const reanimatedMock = jest.requireMock<Record<string, unknown>>('react-native-reanimated');
reanimatedMock.useReducedMotion = () => false;
reanimatedMock.makeMutable = reanimatedMock.useSharedValue;

type Handler = (url: URL, request: Request) => Response | Promise<Response>;
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const WAIT = { timeout: 5000 };

const standard: RankingProfileOption = {
  id: 'default',
  name: 'Standard',
  mediaTypes: ['movie', 'series'],
  traits: {
    preferredResolution: '1080p',
    maxResolution: '2160p',
    languages: ['en'],
    savesBandwidth: false,
  },
  serverDefault: true,
};
const saver: RankingProfileOption = {
  id: 'saver',
  name: 'Spart Bandbreite',
  description: 'Für unterwegs',
  mediaTypes: ['movie', 'series'],
  traits: {
    preferredResolution: '720p',
    maxResolution: '1080p',
    languages: [],
    savesBandwidth: true,
  },
  serverDefault: false,
};
const server = (name = 'Standard', id = 'default') => ({ id, name, source: 'server' });

function state(choice: RankingProfileOption | null, canChoose = true): RankingProfileState {
  const ref = choice ? { id: choice.id, name: choice.name, source: 'viewer' } : server();
  return {
    profileId: choice?.id ?? null,
    canChoose,
    movie: ref,
    series: ref,
    serverDefault: { movie: server(), series: server() },
    profiles: [standard, saver],
  };
}

let handlers: Record<string, Handler> = {};
let store: AccountStore;
let queryClient: QueryClient;
let current: RankingProfileState;
let puts: unknown[];

async function fakeServer(input: Request): Promise<Response> {
  const url = new URL(input.url);
  const handler = handlers[url.pathname];
  if (handler) return handler(url, input);
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

function Providers({ children }: { children: ReactNode }) {
  return (
    <DesignProvider>
      <ToastProvider>
        <AccountsProvider store={store} queryClient={queryClient} fetch={fakeServer}>
          {children}
        </AccountsProvider>
      </ToastProvider>
    </DesignProvider>
  );
}

function RootLayout() {
  return (
    <Providers>
      <Stack screenOptions={{ headerShown: false }} />
    </Providers>
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
  return anna.id;
}

beforeEach(async () => {
  store = new AccountStore({ storage: memoryStorage(), vault: createMemoryVault() });
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  current = state(null);
  puts = [];
  handlers = {
    '/api/v1/viewer/watch/resume': () => json(200, []),
    '/api/v1/viewer/watch/next-up': () => json(200, { items: [] }),
    '/api/v1/health': () => json(200, { version: '1.0.0' }),
    '/api/v1/viewer/me': () =>
      json(200, { id: 'v-anna', username: 'anna', displayName: 'Anna', permissions: {} }),
    '/api/v1/viewer/me/sessions': () => json(200, []),
    '/api/v1/viewer/me/ranking-profile': async (_url, request) => {
      if (request.method === 'PUT') {
        const body = (await request.json()) as { profileId: string | null };
        puts.push(body);
        if (!current.canChoose)
          return json(403, { error: { code: 'profile_choice_disabled', message: 'no' } });
        current = state(body.profileId === 'saver' ? saver : null);
      }
      return json(200, current);
    },
  };
  global.fetch = jest.fn(fakeServer) as unknown as typeof fetch;
  await act(async () => {
    await setLanguagePreference('de');
  });
});

describe('Settings ranking profile', () => {
  it('shows the server default, picks a profile and re-ranks the versions at once', async () => {
    const accountId = await openSettings();
    const versions = accountKey(
      accountId,
      'catalog',
      'versions',
      'tmdb-movie-1',
      null,
      'de',
      null,
      null
    );
    const season = accountKey(accountId, 'catalog', 'series', 1, 'season', 1, 'availability', 'de');
    queryClient.setQueryData(versions, { versions: [] });
    queryClient.setQueryData(season, { episodes: [] });

    expect(
      await screen.findByText('Aktiv: Serverstandard (Standard)', undefined, WAIT)
    ).toBeOnTheScreen();
    const user = userEvent.setup();
    await user.press(screen.getByTestId('ranking-profile-choose'));
    expect(await screen.findByText('Folgt dem Server: Standard')).toBeOnTheScreen();
    expect(
      screen.getByText('Für unterwegs · Bevorzugt 720p · Spart Bandbreite (kein 4K)')
    ).toBeOnTheScreen();
    await user.press(screen.getByText('Spart Bandbreite'));

    await waitFor(() => expect(puts).toEqual([{ profileId: 'saver' }]), WAIT);
    expect(await screen.findByText('Aktiv: Spart Bandbreite', undefined, WAIT)).toBeOnTheScreen();
    expect(queryClient.getQueryState(versions)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(season)?.isInvalidated).toBe(true);
  });

  it('is read-only when the operator decides for everyone', async () => {
    current = state(null, false);
    await openSettings();
    expect(await screen.findByTestId('ranking-profile-locked', undefined, WAIT)).toHaveTextContent(
      'Vom Serverbetreiber für alle festgelegt.'
    );
    expect(screen.queryByTestId('ranking-profile-choose')).toBeNull();
    expect(puts).toEqual([]);
  });
});

describe('ranking profile texts', () => {
  const t = i18n.t.bind(i18n) as unknown as TFunction;

  it('describes traits in the app language', () => {
    expect(
      profileSummary(
        {
          ...standard,
          name: '4K HDR',
          mediaTypes: ['series'],
          traits: {
            preferredResolution: '2160p',
            hdr: 'prefer',
            codec: 'hevc',
            languages: ['de', 'en'],
            savesBandwidth: false,
          },
        },
        t,
        'de'
      )
    ).toBe(
      'Bevorzugt 4K · Bevorzugt HDR · Effizienter Codec (HEVC) · Ton: Deutsch, Englisch · Nur Serien'
    );
  });

  it('names both media types when they rank differently', () => {
    const split = {
      ...state(null),
      movie: server(),
      series: { id: 'shows', name: 'Serien 4K', source: 'viewer' },
    };
    expect(currentRankingLabel(split, t)).toBe(
      'Filme: Serverstandard (Standard) · Serien: Serien 4K'
    );
  });
});
