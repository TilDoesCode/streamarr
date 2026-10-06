import { renderHook } from '@testing-library/react-native';

import type { PlaybackController } from '@/player/controller';
import { useMediaSession } from '@/player/use-media-session.web';

describe('web Media Session: the browser controls go through the player (V2 turn 2 E07)', () => {
  const handlers = new Map<string, ((details: object) => void) | null>();
  const session = {
    setActionHandler: jest.fn((action: string, handler: ((details: object) => void) | null) => {
      if (action === 'skipad') throw new Error('not supported');
      handlers.set(action, handler);
    }),
  };
  beforeEach(() => {
    handlers.clear();
    Object.defineProperty(globalThis.navigator, 'mediaSession', {
      value: session,
      configurable: true,
    });
  });

  it('play, pause and seeks call the controller (play after the end replays there); unmount removes them', async () => {
    const controller = {
      setPaused: jest.fn(),
      seekTo: jest.fn(),
      position: 120,
    } as unknown as PlaybackController;
    const hook = await renderHook(() => useMediaSession(controller));
    handlers.get('play')!({});
    expect(controller.setPaused).toHaveBeenLastCalledWith(false);
    handlers.get('pause')!({});
    expect(controller.setPaused).toHaveBeenLastCalledWith(true);
    handlers.get('seekto')!({ seekTime: 42 });
    expect(controller.seekTo).toHaveBeenLastCalledWith(42);
    handlers.get('seekbackward')!({});
    expect(controller.seekTo).toHaveBeenLastCalledWith(110);
    handlers.get('seekforward')!({ seekOffset: 30 });
    expect(controller.seekTo).toHaveBeenLastCalledWith(150);
    await hook.unmount();
    expect([...handlers.values()].every((handler) => handler === null)).toBe(true);
  });

  it('an old player unmounting after the next one mounted (up-next replace with a transition) keeps the new handlers', async () => {
    const first = {
      setPaused: jest.fn(),
      seekTo: jest.fn(),
      position: 0,
    } as unknown as PlaybackController;
    const second = {
      setPaused: jest.fn(),
      seekTo: jest.fn(),
      position: 0,
    } as unknown as PlaybackController;
    const old = await renderHook(() => useMediaSession(first));
    const next = await renderHook(() => useMediaSession(second));
    await old.unmount();
    expect(handlers.get('play')).not.toBeNull();
    handlers.get('play')!({});
    expect(second.setPaused).toHaveBeenLastCalledWith(false);
    expect(first.setPaused).not.toHaveBeenCalled();
    await next.unmount();
    expect(handlers.get('play')).toBeNull();
  });
});
