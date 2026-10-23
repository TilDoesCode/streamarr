import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useActiveAccount } from '@/accounts/accounts-provider';
import { unwrap } from '@/api/client';
import type { components } from '@/api/schema';
import { accountKey } from '@/query/keys';

import { runSpeedTest, type SpeedProgress, type SpeedResult } from './speed-test';
import { createSpeedTransport, fetchSpeedLimits } from './speed-transport';

export type DiagnosticsReport = components['schemas']['DiagnosticsResponse'];
export type DiagnosticsComponent = components['schemas']['DiagnosticsComponent'];

/** The server's redacted diagnostics report; `refresh()` asks for fresh probes (the server throttles to every 10 s). */
export function useServerDiagnostics() {
  const { account, client } = useActiveAccount();
  const queryClient = useQueryClient();
  const key = accountKey(account.id, 'diagnostics');
  const query = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => unwrap(client.GET('/api/v1/viewer/diagnostics', { signal })),
    staleTime: 15_000,
    retry: false,
  });
  const refresh = useMutation({
    mutationFn: () =>
      unwrap(client.GET('/api/v1/viewer/diagnostics', { params: { query: { refresh: true } } })),
    onSuccess: (report) => queryClient.setQueryData(key, report),
  });
  return { query, refresh };
}

export type SpeedTestState =
  | { status: 'idle' }
  | { status: 'running'; progress?: SpeedProgress }
  | { status: 'done'; result: SpeedResult }
  | { status: 'error'; error: unknown; progress?: SpeedProgress };

/** Runs the speed test against the active server; cancelled when the screen unmounts. */
export function useSpeedTest() {
  const { client } = useActiveAccount();
  const [state, setState] = useState<SpeedTestState>({ status: 'idle' });
  const controller = useRef<AbortController | null>(null);

  useEffect(() => () => controller.current?.abort(), []);

  const start = useCallback(async () => {
    controller.current?.abort();
    const own = new AbortController();
    controller.current = own;
    let last: SpeedProgress | undefined;
    setState({ status: 'running' });
    try {
      const limits = await fetchSpeedLimits(client, own.signal);
      const result = await runSpeedTest({
        transport: createSpeedTransport(client),
        limits,
        signal: own.signal,
        onProgress: (progress) => {
          last = progress;
          if (!own.signal.aborted) setState({ status: 'running', progress });
        },
      });
      if (!own.signal.aborted) setState({ status: 'done', result });
    } catch (error) {
      if (!own.signal.aborted) setState({ status: 'error', error, progress: last });
    }
  }, [client]);

  const cancel = useCallback(() => {
    controller.current?.abort();
    setState({ status: 'idle' });
  }, []);

  return { state, start, cancel };
}
