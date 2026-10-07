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
