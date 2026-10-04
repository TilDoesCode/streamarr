import { useCallback, useLayoutEffect, useRef } from 'react';
import { useTVEventHandler } from 'react-native';

type TVHandler = Parameters<typeof useTVEventHandler>[0];

const useTVEventHandlerOrNoop: typeof useTVEventHandler = useTVEventHandler ?? (() => undefined);

/** TV remote events with one subscription: react-native-tvos re-subscribes whenever the handler identity changes. */
export function useTVEvents(handler: TVHandler): void {
  const latest = useRef(handler);
  useLayoutEffect(() => {
    latest.current = handler;
  });
  const stable = useCallback<TVHandler>((event) => latest.current(event), []);
  useTVEventHandlerOrNoop(stable);
}
