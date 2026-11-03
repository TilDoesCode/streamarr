import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';

import type { EmbeddedServerApi } from '@modules/embedded-server';
import { mockEmbeddedServer } from '@modules/embedded-server/mock';

import { checkHealth, useEmbeddedServer, useServerCredentials } from '../use-embedded-server';

let client: QueryClient;
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

// The dev mock keeps its state across tests: they run in order, like one session on the box.
describe('useEmbeddedServer with the dev mock', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('starts: stopped → starting → running with addresses', async () => {
    const { result } = await renderHook(() => useEmbeddedServer(mockEmbeddedServer), { wrapper });
    await waitFor(() => expect(result.current.status?.state).toBe('stopped'));
    expect(result.current.supported).toBe(true);

    await act(async () => result.current.start.mutate());
    await waitFor(() => expect(result.current.status?.state).toBe('starting'));
    await act(async () => {
      jest.advanceTimersByTime(1500);
    });
    await waitFor(() =>
      expect(result.current.status).toMatchObject({ state: 'running', version: '0.21.0' })
    );
    expect(result.current.status?.addresses.map((address) => address.kind)).toEqual([
      'lan',
      'tailscale',
      'loopback',
    ]);
  });

  it('stops: running → stopping → stopped', async () => {
    const { result } = await renderHook(() => useEmbeddedServer(mockEmbeddedServer), { wrapper });
    await waitFor(() => expect(result.current.status?.state).toBe('running'));
    await act(async () => result.current.stop.mutate());
    await waitFor(() => expect(result.current.status?.state).toBe('stopping'));
    await act(async () => {
      jest.advanceTimersByTime(800);
    });
    await waitFor(() =>
      expect(result.current.status).toMatchObject({ state: 'stopped', addresses: [] })
    );
  });

  it('fails to start on port 1 and reports the error, then recovers', async () => {
    const { result } = await renderHook(() => useEmbeddedServer(mockEmbeddedServer), { wrapper });
    await waitFor(() => expect(result.current.status).not.toBeNull());
    await act(async () => {
      await result.current.setPort.mutateAsync(1);
    });
    await waitFor(() => expect(result.current.status?.port).toBe(1));
    await act(async () => result.current.start.mutate());
    await act(async () => {
      jest.advanceTimersByTime(1500);
    });
    await waitFor(() =>
      expect(result.current.status).toMatchObject({
        state: 'failed',
        lastError: 'Port 1: permission denied',
      })
    );
    await act(async () => {
      await result.current.setPort.mutateAsync(8080);
      await result.current.setAutostart.mutateAsync(false);
    });
    await waitFor(() =>
      expect(result.current.status).toMatchObject({ port: 8080, autostart: false })
    );
  });

  it('restarts with a changed port: the bound port and the addresses follow', async () => {
    const { result } = await renderHook(() => useEmbeddedServer(mockEmbeddedServer), { wrapper });
    // The previous test left the mock in `failed` on port 8080.
    await waitFor(() => expect(result.current.status?.state).toBe('failed'));
    await act(async () => result.current.start.mutate());
    await act(async () => {
      jest.advanceTimersByTime(1500);
    });
    await waitFor(() =>
      expect(result.current.status).toMatchObject({ state: 'running', runningPort: 8080 })
    );
    await act(async () => {
      await result.current.setPort.mutateAsync(9090);
    });
    await waitFor(() =>
      expect(result.current.status).toMatchObject({ port: 9090, runningPort: 8080 })
    );
    await act(async () => result.current.restart.mutate());
    await waitFor(() => expect(result.current.status?.state).toBe('stopping'));
    await act(async () => {
      jest.advanceTimersByTime(800);
    });
    await waitFor(() => expect(result.current.status?.state).toBe('stopped'));
    await act(async () => {
      jest.advanceTimersByTime(100);
    });
    await waitFor(() => expect(result.current.status?.state).toBe('starting'));
    await act(async () => {
      jest.advanceTimersByTime(1500);
    });
    await waitFor(() =>
      expect(result.current.status).toMatchObject({
        state: 'running',
        port: 9090,
        runningPort: 9090,
      })
    );
    expect(result.current.status?.addresses.find((a) => a.kind === 'loopback')?.url).toBe(
      'http://127.0.0.1:9090'
    );
    await act(async () => {
      await result.current.setPort.mutateAsync(8080);
      result.current.stop.mutate();
    });
    await act(async () => {
      jest.advanceTimersByTime(800);
    });
    await waitFor(() =>
      expect(result.current.status).toMatchObject({ state: 'stopped', port: 8080 })
    );
  });

  it('resets the admin password and updates the credentials', async () => {
    const { result } = await renderHook(
      () => ({
        server: useEmbeddedServer(mockEmbeddedServer),
        credentials: useServerCredentials(true, mockEmbeddedServer),
      }),
      { wrapper }
    );
    await waitFor(() =>
      expect(result.current.credentials.data?.password).toBe('mock-Passw0rd-xyz')
    );
    await act(async () => {
      await result.current.server.resetPassword.mutateAsync();
    });
    await waitFor(() =>
      expect(result.current.credentials.data?.password).not.toBe('mock-Passw0rd-xyz')
    );
    expect(result.current.credentials.data?.password).toMatch(/^mock-/);
  });

  it('follows the credentials event without a refetch', async () => {
    const getCredentials = jest.spyOn(mockEmbeddedServer, 'getCredentials');
    try {
      const { result } = await renderHook(() => useServerCredentials(true, mockEmbeddedServer), {
        wrapper,
      });
      await waitFor(() => expect(result.current.data?.password).toMatch(/^mock-/));
      const reads = getCredentials.mock.calls.length;
      // Another caller (the Streamybox Settings page, the OS provider) rotates the password: the event arrives here.
      let fresh: string | null = null;
      await act(async () => {
        fresh = (await mockEmbeddedServer.resetAdminPassword()).password;
      });
      await waitFor(() => expect(result.current.data?.password).toBe(fresh));
      expect(getCredentials.mock.calls.length).toBe(reads);
    } finally {
      getCredentials.mockRestore();
    }
  });
});

