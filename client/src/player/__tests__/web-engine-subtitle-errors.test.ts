import type { EngineEvent } from '@/player/engines';
import { loadHls, WebEngine } from '@/player/engines/web-engine.web';
import { FakeHls, FakeVideoElement, HlsEvents } from '@/../jest/player/library-fakes';

jest.mock('hls.js', () => jest.requireActual('@/../jest/player/library-fakes').hlsJsModule());

async function hlsEngine() {
  const engine = new WebEngine();
  (engine as unknown as { attach(video: unknown): void }).attach(new FakeVideoElement());
  await loadHls();
  const events: EngineEvent[] = [];
  engine.subscribe((event) => events.push(event));
  engine.load({ uri: 'http://server.test/master.m3u8', kind: 'hls' });
  return { engine, events, hls: FakeHls.last };
}

describe('hls.js subtitle failures never stop the playback (C22, C23)', () => {
  it('a subtitle playlist or segment that fails is a subtitle error, even when hls.js calls it fatal', async () => {
    const { engine, events, hls } = await hlsEngine();
    hls.error('networkError', 'fragLoadError', { status: 404, frag: { type: 'subtitle' } });
    hls.error('networkError', 'subtitleTrackLoadTimeOut', { fatal: false });
    hls.error('networkError', 'subtitleTrackLoadError', { status: 500 });
    expect(events.filter((event) => event.type === 'error')).toEqual([]);
    expect(events.filter((event) => event.type === 'subtitleError')).toEqual([
      { type: 'subtitleError', code: 'unknown_subtitle_stream' },
      { type: 'subtitleError', code: 'subtitle_timeout' },
      { type: 'subtitleError', code: 'subtitle_unavailable' },
    ]);
    engine.release();
  });

  it('a WebVTT segment that does not parse is a subtitle error', async () => {
    const { engine, events, hls } = await hlsEngine();
    hls.trigger(HlsEvents.SUBTITLE_FRAG_PROCESSED, { success: true });
    hls.trigger(HlsEvents.SUBTITLE_FRAG_PROCESSED, { success: false, error: new Error('bad cue') });
    expect(events.filter((event) => event.type === 'subtitleError')).toEqual([
      { type: 'subtitleError', code: 'subtitle_unreadable' },
    ]);
    engine.release();
  });
});
