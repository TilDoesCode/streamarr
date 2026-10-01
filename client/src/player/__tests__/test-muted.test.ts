import { effectiveMuted, resolveTestMuted } from '../test-muted';

describe('test-muted', () => {
  it('is on only in dev builds with EXPO_PUBLIC_TEST_MUTED=1', () => {
    expect(resolveTestMuted('1', true)).toBe(true);
    expect(resolveTestMuted('true', true)).toBe(true);
    expect(resolveTestMuted('1', false)).toBe(false);
    expect(resolveTestMuted(undefined, true)).toBe(false);
    expect(resolveTestMuted('0', true)).toBe(false);
  });

  it('ignores unmute requests while test-muted', () => {
    expect(effectiveMuted(false, true)).toBe(true);
    expect(effectiveMuted(true, true)).toBe(true);
    expect(effectiveMuted(false, false)).toBe(false);
    expect(effectiveMuted(true, false)).toBe(true);
  });

  it('reads the flag from the environment', () => {
    const previous = process.env.EXPO_PUBLIC_TEST_MUTED;
    process.env.EXPO_PUBLIC_TEST_MUTED = '1';
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      expect(require('../test-muted').TEST_MUTED).toBe(true);
    });
    process.env.EXPO_PUBLIC_TEST_MUTED = previous;
  });

  it('starts every engine muted and keeps it muted', () => {
    process.env.EXPO_PUBLIC_TEST_MUTED = '1';
    jest.isolateModules(() => {
      jest.doMock('expo-libvlc-player', () => ({ LibVlcPlayerView: () => null }));
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { VlcEngine } = require('../engines/vlc-engine');
      const engine = new VlcEngine();
      const props = (engine as unknown as { props: { get(): { mute: boolean } } }).props;
      expect(props.get().mute).toBe(true);
      engine.setMuted(false);
      expect(props.get().mute).toBe(true);
    });
    delete process.env.EXPO_PUBLIC_TEST_MUTED;
  });
});
