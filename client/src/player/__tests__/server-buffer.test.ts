import { act, renderHook } from '@testing-library/react-native';

import type { ApiClient } from '@/api/client';

import { SERVER_BUFFER_POLL_MS, serverRanges, useServerBuffer } from '../server-buffer';

type Answer = { known: boolean; complete?: boolean; ranges?: { start: number; end: number }[] };

function fakeClient(answers: Answer[]) {
  const calls: string[] = [];
  const client = {
    GET: jest.fn(async (path: string, init: { params: { path: { playbackId: string } } }) => {
      calls.push(`${path}:${init.params.path.playbackId}`);
      const data = answers.length > 1 ? answers.shift() : answers[0];
      return { data, response: new Response(null, { status: 200 }) };
    }),
  } as unknown as ApiClient;
  return { client, calls };
}

const flush = () => act(async () => undefined);

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe('serverRanges', () => {
  it('is empty while no stream session backs the playback', () => {
    expect(serverRanges({ known: false, complete: false, ranges: [] })).toEqual([]);
    expect(serverRanges(null)).toEqual([]);
  });

  it('a finished pre-download is the whole timeline', () => {
    expect(serverRanges({ known: true, complete: true, ranges: [] })).toEqual([
      { start: 0, end: 1 },
    ]);
  });

  it('clamps, rounds to 0.1 % and drops empty ranges', () => {
    expect(
      serverRanges({
        known: true,
        complete: false,
        ranges: [
          { start: -0.1, end: 0.12345 },
          { start: 0.5, end: 0.5 },
          { start: 0.9, end: 1.2 },
        ],
      })
    ).toEqual([
      { start: 0, end: 0.123 },
      { start: 0.9, end: 1 },
    ]);
  });
});

describe('useServerBuffer', () => {
  it('polls while the controls show and stops when they hide', async () => {
    const { client, calls } = fakeClient([
      { known: true, ranges: [{ start: 0, end: 0.2 }] },
      { known: true, ranges: [{ start: 0, end: 0.4 }] },
    ]);
    const hook = await renderHook(
      ({ active }: { active: boolean }) => useServerBuffer(client, 'p1', active),
      { initialProps: { active: true } }
    );
    await flush();
    expect(hook.result.current).toEqual([{ start: 0, end: 0.2 }]);
    expect(calls).toEqual(['/api/v1/viewer/playback/{playbackId}/buffer:p1']);

    await act(async () => jest.advanceTimersByTime(SERVER_BUFFER_POLL_MS));
    expect(hook.result.current).toEqual([{ start: 0, end: 0.4 }]);

    await hook.rerender({ active: false });
    await act(async () => jest.advanceTimersByTime(SERVER_BUFFER_POLL_MS * 3));
    expect(calls).toHaveLength(2);
    // The last answer stays on the bar while hidden.
    expect(hook.result.current).toEqual([{ start: 0, end: 0.4 }]);
  });

  it('stops polling once the whole file is on the server', async () => {
    const { client, calls } = fakeClient([{ known: true, complete: true }]);
    const hook = await renderHook(() => useServerBuffer(client, 'p1', true));
    await flush();
    expect(hook.result.current).toEqual([{ start: 0, end: 1 }]);
    await act(async () => jest.advanceTimersByTime(SERVER_BUFFER_POLL_MS * 3));
    expect(calls).toHaveLength(1);
  });

  it('a new playback starts empty instead of showing the old file', async () => {
    const { client } = fakeClient([{ known: true, ranges: [{ start: 0, end: 0.5 }] }]);
    const hook = await renderHook(
      ({ id, active }: { id: string; active: boolean }) => useServerBuffer(client, id, active),
      { initialProps: { id: 'p1', active: true } }
    );
    await flush();
    expect(hook.result.current).toEqual([{ start: 0, end: 0.5 }]);
    await hook.rerender({ id: 'p2', active: false });
    expect(hook.result.current).toEqual([]);
  });

  it('keeps the last ranges when a poll fails and does nothing without a client', async () => {
    const failing = {
      GET: jest
        .fn()
        .mockResolvedValueOnce({
          data: { known: true, ranges: [{ start: 0, end: 0.3 }] },
          response: new Response(null, { status: 200 }),
        })
        .mockRejectedValue(new TypeError('Network request failed')),
    } as unknown as ApiClient;
    const hook = await renderHook(() => useServerBuffer(failing, 'p1', true));
    await flush();
    await act(async () => jest.advanceTimersByTime(SERVER_BUFFER_POLL_MS));
    expect(hook.result.current).toEqual([{ start: 0, end: 0.3 }]);

    const none = await renderHook(() => useServerBuffer(undefined, 'p1', true));
    expect(none.result.current).toEqual([]);
  });
});
