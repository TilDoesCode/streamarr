import { FakeVideoElement } from '@/../jest/player/library-fakes';
import { liftCue, liftCues } from '@/player/engines/web-cues';
import { WebEngine } from '@/player/engines/web-engine.web';

describe('web subtitle cues above the control bar (Q2-02)', () => {
  const cue = () => ({ line: 'auto' as number | 'auto', snapToLines: true, lineAlign: 'start' });

  it('a lift puts the cue above the bottom share of the picture, 0 puts it back where it was', () => {
    const one = cue();
    liftCue(one, 0.2);
    expect(one).toEqual({ line: 80, snapToLines: false, lineAlign: 'end' });
    liftCue(one, 0.25);
    expect(one.line).toBe(75);
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
    expect(shown.cues.map((item) => item.line)).toEqual([80, 80]);
    expect(hidden.cues[0]!.line).toBe('auto');
    const late = cue();
    shown.activeCues = [late];
    liftCues([shown], 0.2, true);
    expect(late.line).toBe(80);
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
    expect(shown.cues[0]!.line).toBe(80);
    const late = { line: 'auto', snapToLines: true, lineAlign: 'start' };
    shown.activeCues = [late];
    video.dispatchEvent(new Event('timeupdate'));
    expect(late.line).toBe(80);
    engine.setSubtitleLift(0);
    expect(shown.cues[0]!.line).toBe('auto');
    engine.release();
  });
});
