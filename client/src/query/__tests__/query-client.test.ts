import NetInfo from '@react-native-community/netinfo';
import { focusManager, onlineManager } from '@tanstack/react-query';
import { AppState } from 'react-native';

import { AppError } from '@/api/errors';
import { queryKeys } from '@/query/keys';
import { setupQueryManagers, shouldRetry } from '@/query/query-client';

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
