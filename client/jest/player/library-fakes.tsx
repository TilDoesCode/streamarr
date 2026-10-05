import { forwardRef, useImperativeHandle } from 'react';

type Handler = (...args: unknown[]) => void;

/** hls.js event names and error types the web engine reads (values as in hls.js). */
export const HlsEvents = {
  MANIFEST_PARSED: 'hlsManifestParsed',
  AUDIO_TRACKS_UPDATED: 'hlsAudioTracksUpdated',
  AUDIO_TRACK_SWITCHED: 'hlsAudioTrackSwitched',
  SUBTITLE_TRACKS_UPDATED: 'hlsSubtitleTracksUpdated',
  SUBTITLE_TRACK_SWITCH: 'hlsSubtitleTrackSwitch',
  SUBTITLE_FRAG_PROCESSED: 'hlsSubtitleFragProcessed',
  FRAG_LOADED: 'hlsFragLoaded',
  ERROR: 'hlsError',
} as const;
export const HlsErrorTypes = {
  NETWORK_ERROR: 'networkError',
  MEDIA_ERROR: 'mediaError',
  KEY_SYSTEM_ERROR: 'keySystemError',
  MUX_ERROR: 'muxError',
  OTHER_ERROR: 'otherError',
} as const;
export type HlsErrorType = (typeof HlsErrorTypes)[keyof typeof HlsErrorTypes];

/** hls.js with every event and error (type, details, fatal, HTTP status) under test control. */
export class FakeHls {
  static instances: FakeHls[] = [];
  source?: string;
  media?: unknown;
  audioTracks: unknown[] = [];
  subtitleTracks: unknown[] = [];
  audioTrack = -1;
  subtitleTrack = -1;
  subtitleDisplay = true;
  bandwidthEstimate = 0;
  recoverMediaError = jest.fn();
  swapAudioCodec = jest.fn();
  /** Loading runs until `stopLoad`; `startLoad` resumes it. */
  loading = true;
  stopLoad = jest.fn(() => void (this.loading = false));
  startLoad = jest.fn(() => void (this.loading = true));
  destroy = jest.fn();
  private handlers = new Map<string, Handler[]>();

  constructor(readonly config: Record<string, unknown> = {}) {
    FakeHls.instances.push(this);
  }

  static get last(): FakeHls {
    const hls = FakeHls.instances.at(-1);
    if (!hls) throw new Error('no hls.js instance yet');
    return hls;
  }

  on(event: string, handler: Handler): void {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
  }

  off(event: string, handler: Handler): void {
    this.handlers.set(
      event,
      (this.handlers.get(event) ?? []).filter((entry) => entry !== handler)
    );
  }

  loadSource(uri: string): void {
    this.source = uri;
  }

  attachMedia(media: unknown): void {
    this.media = media;
  }

  trigger(event: string, data: Record<string, unknown> = {}): void {
    for (const handler of this.handlers.get(event) ?? []) handler(event, data);
  }

  /** An `ERROR` event; `status` becomes `response.code` like a failed loader. */
  error(
    type: HlsErrorType,
    details: string,
    {
      fatal = true,
      status,
      frag,
      retryAfter,
      sourceBufferName,
    }: {
      fatal?: boolean;
      status?: number;
      frag?: { type: string; sn?: number | string; level?: number };
      /** Seconds in the failed answer's `Retry-After` header (read from an XHR like hls.js passes it). */
      retryAfter?: number;
      sourceBufferName?: string;
    } = {}
  ): void {
    this.trigger(HlsEvents.ERROR, {
      type,
      details,
      fatal,
      frag,
      sourceBufferName,
      response: status === undefined ? undefined : { code: status },
      networkDetails:
        retryAfter === undefined
          ? undefined
          : {
              getResponseHeader: (name: string) =>
                name === 'Retry-After' ? `${retryAfter}` : null,
            },
    });
  }
}

/** `jest.mock('hls.js', () => jest.requireActual('@/../jest/player/library-fakes').hlsJsModule())` */
export function hlsJsModule() {
  return { __esModule: true, default: FakeHls, Events: HlsEvents, ErrorTypes: HlsErrorTypes };
}

/** hls.js's default loader as the web engine wraps it: `fail()` answers the last request with an HTTP status. */
export class FakeHlsLoader {
  static last: FakeHlsLoader | null = null;
  callbacks: {
    onSuccess: (...args: unknown[]) => void;
    onError: (error: unknown, context: unknown, details: unknown, stats: unknown) => void;
  } | null = null;

  constructor() {
    FakeHlsLoader.last = this;
  }

  load(_context: unknown, _config: unknown, callbacks: FakeHlsLoader['callbacks']): void {
    this.callbacks = callbacks;
  }

  fail(code: number): void {
    this.callbacks?.onError({ code, text: '' }, {}, null, {});
  }

  succeed(): void {
    this.callbacks?.onSuccess({}, {}, {}, null);
  }
}

