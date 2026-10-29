import { within } from '@testing-library/react-native';
import { screen, waitFor } from 'expo-router/testing-library';

import { clearWorld, open, resetWorld, WAIT } from '../../../jest/mylist-world';
import { serveUsenet, setDeviceMbps, usenetResult } from '../../../jest/streaming-path-world';

const reanimatedMock = jest.requireMock<Record<string, unknown>>('react-native-reanimated');
reanimatedMock.useReducedMotion = () => false;
reanimatedMock.makeMutable = reanimatedMock.useSharedValue;

beforeEach(resetWorld);
afterEach(clearWorld);

describe('streaming path card (Connection & diagnostics)', () => {
  it('device is the bottleneck: both legs, the badge on the slower one and what that means', async () => {
    serveUsenet(usenetResult());
    setDeviceMbps(38);
    await open('/connection');

    const verdict = await screen.findByTestId('connection-path-verdict', {}, WAIT);
    await waitFor(
      () => expect(verdict).toHaveTextContent(/^Your device is the bottleneck: ~38 Mbit\/s/),
      WAIT
    );
    expect(verdict).toHaveTextContent(
      /4K remuxes will buffer; 4K streaming versions and 1080p play smoothly\./
    );
    expect(screen.getByTestId('connection-path-usenet-value')).toHaveTextContent('300 Mbit/s');
    expect(screen.getByTestId('connection-path-usenet-detail')).toHaveTextContent(
      '3 min ago · primary provider'
    );
    expect(screen.getByTestId('connection-path-device-value')).toHaveTextContent('38 Mbit/s');
    expect(screen.getByTestId('connection-path-device-detail')).toHaveTextContent('2 days ago');
    expect(screen.getByTestId('connection-path-device-bottleneck')).toBeOnTheScreen();
    expect(screen.queryByTestId('connection-path-usenet-bottleneck')).toBeNull();
    const buttons = [
      'connection-path-all',
      'connection-path-usenet-run',
      'connection-path-device-run',
    ];
    for (const id of buttons) expect(screen.getByTestId(id)).toBeOnTheScreen();
    expect(screen.getByTestId('connection-path-all')).toHaveProp(
      'accessibilityLabel',
      'Measure everything'
    );
  });

  it('Usenet is the bottleneck, measured with the backup while streams played', async () => {
    serveUsenet(
      usenetResult({
        megabitsPerSecond: 24,
        fallbackUsed: true,
        activeStreams: 2,
        provider: { index: 2, role: 'backup', name: null, code: 'ok', error: null },
        attempts: [
          { index: 1, role: 'primary', name: null, code: 'auth_failed', error: null },
          { index: 2, role: 'backup', name: null, code: 'ok', error: null },
        ],
      })
    );
    setDeviceMbps(400, 60_000);
    await open('/connection');

    const verdict = await screen.findByTestId('connection-path-verdict', {}, WAIT);
    await waitFor(
      () => expect(verdict).toHaveTextContent(/^Usenet is the bottleneck: ~24 Mbit\/s/),
      WAIT
    );
    expect(verdict).toHaveTextContent(/4K will buffer; 1080p plays smoothly\./);
    expect(screen.getByTestId('connection-path-usenet-bottleneck')).toBeOnTheScreen();
    expect(screen.getByTestId('connection-path-note-fallback')).toHaveTextContent(
      'The primary provider failed (login rejected) – measured with the backup provider 2 instead.'
    );
    expect(screen.getByTestId('connection-path-note-streams')).toHaveTextContent(
      'Measured while 2 streams were playing – likely more without them.'
    );
    expect(screen.getByTestId('connection-path-usenet-detail')).toHaveTextContent(
      /backup provider 2$/
    );
  });

  it('without the permission: no Usenet button, an explanation, and the shared result still shows', async () => {
    serveUsenet(usenetResult({ megabitsPerSecond: 150 }), false);
    setDeviceMbps(null);
    await open('/connection');

    const note = await screen.findByTestId('connection-path-note-not-allowed', {}, WAIT);
    expect(note).toHaveTextContent(/Your admin turned off the Usenet test for your account/);
    expect(screen.queryByTestId('connection-path-usenet-run')).toBeNull();
    expect(screen.getByTestId('connection-path-all')).toHaveProp(
      'accessibilityLabel',
      'Measure device'
    );
    expect(screen.getByTestId('connection-path-usenet-value')).toHaveTextContent('150 Mbit/s');
    expect(screen.getByTestId('connection-path-device-detail')).toHaveTextContent(
      'Not measured yet'
    );
    expect(
      within(screen.getByTestId('connection-path-verdict')).getByText(
        /^Usenet → server: ~150 Mbit\/s/
      )
    ).toBeOnTheScreen();
  });

  it('a failed test names each provider and its code', async () => {
    serveUsenet(
      usenetResult({
        status: 'failed',
        code: 'no_article',
        megabitsPerSecond: null,
        fallbackUsed: true,
        attempts: [
          { index: 1, role: 'primary', name: null, code: 'timeout', error: null },
          { index: 2, role: 'backup', name: null, code: 'no_article', error: null },
        ],
      })
    );
    setDeviceMbps(50);
    await open('/connection');

    expect(await screen.findByTestId('connection-path-note-failed', {}, WAIT)).toHaveTextContent(
      'Usenet test failed: primary provider: no answer in time · backup provider 2: no test article found'
    );
    expect(screen.getByTestId('connection-path-usenet-value')).toHaveTextContent('Failed');
    expect(screen.getByTestId('connection-path-verdict')).toHaveTextContent(
      /^Server → device: ~50 Mbit\/s/
    );
  });
});
