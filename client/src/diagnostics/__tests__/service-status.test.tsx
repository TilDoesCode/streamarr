import { fireEvent, within } from '@testing-library/react-native';
import { act, screen, waitFor } from 'expo-router/testing-library';

import { AppError } from '@/api/errors';
import i18n, { setLanguagePreference } from '@/i18n';

import { clearWorld, json, open, resetWorld, WAIT, world } from '../../../jest/mylist-world';
import {
  formatClock,
  playbackOutage,
  playbackOutageMessage,
  statusView,
  type ServiceStatus,
} from '../service-status';

// expo-router/testing-library installs its own Reanimated mock, which lacks useReducedMotion and makeMutable.
const reanimatedMock = jest.requireMock<Record<string, unknown>>('react-native-reanimated');
reanimatedMock.useReducedMotion = () => false;
reanimatedMock.makeMutable = reanimatedMock.useSharedValue;

const since = '2026-10-24T12:05:00Z';
const category = (id: string, state = 'ok', affected = 0, total = 2) => ({
  id,
  state,
  since: state === 'ok' ? null : since,
  affected,
  total,
});

const ok: ServiceStatus = {
  state: 'ok',
  categories: [
    category('search'),
    category('usenet'),
    category('metadata', 'ok', 0, 1),
    category('server', 'ok', 0, 3),
  ],
  impacts: [],
  since: null,
  checkedAt: '2026-10-24T12:08:00Z',
  adminNotified: false,
};

const usenetDown = (adminNotified: boolean): ServiceStatus => ({
  state: 'down',
  categories: [
    category('search'),
    category('usenet', 'down', 2, 2),
    category('metadata', 'ok', 0, 1),
    category('server', 'ok', 0, 3),
  ],
  impacts: ['playbackUnavailable'],
  since,
  checkedAt: '2026-10-24T12:08:00Z',
  adminNotified,
});

const STATUS = '/api/v1/viewer/diagnostics/status';
const serve = (status: ServiceStatus) => (world.handlers[STATUS] = () => json(200, status));

beforeEach(resetWorld);
afterEach(clearWorld);

describe('statusView', () => {
  const view = (over: Partial<Parameters<typeof statusView>[0]>) =>
    statusView({ data: undefined, error: null, isError: false, ...over });

  it('names the most severe category first and counts the others', () => {
    const status: ServiceStatus = {
      ...usenetDown(true),
      state: 'down',
      categories: [
        category('search', 'degraded', 1, 2),
        category('usenet', 'down', 2, 2),
        category('metadata', 'ok', 0, 1),
        category('server', 'ok', 0, 3),
      ],
    };
    const result = view({ data: status });
    expect(result.kind).toBe('problem');
    if (result.kind !== 'problem') return;
    expect(result.primary).toBe('usenet');
    expect(result.broken.map((c) => c.id)).toEqual(['usenet', 'search']);
    expect(result.working.map((c) => c.id)).toEqual(['metadata', 'server']);
  });

  it('a failing status call is never an outage; only a transport failure says the server is unreachable', () => {
    expect(view({ isError: true, error: new AppError('not_found', { status: 404 }) }).kind).toBe(
      'unknown'
    );
    expect(view({ isError: true, error: new AppError('server_error', { status: 500 }) }).kind).toBe(
      'unknown'
    );
    expect(view({ isError: true, error: new AppError('network_unreachable') }).kind).toBe(
      'unreachable'
    );
    expect(view({ data: ok }).kind).toBe('ok');
  });

  it('only Usenet or the server itself explain a failed playback, not search, TMDB or slowness', () => {
    const outage = (status: ServiceStatus) => playbackOutage(view({ data: status }));
    expect(outage(ok)).toBeNull();
    expect(outage(usenetDown(false))).toEqual({
      impact: 'playbackUnavailable',
      category: 'usenet',
      state: 'down',
      adminNotified: false,
    });
    const searchDown: ServiceStatus = {
      ...usenetDown(false),
      categories: [category('search', 'down', 2, 2), category('usenet'), category('server')],
      impacts: ['searchUnavailable'],
    };
    expect(outage(searchDown)).toBeNull();
    const slowServer: ServiceStatus = {
      ...usenetDown(false),
      state: 'degraded',
      categories: [category('usenet'), category('server', 'degraded', 1, 3)],
      impacts: ['slowerThanUsual'],
    };
    expect(outage(slowServer)).toBeNull();
    const storage: ServiceStatus = { ...slowServer, impacts: ['playbackMayFail'] };
    expect(outage(storage)).toMatchObject({ category: 'server', state: 'degraded' });
  });

  it('the outage message says "not your device" and names the admin only when notified (German)', async () => {
    await i18n.changeLanguage('de');
    try {
      const t = i18n.t.bind(i18n);
      const notified = playbackOutage(view({ data: usenetDown(true) }))!;
      expect(playbackOutageMessage(t, notified)).toBe(
        'Störung beim Usenet-Anbieter. Wiedergabe funktioniert gerade nicht. ' +
          'Das liegt am Server, nicht an deinem Gerät. Der Admin wird automatisch benachrichtigt.'
      );
      const silent = playbackOutage(view({ data: usenetDown(false) }))!;
      expect(playbackOutageMessage(t, silent)).not.toMatch(/Admin/);
      expect(t('serviceStatus.playbackOutage.title')).toBe('Störung auf dem Server');
      expect(t('serviceStatus.runSpeedTest')).toBe(t('settings.connection.speed.start'));
    } finally {
      await i18n.changeLanguage('en');
    }
  });

  it('formats the time of day today and adds the date otherwise', () => {
    const now = new Date(2026, 9, 24, 15, 0);
    expect(formatClock(new Date(2026, 9, 24, 14, 5).toISOString(), 'de', now)).toBe('14:05');
    expect(formatClock(new Date(2026, 9, 23, 9, 7).toISOString(), 'de', now)).toMatch(
      /23\.10\..*09:07/
    );
  });
});

