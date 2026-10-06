import { useEffect, useEffectEvent, useRef } from 'react';
import { Platform } from 'react-native';

/** What the guard needs from a cross-tab transport: BroadcastChannel, or the storage-event stand-in. */
export type TabChannel = {
  post(message: TabMessage): void;
  listen(listener: (message: TabMessage) => void): () => void;
  close(): void;
};

export type TabMessage = { type: 'playing'; tab: string };

const NAME = 'streamarr.player';

function broadcastChannel(): TabChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  const channel = new BroadcastChannel(NAME);
  return {
    post: (message) => channel.postMessage(message),
    listen: (listener) => {
      const handler = (event: MessageEvent) => listener(event.data as TabMessage);
      channel.addEventListener('message', handler);
      return () => channel.removeEventListener('message', handler);
    },
    close: () => channel.close(),
  };
}

/** Older Safari: a storage write reaches every other tab of the origin as a `storage` event. */
function storageChannel(): TabChannel | null {
  if (typeof window === 'undefined' || !window.localStorage || !window.addEventListener)
    return null;
  return {
    post: (message) =>
      window.localStorage.setItem(NAME, JSON.stringify({ ...message, at: Date.now() })),
    listen: (listener) => {
      const handler = (event: StorageEvent) => {
        if (event.key !== NAME || !event.newValue) return;
        try {
          listener(JSON.parse(event.newValue) as TabMessage);
        } catch {
          // Another writer's value: not ours to read.
        }
      };
      window.addEventListener('storage', handler);
      return () => window.removeEventListener('storage', handler);
    },
    close: () => undefined,
  };
}

/** The transport of this platform; none on native apps (one player per app). */
export function openTabChannel(): TabChannel | null {
  if (Platform.OS !== 'web') return null;
  return broadcastChannel() ?? storageChannel();
}

/** One playing tab per browser (F12): playing here tells the others, which pause and say why. */
export function createTabGuard(channel: TabChannel | null, onOtherTab: () => void) {
  const tab = Math.random().toString(36).slice(2);
  const off = channel?.listen((message) => {
    if (message?.type === 'playing' && message.tab !== tab) onOtherTab();
  });
  return {
    announce: () => channel?.post({ type: 'playing', tab }),
    close: () => {
      off?.();
      channel?.close();
    },
  };
}

/** Announces each start or resume of this tab's playback; another tab's start pauses this one. */
export function useOneTabPlays(
  playing: boolean,
  onOtherTab: () => void,
  open: () => TabChannel | null = openTabChannel
): void {
  const yieldTo = useEffectEvent(onOtherTab);
  const guard = useRef<ReturnType<typeof createTabGuard> | null>(null);
  useEffect(() => {
    const created = createTabGuard(open(), () => yieldTo());
    guard.current = created;
    return () => {
      created.close();
      guard.current = null;
    };
  }, [open]);
  useEffect(() => {
    if (playing) guard.current?.announce();
  }, [playing]);
}