/** A `<video>` element: media errors 1–4, waiting/stalled, frame callbacks, playback quality, autoplay refusal. */
export class FakeVideoElement extends EventTarget {
  currentTime = 0;
  duration = 600;
  paused = true;
  ended = false;
  muted = false;
  seeking = false;
  readyState = 4;
  videoWidth = 1920;
  videoHeight = 1080;
  src = '';
  error: { code: number; message: string } | null = null;
  buffered = { length: 0, start: () => 0, end: () => 0 };
  textTracks = Object.assign(new EventTarget(), { length: 0 });
  audioTracks = Object.assign(new EventTarget(), { length: 0 });
  /** `NotAllowedError` refuses `play()` (autoplay policy); `mutedOnly` allows it only when muted. */
  autoplay: 'allowed' | 'mutedOnly' | 'blocked' = 'allowed';
  presentedFrames = 0;
  droppedFrames = 0;
  webkitAudioDecodedByteCount = 0;
  private frameCallbacks: ((now: number, metadata: { presentedFrames: number }) => void)[] = [];

  play = jest.fn(async () => {
    if (this.autoplay === 'blocked' || (this.autoplay === 'mutedOnly' && !this.muted))
      throw Object.assign(new Error('play() is not allowed'), { name: 'NotAllowedError' });
    this.paused = false;
    this.dispatchEvent(new Event('play'));
    this.dispatchEvent(new Event('playing'));
  });
  pause = jest.fn(() => {
    this.paused = true;
    this.dispatchEvent(new Event('pause'));
  });
  load = jest.fn();
  removeAttribute = jest.fn();

  requestVideoFrameCallback(
    callback: (now: number, metadata: { presentedFrames: number }) => void
  ) {
    this.frameCallbacks.push(callback);
    return this.frameCallbacks.length;
  }

  cancelVideoFrameCallback(): void {}

  getVideoPlaybackQuality() {
    return {
      totalVideoFrames: this.presentedFrames + this.droppedFrames,
      droppedVideoFrames: this.droppedFrames,
    };
  }

  /** Presents `count` frames and calls the pending frame callbacks. */
  present(count = 1): void {
    this.presentedFrames += count;
    const callbacks = this.frameCallbacks.splice(0);
    for (const callback of callbacks) callback(0, { presentedFrames: this.presentedFrames });
  }

  /** Clock tick with a `timeupdate` event. */
  tick(seconds: number): void {
    this.currentTime = seconds;
    this.dispatchEvent(new Event('timeupdate'));
  }

  /** MediaError 1 aborted · 2 network · 3 decode · 4 source not supported. */
  fail(code: 1 | 2 | 3 | 4, message = ''): void {
    this.error = { code, message };
    this.dispatchEvent(new Event('error'));
  }

  fire(type: 'waiting' | 'stalled' | 'suspend' | 'canplay' | 'ended' | 'loadedmetadata'): void {
    this.dispatchEvent(new Event(type));
  }
}

type ExpoListener = (event: Record<string, unknown>) => void;

/** expo-video's player: status, errors (incl. the patched `{domain, code, httpStatus}`), counters, system pauses. */
export class FakeExpoPlayer {
  static instances: FakeExpoPlayer[] = [];
  status: 'idle' | 'loading' | 'readyToPlay' | 'error' = 'idle';
  playing = false;
  muted = false;
  duration = 600;
  time = 0;
  bufferedPosition = 0;
  timeUpdateEventInterval = 0;
  keepScreenOnWhilePlaying = false;
  allowsExternalPlayback = false;
  isExternalPlaybackActive = false;
  availableAudioTracks: unknown[] = [];
  availableSubtitleTracks: unknown[] = [];
  audioTrack: unknown = null;
  subtitleTrack: unknown = null;
  videoTrack: unknown = null;
  /** What the patched `readHealthAsync` answers (null = an unpatched build without the method). */
  health: Record<string, number | boolean | string | null> | null = {};
  readonly calls: string[] = [];
  private listeners = new Map<string, ExpoListener[]>();
  private replace: { resolve: () => void; reject: (error: Error) => void } | null = null;

  constructor() {
    FakeExpoPlayer.instances.push(this);
  }

  static get last(): FakeExpoPlayer {
    const player = FakeExpoPlayer.instances.at(-1);
    if (!player) throw new Error('no expo-video player yet');
    return player;
  }

  get currentTime(): number {
    return this.time;
  }

  set currentTime(value: number) {
    this.calls.push(`seek ${value}`);
    this.time = value;
  }

  addListener(name: string, listener: ExpoListener) {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
    return {
      remove: () =>
        this.listeners.set(
          name,
          (this.listeners.get(name) ?? []).filter((entry) => entry !== listener)
        ),
    };
  }

  replaceAsync(): Promise<void> {
    this.calls.push('replace');
    return new Promise((resolve, reject) => (this.replace = { resolve, reject }));
  }

  /** Settles the pending `replaceAsync`. */
  loaded(error?: Error): void {
    if (error) this.replace?.reject(error);
    else this.replace?.resolve();
    this.replace = null;
  }

