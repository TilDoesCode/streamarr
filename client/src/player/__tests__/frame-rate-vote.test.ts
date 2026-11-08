import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CLIENT = join(__dirname, '..', '..', '..');

/** The rate table and match window a native frame-rate vote snaps with. */
function snapRule(path: string): { rates: string; window: string } {
  const source = readFileSync(join(CLIENT, path), 'utf8');
  const rates = /floatArrayOf\(([^)]*)\)/.exec(source)?.[1]?.replace(/\s/g, '');
  const window = /abs\(it - \w+\) < it \* ([\d.]+f)/.exec(source)?.[1];
  if (!rates || !window) throw new Error(`no snap rule in ${path}`);
  return { rates, window };
}

describe('display frame-rate vote', () => {
  it('snaps the same way for the built-in player and the Streamybox Player', () => {
    const exoPlayer = snapRule('patches/expo-video+57.0.5.patch');
    const streamybox = snapRule(
      'modules/streamybox-player/android/src/main/java/expo/modules/streamyboxplayer/FrameRateVote.kt'
    );
    expect(streamybox).toEqual(exoPlayer);
    expect(exoPlayer.rates.split(',')).toContain('23.976f');
  });
});
