import { AppState } from 'react-native';

import { harness } from '@/../jest/player/harness';
import { fakeNetwork, playing } from '@/../jest/player/play';

jest.mock('@/player/engines', () => jest.requireActual('@/../jest/player/harness').enginesModule());

beforeEach(() => harness.reset());
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('the offline re-check sleeps in the background (S4q R8)', () => {
  it('no network reads while the app is in the background; one read at once on return, then the timer again', async () => {
    jest.useFakeTimers();
    const handlers: ((state: string) => void)[] = [];
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, handler) => {
      handlers.push(handler as (state: string) => void);
      return { remove: () => undefined };
    });
    let reachable = false;
    const network = Object.assign(fakeNetwork(), { refresh: jest.fn(async () => reachable) });
    const c = await playing({ network }, {}, 30);
    network.set(false);
    await jest.advanceTimersByTimeAsync(6_000);
    expect(network.refresh).toHaveBeenCalledTimes(2);
    handlers.forEach((handler) => handler('background'));
    await jest.advanceTimersByTimeAsync(60_000);
    expect(network.refresh).toHaveBeenCalledTimes(2);
    // Back in the foreground: the network is read at once (it came back meanwhile).
    reachable = true;
    handlers.forEach((handler) => handler('active'));
    await jest.advanceTimersByTimeAsync(0);
    expect(network.refresh).toHaveBeenCalledTimes(3);
    expect(c.offline).toBe(false);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(network.refresh).toHaveBeenCalledTimes(3);
    await c.stop();
  });

  it('still offline on return: the read finds nothing, and the timer runs again', async () => {
    jest.useFakeTimers();
    const handlers: ((state: string) => void)[] = [];
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, handler) => {
      handlers.push(handler as (state: string) => void);
      return { remove: () => undefined };
    });
    const network = Object.assign(fakeNetwork(), { refresh: jest.fn(async () => false) });
    const c = await playing({ network }, {}, 30);
    network.set(false);
    handlers.forEach((handler) => handler('background'));
    await jest.advanceTimersByTimeAsync(30_000);
    expect(network.refresh).not.toHaveBeenCalled();
    handlers.forEach((handler) => handler('active'));
    await jest.advanceTimersByTimeAsync(0);
    expect(network.refresh).toHaveBeenCalledTimes(1);
    expect(c.offline).toBe(true);
    await jest.advanceTimersByTimeAsync(3_000);
    expect(network.refresh).toHaveBeenCalledTimes(2);
    await c.stop();
  });
});
