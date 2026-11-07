import NetInfo from '@react-native-community/netinfo';
import { focusManager, onlineManager } from '@tanstack/react-query';
import { AppState } from 'react-native';
import { waitFor } from '@testing-library/react-native';

import { AppError } from '@/api/errors';
import { queryKeys } from '@/query/keys';
import { createQueryClient, setupQueryManagers, shouldRetry } from '@/query/query-client';

jest.mock('@react-native-community/netinfo', () => ({
  __esModule: true,
  default: { addEventListener: jest.fn(() => jest.fn()) },
}));

describe('retry policy', () => {
  it('retries transport failures, 5xx and 429 twice, never other answers', () => {
    expect(shouldRetry(0, new AppError('network_unreachable'))).toBe(true);
    expect(shouldRetry(1, new AppError('server_error', { status: 502 }))).toBe(true);
    expect(shouldRetry(0, new AppError('capacity_reached', { status: 429 }))).toBe(true);
    expect(shouldRetry(2, new AppError('timeout'))).toBe(false);
    expect(shouldRetry(0, new AppError('age_restricted', { status: 403 }))).toBe(false);
    expect(shouldRetry(0, new AppError('refresh_token_reused', { status: 401 }))).toBe(false);
    expect(shouldRetry(0, new Error('boom'))).toBe(false);
  });
});

describe('query keys', () => {
  it('partition account data by account id', () => {
    expect(queryKeys.discover('a1')).toEqual(['account', 'a1', 'catalog', 'discover']);
    expect(queryKeys.me('a2')).toEqual(['account', 'a2', 'me']);
  });
});

describe('managers', () => {
  it('follow NetInfo connectivity and the app state', () => {
    const appStateListeners: ((status: string) => void)[] = [];
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => {
      appStateListeners.push(listener as (status: string) => void);
      return { remove: jest.fn() } as unknown as ReturnType<typeof AppState.addEventListener>;
    });
    setupQueryManagers();
    const netListener = jest.mocked(NetInfo.addEventListener).mock.calls[0]?.[0];
    expect(netListener).toBeDefined();

    netListener?.({ isConnected: false } as never);
    expect(onlineManager.isOnline()).toBe(false);
    netListener?.({ isConnected: true } as never);
    expect(onlineManager.isOnline()).toBe(true);

    appStateListeners.forEach((listener) => listener('background'));
    expect(focusManager.isFocused()).toBe(false);
    appStateListeners.forEach((listener) => listener('active'));
    expect(focusManager.isFocused()).toBe(true);
  });
});

describe('offline (Q1-24)', () => {
  afterEach(() => onlineManager.setOnline(true));

  it('fails into the error state instead of pausing on a skeleton, and refetches when back online', async () => {
    onlineManager.setOnline(false);
    const client = createQueryClient(false);
    let online = false;
    const queryFn = jest.fn(() =>
      online ? Promise.resolve('rows') : Promise.reject(new AppError('network_unreachable'))
    );
    await expect(
      client.fetchQuery({ queryKey: ['offline'], queryFn, retry: false })
    ).rejects.toMatchObject({ code: 'network_unreachable' });
    expect(client.getQueryState(['offline'])?.status).toBe('error');
    expect(client.getDefaultOptions().queries?.refetchOnReconnect).toBe(true);
    online = true;
    await expect(client.fetchQuery({ queryKey: ['offline'], queryFn })).resolves.toBe('rows');
    client.clear();
  });
});

describe('server reachability (C1-24)', () => {
  it('offline also means "server unreachable", and paused mutations run once it answers again', async () => {
    const { onlineManager, MutationObserver } =
      jest.requireActual<typeof import('@tanstack/react-query')>('@tanstack/react-query');
    const { createQueryClient, setServerReachable, setupQueryManagers } =
      jest.requireActual<typeof import('../query-client')>('../query-client');
    setupQueryManagers();
    const client = createQueryClient();
    client.mount();
    setServerReachable(false);
    expect(onlineManager.isOnline()).toBe(false);
    const mutationFn = jest.fn(async () => 'saved');
    const observer = new MutationObserver(client, { mutationFn });
    const result = observer.mutate();
    await Promise.resolve();
    expect(observer.getCurrentResult().isPaused).toBe(true);
    expect(mutationFn).not.toHaveBeenCalled();
    setServerReachable(true);
    await expect(result).resolves.toBe('saved');
    expect(onlineManager.isOnline()).toBe(true);
    client.unmount();
  });
});

describe('offline shell (C1-24)', () => {
  afterEach(() => onlineManager.setOnline(true));

  it("pauses the active server's account queries offline; everything else keeps running", async () => {
    const client = createQueryClient(true);
    client.mount();
    onlineManager.setOnline(false);
    const queryFn = jest.fn(async () => 'answer');
    void client.fetchQuery({ queryKey: queryKeys.me('a1'), queryFn });
    await Promise.resolve();
    expect(queryFn).not.toHaveBeenCalled();
    expect(client.getQueryState(queryKeys.me('a1'))?.fetchStatus).toBe('paused');
    for (const queryKey of [
      ['device', 'profile'],
      ['localServer', 'status'],
      queryKeys.serverOptions('http://other.test'),
      ['app-update', 'native-release', 'https://example.test'],
    ])
      await expect(client.fetchQuery({ queryKey, queryFn: async () => 'local' })).resolves.toBe(
        'local'
      );
    onlineManager.setOnline(true);
    await waitFor(() => expect(client.getQueryData(queryKeys.me('a1'))).toBe('answer'));
    expect(queryFn).toHaveBeenCalledTimes(1);
    client.unmount();
    client.clear();
  });

  it('keeps failing into the error card where no offline shell exists (web, tvOS)', () => {
    const client = createQueryClient(false);
    expect(client.getQueryDefaults(queryKeys.me('a1')).networkMode).toBeUndefined();
    expect(client.getDefaultOptions().queries?.networkMode).toBe('always');
    expect(createQueryClient(true).getQueryDefaults(queryKeys.me('a1')).networkMode).toBe('online');
  });
});
