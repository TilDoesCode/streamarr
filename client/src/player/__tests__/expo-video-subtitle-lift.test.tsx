import { render } from '@testing-library/react-native';

import { ExpoVideoEngine } from '@/player/engines/expo-video-engine';
import { FakeExpoPlayer } from '@/../jest/player/library-fakes';

jest.mock('expo-video', () =>
  jest.requireActual('@/../jest/player/library-fakes').expoVideoModule()
);

const engines: ExpoVideoEngine[] = [];
afterEach(() => engines.splice(0).forEach((engine) => engine.release()));

function engineWithPlayer() {
  const engine = new ExpoVideoEngine();
  engines.push(engine);
  return { engine, player: FakeExpoPlayer.last };
}

describe('expo-video subtitle lift (F13n, Q2-02)', () => {
  it('waits for a VideoView, then hands the native player the latest lift once', async () => {
    const { engine, player } = engineWithPlayer();
    engine.setSubtitleLift(0.1);
    engine.setSubtitleLift(0.2);
    expect(player.subtitleLifts).toEqual([]);
    await render(<engine.Surface />);
    expect(player.subtitleLifts).toEqual([0.2]);
  });

  it('calls the native player only when the lift changes; 0 puts the cues back', async () => {
    const { engine, player } = engineWithPlayer();
    await render(<engine.Surface />);
    engine.setSubtitleLift(0.19375);
    engine.setSubtitleLift(0.19375);
    engine.setSubtitleLift(0.19375000001);
    engine.setSubtitleLift(0);
    engine.setSubtitleLift(0);
    expect(player.subtitleLifts).toEqual([0.194, 0]);
  });

  it('starts with the cues in place: no call for 0 and none after the view unmounts', async () => {
    const { engine, player } = engineWithPlayer();
    const view = await render(<engine.Surface />);
    engine.setSubtitleLift(0);
    expect(player.subtitleLifts).toEqual([]);
    await view.unmount();
    engine.setSubtitleLift(0.3);
    expect(player.subtitleLifts).toEqual([]);
    await render(<engine.Surface />);
    expect(player.subtitleLifts).toEqual([0.3]);
  });

  it('clamps the lift to 0–1 and stops after release', async () => {
    const { engine, player } = engineWithPlayer();
    await render(<engine.Surface />);
    engine.setSubtitleLift(-0.2);
    engine.setSubtitleLift(1.4);
    engine.release();
    engines.splice(0);
    engine.setSubtitleLift(0.5);
    expect(player.subtitleLifts).toEqual([1]);
  });

  it('an unpatched build without setSubtitleLift leaves the cues alone', async () => {
    const { engine, player } = engineWithPlayer();
    player.setSubtitleLift = undefined;
    await render(<engine.Surface />);
    expect(() => engine.setSubtitleLift(0.2)).not.toThrow();
  });
});

describe('AVPlayer ceiling: a lifted cue stays below the centre controls (Q2-12)', () => {
  it('sends the ceiling with the lift, resends when only the ceiling moves, drops it with the lift', async () => {
    const { engine, player } = engineWithPlayer();
    await render(<engine.Surface />);
    engine.setSubtitleLift(0.32, 0.59);
    engine.setSubtitleLift(0.32, 0.59);
    engine.setSubtitleLift(0.32, 0.6);
    engine.setSubtitleLift(0, 0.6);
    expect(player.subtitleLifts).toEqual([0.32, 0.32, 0]);
    expect(player.subtitleCeilings).toEqual([0.59, 0.6, 0]);
  });

  it('a build whose native call takes the lift alone still gets the lift', async () => {
    const { engine, player } = engineWithPlayer();
    const lifts: number[] = [];
    player.setSubtitleLift = (...args: (number | undefined)[]) => {
      if (args.length > 1) throw new Error('Received 2 arguments, but 1 was expected');
      lifts.push(args[0]!);
    };
    await render(<engine.Surface />);
    engine.setSubtitleLift(0.3, 0.55);
    expect(lifts).toEqual([0.3]);
  });
});

describe('downloads on AVPlayer (DL-C1: iOS 26.5 crashes when a file item’s text style rules go back to nil)', () => {
  const file = { uri: 'file:///data/downloads/a1/d1/Movie.mp4', kind: 'file' } as never;
  const stream = { uri: 'http://dev.test/stream/p1/master.m3u8', kind: 'hls' } as never;

  it('never lifts the cues of a downloaded file, so they are never reset to nil', async () => {
    const { engine, player } = engineWithPlayer();
    await render(<engine.Surface />);
    engine.load(file);
    engine.setSubtitleLift(0.32, 0.59);
    engine.setSubtitleLift(0, 0.59);
    expect(player.subtitleLifts).toEqual([]);
  });

  it('takes a streamed lift back before the file loads and lifts again for the next stream', async () => {
    const { engine, player } = engineWithPlayer();
    await render(<engine.Surface />);
    engine.load(stream);
    engine.setSubtitleLift(0.32);
    engine.load(file);
    engine.setSubtitleLift(0.2);
    engine.load(stream);
    player.loaded();
    await Promise.resolve();
    expect(player.subtitleLifts).toEqual([0.32, 0, 0.2]);
  });
});