describe('useEmbeddedServer errors and unsupported devices', () => {
  const unsupported = {
    ...mockEmbeddedServer,
    supported: false,
    getStatus: jest.fn(),
    addStatusListener: jest.fn(),
  } as unknown as EmbeddedServerApi;

  it('does not touch the native module when unsupported', async () => {
    const { result } = await renderHook(() => useEmbeddedServer(unsupported), { wrapper });
    expect(result.current).toMatchObject({ supported: false, status: null, loading: false });
    expect(unsupported.getStatus).not.toHaveBeenCalled();
    expect(unsupported.addStatusListener).not.toHaveBeenCalled();
  });

  it('maps a native rejection to an AppError', async () => {
    const broken: EmbeddedServerApi = {
      ...mockEmbeddedServer,
      start: () => Promise.reject(new Error('service binding lost')),
    };
    const { result } = await renderHook(() => useEmbeddedServer(broken), { wrapper });
    await act(async () => {
      await result.current.start.mutateAsync().catch(() => undefined);
    });
    await waitFor(() =>
      expect(result.current.start.error).toMatchObject({
        code: 'local_server_failed',
        detail: 'service binding lost',
      })
    );
  });
});

describe('checkHealth', () => {
  const transport = (status: number, body: string) =>
    jest.fn(async () => ({ status, body, contentType: 'application/json' }));

  it('reads the version of a healthy server', async () => {
    const fake = transport(200, '{"status":"ok","version":"0.21.0+abc"}');
    await expect(checkHealth('http://127.0.0.1:8080', fake)).resolves.toEqual({
      version: '0.21.0+abc',
    });
    expect(fake).toHaveBeenCalledWith('http://127.0.0.1:8080/api/v1/health', expect.any(Number));
  });

  it('rejects other answers', async () => {
    await expect(checkHealth('http://x', transport(503, ''))).rejects.toMatchObject({
      code: 'server_error',
    });
    await expect(checkHealth('http://x', transport(200, '<html>'))).rejects.toMatchObject({
      code: 'not_streamarr',
    });
  });
});
