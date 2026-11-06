import { AppError } from '@/api/errors';

import {
  ConnectivityMonitor,
  createHealthProbe,
  PROBE_BACKOFF_MS,
  type NetworkState,
} from '../monitor';

function setup(reachable: () => boolean) {
  let emit: (state: NetworkState) => void = () => undefined;
  const probe = jest.fn(async () => reachable());
  const monitor = new ConnectivityMonitor({
    probe,
    network: {
      subscribe: (listener) => {
        emit = listener;
        return () => undefined;
      },
      fetch: async () => ({ isConnected: true, type: 'wifi' }),
    },
  });
  return { monitor, probe, network: (state: NetworkState) => emit(state) };
}

const flush = () => jest.advanceTimersByTimeAsync(0);

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe('connectivity monitor', () => {
  it('probes the server at once and goes offline when it does not answer', async () => {
    let up = false;
    const { monitor, probe } = setup(() => up);
    monitor.start();
    monitor.setServer('http://dev.test');
    await flush();
    expect(probe).toHaveBeenCalledWith('http://dev.test');
    expect(monitor.getSnapshot().state).toBe('offline_server_unreachable');
    up = true;
    await jest.advanceTimersByTimeAsync(PROBE_BACKOFF_MS[0]);
    expect(monitor.getSnapshot().state).toBe('online');
    monitor.stop();
  });

  it('backs off between probes while offline (5 s, 10 s, 20 s, 30 s)', async () => {
    const { monitor, probe } = setup(() => false);
    monitor.start();
    monitor.setServer('http://dev.test');
    await flush();
    for (const delay of PROBE_BACKOFF_MS) {
      const before = probe.mock.calls.length;
      await jest.advanceTimersByTimeAsync(delay - 1);
      expect(probe.mock.calls.length).toBe(before);
      await jest.advanceTimersByTimeAsync(1);
      expect(probe.mock.calls.length).toBe(before + 1);
    }
    monitor.stop();
  });

  it('tells no network apart from a server that does not answer', async () => {
    let up = true;
    const { monitor, network } = setup(() => up);
    monitor.start();
    monitor.setServer('http://dev.test');
    await flush();
    up = false;
    network({ isConnected: false });
    expect(monitor.getSnapshot().state).toBe('offline_no_network');
    up = true;
    network({ isConnected: true });
    await flush();
    expect(monitor.getSnapshot().state).toBe('online');
    monitor.stop();
  });

  it('probes after two transport failures of requests, not after other errors', async () => {
    let up = true;
    const { monitor, probe } = setup(() => up);
    monitor.start();
    monitor.setServer('http://dev.test');
    await flush();
    probe.mockClear();
    up = false;
    monitor.reportFailure(new AppError('not_found', { status: 404 }));
    monitor.reportFailure(new AppError('timeout'));
    expect(probe).not.toHaveBeenCalled();
    monitor.reportFailure(new AppError('network_unreachable'));
    await flush();
    expect(probe).toHaveBeenCalledTimes(1);
    expect(monitor.getSnapshot().state).toBe('offline_server_unreachable');
    monitor.stop();
  });

  it('retry probes now; without a server it is always online', async () => {
    let up = false;
    const { monitor } = setup(() => up);
    monitor.start();
    monitor.setServer('http://dev.test');
    await flush();
    up = true;
    await monitor.retry();
    expect(monitor.getSnapshot().state).toBe('online');
    up = false;
    monitor.setServer(null);
    expect(monitor.getSnapshot().state).toBe('online');
    monitor.stop();
  });

  it('health probe: any answer below 500 is reachable, 5xx and transport errors are not', async () => {
    const answers = [200, 404, 503];
    const fetch = jest.fn(async () => new Response('{}', { status: answers.shift() }));
    const probe = createHealthProbe(fetch);
    await expect(probe('http://dev.test')).resolves.toBe(true);
    await expect(probe('http://dev.test')).resolves.toBe(true);
    await expect(probe('http://dev.test')).resolves.toBe(false);
    const failing = createHealthProbe(async () => {
      throw new TypeError('Network request failed');
    });
    await expect(failing('http://dev.test')).resolves.toBe(false);
    expect((fetch.mock.calls[0] as unknown as [Request])[0].url).toBe(
      'http://dev.test/api/v1/health'
    );
  });
});
