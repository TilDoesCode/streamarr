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

describe('iPhone Safari: only the video goes full screen (webkitEnterFullscreen, F8 verify V2)', () => {
  type AppleVideo = EventTarget & {
    webkitDisplayingFullscreen: boolean;
    webkitEnterFullscreen: jest.Mock;
    webkitExitFullscreen: jest.Mock;
  };

  function iPhone() {
    const video: AppleVideo = Object.assign(new EventTarget(), {
      webkitDisplayingFullscreen: false,
      webkitEnterFullscreen: jest.fn(() => void (video.webkitDisplayingFullscreen = true)),
      webkitExitFullscreen: jest.fn(() => void (video.webkitDisplayingFullscreen = false)),
    });
    const doc = Object.assign(new EventTarget(), {
      fullscreenElement: null,
      documentElement: {},
      querySelector: () => video,
    });
    class FakeVideoElement {}
    Object.assign(FakeVideoElement.prototype, { webkitEnterFullscreen: () => undefined });
    (globalThis as { HTMLVideoElement?: unknown }).HTMLVideoElement = FakeVideoElement;
    return { video, api: loadWith(doc as never), doc };
  }

  afterEach(() => {
    delete (globalThis as { HTMLVideoElement?: unknown }).HTMLVideoElement;
  });

  it('closing the player leaves the video full screen the player entered', () => {
    const { video, api } = iPhone();
    api.toggleFullscreen();
    expect(video.webkitEnterFullscreen).toHaveBeenCalledTimes(1);
    expect(api.isFullscreen()).toBe(true);
    api.exitPlayerFullscreen();
    expect(video.webkitExitFullscreen).toHaveBeenCalledTimes(1);
  });

  it('after the system Done button left it, closing the player does not touch full screen again', () => {
    const { video, api, doc } = iPhone();
    api.toggleFullscreen();
    video.webkitDisplayingFullscreen = false;
    doc.dispatchEvent(new Event('webkitendfullscreen'));
    // The viewer enters the video full screen again from the system controls of the same session.
    video.webkitDisplayingFullscreen = true;
    api.exitPlayerFullscreen();
    expect(video.webkitExitFullscreen).not.toHaveBeenCalled();
  });
});
