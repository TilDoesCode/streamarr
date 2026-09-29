import { EngineBase } from '../engines/base';
import type { EngineEvent, EngineSource, PlayerEngine, SurfaceProps } from '../engines/types';
import { MetricsRecorder } from '../metrics';

class FakeEngine extends EngineBase implements PlayerEngine {
  readonly kind = 'expo-video' as const;
  readonly Surface = (_props: SurfaceProps) => null;
  load(source: EngineSource) {
    this.resetForLoad(source);
  }
  play() {}
  pause() {}
  seek() {}
  setAudioTrack() {}
  setSubtitleTrack() {}
  fire(event: EngineEvent) {
    this.emit(event);
  }
}

describe('MetricsRecorder', () => {
  let now = 0;
  const clock = () => now;

  it('measures first frame, start-up, seeks, rebuffers and confirmed track switches', () => {
    const engine = new FakeEngine();
    const recorder = new MetricsRecorder(engine, clock);
    now = 1000;
    recorder.markLoad(0);
    engine.load({ uri: 'x', kind: 'progressive' });
    now = 1600;
    engine.fire({ type: 'firstFrame' });
    engine.fire({ type: 'state', state: 'playing' });
    now = 2000;
    engine.fire({ type: 'time', position: 0.1, duration: 100 });
    now = 2150;
    engine.fire({ type: 'time', position: 0.3, duration: 100 });
    expect(recorder.metrics).toMatchObject({ ttffMs: 600, startupMs: 900 });

    now = 5000;
    recorder.markSeek(60);
    engine.fire({ type: 'buffering', buffering: true });
    now = 5500;
    engine.fire({ type: 'time', position: 60, duration: 100 });
    engine.fire({ type: 'buffering', buffering: false });
    now = 6000;
    engine.fire({ type: 'time', position: 60.3, duration: 100 });
    expect(recorder.metrics.seeks[0]).toEqual({ from: 0.3, target: 60, ms: 750 });
    expect(recorder.metrics.rebuffers).toBe(0);

    now = 7000;
    engine.fire({ type: 'buffering', buffering: true });
    now = 7400;
    engine.fire({ type: 'buffering', buffering: false });
    expect(recorder.metrics).toMatchObject({ rebuffers: 1, rebufferMs: 400 });

    now = 8000;
    recorder.markSwitch('audio', 'a1', 'Deutsch', 'engine');
    now = 8120;
    engine.fire({
      type: 'tracks',
      tracks: {
        audio: [
          { id: 'a0', label: 'English', selected: false },
          { id: 'a1', label: 'Deutsch', selected: true },
        ],
        subtitles: [],
      },
    });
    expect(recorder.metrics.switches[0]).toEqual({
      kind: 'audio',
      label: 'Deutsch',
      via: 'engine',
      ms: 120,
    });
    recorder.dispose();
  });

  it('keeps the last ten key events', () => {
    const recorder = new MetricsRecorder(new FakeEngine(), clock);
    for (let index = 0; index < 12; index++) recorder.markKey('right', 'forward30');
    expect(recorder.metrics.keys).toHaveLength(10);
  });

  it('keeps the most tracks an engine listed and reports state changes', () => {
    const engine = new FakeEngine();
    const recorder = new MetricsRecorder(engine, clock);
    const changes = jest.fn();
    recorder.onChange(changes);
    const track = (id: string) => ({ id, label: id, selected: false });
    engine.fire({
      type: 'tracks',
      tracks: { audio: [track('a0'), track('a1')], subtitles: [track('s0')] },
    });
    engine.fire({ type: 'tracks', tracks: { audio: [], subtitles: [] } });
    expect(recorder.metrics).toMatchObject({ audioTracks: 2, subtitleTracks: 1 });
    changes.mockClear();
    engine.fire({ type: 'state', state: 'paused' });
    expect(changes).toHaveBeenCalledTimes(1);
  });
});
