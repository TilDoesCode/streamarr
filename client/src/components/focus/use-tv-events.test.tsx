import { renderHook } from '@testing-library/react-native';

import { useTVEvents } from './use-tv-events';

type TVEvent = { eventType: string };
const mockTV = { handlers: new Set<(event: TVEvent) => void>() };

jest.mock('react-native', () => {
  const actual = jest.requireActual('react-native');
  return Object.defineProperty(actual, 'useTVEventHandler', {
    value: (handler: (event: TVEvent) => void) => void mockTV.handlers.add(handler),
  });
});

describe('useTVEvents', () => {
  it('keeps one subscription across re-renders and calls the latest handler (Q1-25)', async () => {
    const seen: string[] = [];
    const { rerender } = await renderHook(
      ({ name }: { name: string }) =>
        useTVEvents((event) => void seen.push(`${name}:${event.eventType}`)),
      { initialProps: { name: 'a' } }
    );
    for (const name of ['b', 'c', 'd']) await rerender({ name });
    expect(mockTV.handlers.size).toBe(1);
    [...mockTV.handlers][0]!({ eventType: 'select' });
    expect(seen).toEqual(['d:select']);
  });
});
