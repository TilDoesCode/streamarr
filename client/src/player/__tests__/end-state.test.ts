import { endOverlay, type EndInput } from '../end-state';

const base: EndInput = {
  playing: true,
  ended: false,
  hasNext: false,
  upNextDismissed: false,
  blocked: false,
  remaining: 60,
  duration: 120,
  upNextSeconds: 15,
};

describe('endOverlay', () => {
  it('shows nothing during playback', () => {
    expect(endOverlay(base)).toBeNull();
    expect(endOverlay({ ...base, hasNext: true })).toBeNull();
  });

  it('shows up-next near the end when a next episode exists', () => {
    expect(endOverlay({ ...base, hasNext: true, remaining: 10 })).toBe('upNext');
    expect(endOverlay({ ...base, hasNext: true, ended: true })).toBe('upNext');
  });

  it('shows the end card when up-next was cancelled and playback ended', () => {
    const cancelled = { ...base, hasNext: true, upNextDismissed: true };
    expect(endOverlay({ ...cancelled, remaining: 10 })).toBeNull();
    expect(endOverlay({ ...cancelled, ended: true, remaining: 0 })).toBe('endCard');
  });

  it('shows the end card for the last episode or a movie', () => {
    expect(endOverlay({ ...base, remaining: 5 })).toBeNull();
    expect(endOverlay({ ...base, ended: true })).toBe('endCard');
  });

  it('stays hidden while a panel or picker is open or playback is not running', () => {
    expect(endOverlay({ ...base, ended: true, blocked: true })).toBeNull();
    expect(endOverlay({ ...base, ended: true, playing: false })).toBeNull();
  });
});
