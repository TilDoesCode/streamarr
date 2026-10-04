import { loadHls, WebEngine } from '@/player/engines/web-engine.web';

const created: { source?: string; attached: boolean }[] = [];

jest.mock('hls.js', () => ({
  __esModule: true,
  default: function Hls() {
    const hls = {
      attached: false,
      source: undefined as string | undefined,
      subtitleDisplay: false,
      on() {},
      loadSource(uri: string) {
        hls.source = uri;
      },
      attachMedia() {
        hls.attached = true;
      },
      destroy() {},
    };
    created.push(hls);
    return hls;
  },
  Events: {},
  ErrorTypes: {},
}));

const engines: WebEngine[] = [];
afterEach(() => engines.splice(0).forEach((engine) => engine.release()));

function fakeVideo() {
  const target = () => Object.assign(new EventTarget(), { length: 0 });
  return Object.assign(new EventTarget(), {
    textTracks: target(),
    audioTracks: target(),
    muted: false,
    play: jest.fn(async () => undefined),
    pause: jest.fn(),
    load: jest.fn(),
    removeAttribute: jest.fn(),
  });
}

it('starts hls.js only after its chunk loaded, with the latest source (web bundle without hls.js)', async () => {
  const engine = new WebEngine();
  engines.push(engine);
  expect(engine.mode).toBe('hls.js');
  (engine as unknown as { attach(video: unknown): void }).attach(fakeVideo());
  engine.load({ uri: 'http://server.test/a/master.m3u8', kind: 'hls' });
  engine.load({ uri: 'http://server.test/b/master.m3u8', kind: 'hls' });
  expect(created).toHaveLength(0);
  await loadHls();
  await Promise.resolve();
  expect(created).toHaveLength(1);
  expect(created[0]).toMatchObject({ attached: true, source: 'http://server.test/b/master.m3u8' });
  engine.load({ uri: 'http://server.test/c/master.m3u8', kind: 'hls' });
  expect(created).toHaveLength(2);
  expect(created[1]).toMatchObject({ attached: true, source: 'http://server.test/c/master.m3u8' });
});

it('drops a deferred start when the engine is released first', async () => {
  const before = created.length;
  const engine = new WebEngine();
  (engine as unknown as { attach(video: unknown): void }).attach(fakeVideo());
  engine.release();
  await loadHls();
  expect(created).toHaveLength(before);
});