describe('service status banner', () => {
  it('stays silent on Home while everything works', async () => {
    serve(ok);
    await open('/');
    await screen.findByTestId('home-screen', {}, WAIT);
    await waitFor(() => expect(world.requests).toContain(`GET ${STATUS}`), WAIT);
    expect(screen.queryByTestId('service-status-banner')).toBeNull();
    expect(screen.queryByTestId('settings-status-dot')).toBeNull();
  });

  it('stays silent when the status call itself fails (old server, 500)', async () => {
    world.handlers[STATUS] = () => json(500, { error: { code: 'server_error', message: 'x' } });
    await open('/');
    await screen.findByTestId('home-screen', {}, WAIT);
    await waitFor(() => expect(world.requests).toContain(`GET ${STATUS}`), WAIT);
    expect(screen.queryByTestId('service-status-banner')).toBeNull();
  });

  it('says the admin is notified only when the server says so (German)', async () => {
    await act(async () => {
      await setLanguagePreference('de');
    });
    serve(usenetDown(true));
    await open('/');
    const banner = await screen.findByTestId('service-status-banner', {}, WAIT);
    expect(within(banner).getByTestId('service-status-banner-title')).toHaveTextContent(
      /^Störung beim Usenet-Anbieter · seit /
    );
    expect(within(banner).getByTestId('service-status-banner-message')).toHaveTextContent(
      'Wiedergabe funktioniert gerade nicht. Das liegt am Server, nicht an deinem Gerät. Der Admin wird automatisch benachrichtigt.'
    );
  });

  it('marks the Settings tab with a dot during an outage', async () => {
    serve(usenetDown(false));
    await open('/');
    const tab = await screen.findByTestId('nav-settings', {}, WAIT);
    expect(await within(tab).findByTestId('settings-status-dot', {}, WAIT)).toHaveAccessibleName(
      'Server problem'
    );
  });

  it('shows on Search', async () => {
    serve(usenetDown(false));
    await open('/search');
    expect(await screen.findByTestId('service-status-banner', {}, WAIT)).toBeOnTheScreen();
  });

  it('shows on My List', async () => {
    serve(usenetDown(false));
    await open('/mylist');
    await screen.findByTestId('mylist-row-new', {}, WAIT);
    expect(await screen.findByTestId('service-status-banner', {}, WAIT)).toBeOnTheScreen();
  });

  it('shows an outage on Home with since, impact and "not your device", and opens the diagnostics', async () => {
    serve(usenetDown(false));
    await open('/');
    const banner = await screen.findByTestId('service-status-banner', {}, WAIT);
    expect(within(banner).getByTestId('service-status-banner-title')).toHaveTextContent(
      /^Usenet provider outage · since /
    );
    const message = within(banner).getByTestId('service-status-banner-message');
    expect(message).toHaveTextContent(
      'Playback doesn’t work right now. It’s the server, not your device.'
    );
    expect(message).not.toHaveTextContent(/admin/);

    fireEvent.press(banner);
    expect(await screen.findByTestId('connection-screen', {}, WAIT)).toBeOnTheScreen();
  });
});
