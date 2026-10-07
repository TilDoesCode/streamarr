import { FakeVideoElement } from '@/../jest/player/library-fakes';
import { liftCue, liftCues, liftedLine } from '@/player/engines/web-cues';
import { WebEngine } from '@/player/engines/web-engine.web';

describe('web subtitle cues above the control bar (Q2-02)', () => {
  const cue = () => ({ line: 'auto' as number | 'auto', snapToLines: true, lineAlign: 'start' });

  it('a lift puts the cue above the bottom share of the picture, 0 puts it back where it was', () => {
    const one = cue();
    liftCue(one, 0.2);
    expect(one).toEqual({ line: 78, snapToLines: false, lineAlign: 'end' });
    liftCue(one, 0.25);
    expect(one.line).toBe(73);
    liftCue(one, 0);
    expect(one).toEqual(cue());
  });

  it('only showing tracks; all cues on a change, the active ones as playback runs', () => {
    const shown = {
      mode: 'showing',
      cues: [cue(), cue()],
      activeCues: [] as ReturnType<typeof cue>[],
    };
    const hidden = { mode: 'disabled', cues: [cue()] };
    liftCues([shown, hidden], 0.2);
    expect(shown.cues.map((item) => item.line)).toEqual([78, 78]);
    expect(hidden.cues[0]!.line).toBe('auto');
    const late = cue();
    shown.activeCues = [late];
    liftCues([shown], 0.2, true);
    expect(late.line).toBe(78);
    liftCues([shown], 0);
    expect(shown.cues.map((item) => item.line)).toEqual(['auto', 'auto']);
  });
});

describe('the web engine places the cues (Q2-02)', () => {
  it('setSubtitleLift lifts the showing track, new active cues follow as the clock runs, 0 restores', () => {
    const engine = new WebEngine();
    const video = new FakeVideoElement();
    const shown = {
      mode: 'showing',
      cues: [{ line: 'auto', snapToLines: true, lineAlign: 'start' }],
      activeCues: [] as object[],
    };
    Object.assign(video.textTracks, { 0: shown, length: 1 });
    (engine as unknown as { attach(video: unknown): void }).attach(video);
    engine.setSubtitleLift(0.2);
    expect(shown.cues[0]!.line).toBe(78);
    const late = { line: 'auto', snapToLines: true, lineAlign: 'start' };
    shown.activeCues = [late];
    video.dispatchEvent(new Event('timeupdate'));
    expect(late.line).toBe(78);
    engine.setSubtitleLift(0);
    expect(shown.cues[0]!.line).toBe('auto');
    engine.release();
  });
});

describe('the lifted cue box ends above the bar, with a gap (Q2 open issue, web 1280)', () => {
  const boxBottom = (line: number, height: number) => (line / 100) * height;

  it.each([
    ['the brief: bar top 645 of 800', 645, 800],
    ['the live run: bar top 643.6 of 800 (80.45 %)', 643.6, 800],
    ['a small player: bar top 250 of 300', 250, 300],
    ['a tall window: bar top 1210 of 1440', 1210, 1440],
  ])(
    '%s — the box bottom is at least 8 px and 1.5 % above the bar top',
    (_name, barTop, height) => {
      const line = liftedLine(1 - barTop / height, height);
      expect(Number.isInteger(line)).toBe(true);
      expect(boxBottom(line, height)).toBeLessThan(barTop);
      expect(barTop - boxBottom(line, height)).toBeGreaterThanOrEqual(8);
      expect(barTop - boxBottom(line, height)).toBeGreaterThanOrEqual(0.015 * height);
    }
  );

  it('bar top 645 of 800: line 79 % (box bottom 632 px), never the old 81 %', () => {
    expect(liftedLine(1 - 645 / 800, 800)).toBe(79);
    expect(liftedLine(1 - 643.6 / 800, 800)).toBe(78);
  });

  it('without a known box height the 1.5 % gap alone, never below 0', () => {
    expect(liftedLine(0.2)).toBe(78);
    expect(liftedLine(0.99)).toBe(0);
  });
});
