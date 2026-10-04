type Doc = EventTarget & {
  fullscreenElement: object | null;
  documentElement: { requestFullscreen: jest.Mock };
  exitFullscreen: jest.Mock;
  querySelector: () => null;
};

function loadWith(doc: Doc) {
  (globalThis as { document?: unknown }).document = doc;
  let api!: typeof import('../fullscreen.web');
  jest.isolateModules(() => {
    api = jest.requireActual('../fullscreen.web');
  });
  return api;
}

function fakeDocument(): Doc {
  const doc: Doc = Object.assign(new EventTarget(), {
    fullscreenElement: null as object | null,
    documentElement: {
      requestFullscreen: jest.fn(async () => {
        doc.fullscreenElement = doc.documentElement;
      }),
    },
    exitFullscreen: jest.fn(async () => {
      doc.fullscreenElement = null;
    }),
    querySelector: () => null,
  });
  return doc;
}

afterEach(() => {
  delete (globalThis as { document?: unknown }).document;
});

describe('player full screen on close (iPad Safari stayed in element full screen)', () => {
  it('leaves the full screen the player entered', async () => {
    const doc = fakeDocument();
    const { toggleFullscreen, exitPlayerFullscreen } = loadWith(doc);
    toggleFullscreen();
    await Promise.resolve();
    expect(doc.fullscreenElement).not.toBeNull();
    exitPlayerFullscreen();
    expect(doc.exitFullscreen).toHaveBeenCalledTimes(1);
  });

  it('keeps a full screen the viewer entered outside the player', () => {
    const doc = fakeDocument();
    doc.fullscreenElement = doc.documentElement;
    const { exitPlayerFullscreen } = loadWith(doc);
    exitPlayerFullscreen();
    expect(doc.exitFullscreen).not.toHaveBeenCalled();
  });

  it.each([
    ['Esc / system UI', (doc: Doc) => void (doc.fullscreenElement = null)],
    ['the player toggle', (doc: Doc) => void doc.exitFullscreen()],
  ])(
    'after leaving via %s, a full screen the viewer enters later stays on close (verify V1)',
    async (_how, leave) => {
      const doc = fakeDocument();
      const { toggleFullscreen, exitPlayerFullscreen } = loadWith(doc);
      toggleFullscreen();
      await Promise.resolve();
      leave(doc);
      await Promise.resolve();
      doc.dispatchEvent(new Event('fullscreenchange'));
      // The viewer enters full screen through Safari's own menu during the same player session.
      doc.fullscreenElement = doc.documentElement;
      doc.dispatchEvent(new Event('fullscreenchange'));
      doc.exitFullscreen.mockClear();
      exitPlayerFullscreen();
      expect(doc.exitFullscreen).not.toHaveBeenCalled();
    }
  );
});