  play(): void {
    this.calls.push('play');
    this.playing = true;
  }

  pause(): void {
    this.calls.push('pause');
    this.playing = false;
  }

  release(): void {
    this.calls.push('release');
  }

  fire(name: string, event: Record<string, unknown> = {}): void {
    for (const listener of this.listeners.get(name) ?? []) listener(event);
  }

  setStatus(status: FakeExpoPlayer['status'], error?: Record<string, unknown>): void {
    this.status = status;
    this.fire('statusChange', { status, error });
  }

  ready(): void {
    this.setStatus('readyToPlay');
  }

  /** A failed item: `message` is what expo-video passes today; the rest is the S6 patch. */
  failWith(error: {
    message: string;
    errorCodeName?: string;
    mimeType?: string;
    domain?: string;
    code?: number;
    underlyingDomain?: string;
    underlyingCode?: number;
    errorLog?: string;
    httpStatus?: number;
  }): void {
    this.setStatus('error', error);
  }

  readHealthAsync?: (withFrames?: boolean) => Promise<FakeExpoPlayer['health']> = async () =>
    this.health;

  /** The S6 patch's system pause/resume (`call`, `otherAudio`, `headphones`, `locked`, `airplayLost`, `remote`, `resume`). */
  system(paused: boolean, cause: string): void {
    this.fire('systemPlayback', { paused, cause });
    if (paused && cause !== 'resume') this.setPlaying(false);
  }

  /** AirPlay took over (or gave back) the picture. */
  setExternal(active: boolean): void {
    this.isExternalPlaybackActive = active;
    this.fire('isExternalPlaybackActiveChange', { isExternalPlaybackActive: active });
  }

  /** The OS or the viewer outside the app paused or resumed. */
  setPlaying(isPlaying: boolean): void {
    this.playing = isPlaying;
    this.fire('playingChange', { isPlaying });
  }

  tick(seconds: number): void {
    this.time = seconds;
    this.fire('timeUpdate', { currentTime: seconds, bufferedPosition: this.bufferedPosition });
  }

  toEnd(): void {
    this.fire('playToEnd');
  }
}

/** The props of the last rendered `VideoView` (PiP and first-frame callbacks). */
export const expoVideoView: {
  props: Record<string, unknown> | null;
  ref: Record<'startPictureInPicture' | 'stopPictureInPicture', jest.Mock>;
} = {
  props: null,
  ref: {
    startPictureInPicture: jest.fn(async () => undefined),
    stopPictureInPicture: jest.fn(async () => undefined),
  },
};

const VideoView = forwardRef<unknown, Record<string, unknown>>(function VideoView(props, ref) {
  expoVideoView.props = props;
  useImperativeHandle(ref, () => expoVideoView.ref);
  return null;
});

/** `jest.mock('expo-video', () => jest.requireActual('@/../jest/player/library-fakes').expoVideoModule())` */
export function expoVideoModule() {
  return {
    createVideoPlayer: () => new FakeExpoPlayer(),
    VideoView,
    isPictureInPictureSupported: () => false,
  };
}

type VlcProps = Record<string, ((...args: never[]) => unknown) | unknown>;

type FakeVlc = {
  props: VlcProps | null;
  mounts: number;
  stats: Record<string, number> | null;
  ref: Record<'getStats' | 'seek' | 'play' | 'pause' | 'stop' | 'dismiss', jest.Mock>;
  reset(): void;
  call(name: string, payload?: unknown): void;
};

/** expo-libvlc-player's view: every callback prop and the ref methods (incl. the patched `getStats`). */
export const FakeVlcView: FakeVlc = {
  props: null as VlcProps | null,
  mounts: 0,
  stats: null as Record<string, number> | null,
  ref: {
    getStats: jest.fn(async () => FakeVlcView.stats),
    seek: jest.fn(async () => undefined),
    play: jest.fn(async () => undefined),
    pause: jest.fn(async () => undefined),
    stop: jest.fn(async () => undefined),
    dismiss: jest.fn(async () => undefined),
  },
  reset(): void {
    this.props = null;
    this.mounts = 0;
    this.stats = null;
  },
  /** Calls a callback prop like the native view, e.g. `call('onEncounteredError', { message })`. */
  call(name: string, payload?: unknown): void {
    const callback = this.props?.[name];
    if (typeof callback !== 'function') throw new Error(`no ${name} on the VLC view`);
    (callback as (value: unknown) => void)(payload);
  },
};

const LibVlcPlayerView = forwardRef<FakeVlc['ref'], VlcProps>(
  function LibVlcPlayerView(props, ref) {
    FakeVlcView.props = props;
    useImperativeHandle(ref, () => {
      FakeVlcView.mounts += 1;
      return FakeVlcView.ref;
    });
    return null;
  }
);

/** `jest.mock('expo-libvlc-player', () => jest.requireActual('@/../jest/player/library-fakes').vlcModule())` */
export function vlcModule() {
  return { LibVlcPlayerView };
}
