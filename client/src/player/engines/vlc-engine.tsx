import { createRef } from 'react';
import { LibVlcPlayerView, type LibVlcPlayerViewRef, type MediaTracks } from 'expo-libvlc-player';
import { Platform } from 'react-native';

import type { EngineHealth } from '../health/types';
import { effectiveMuted } from '../test-muted';
import { EngineBase, PropsStore } from './base';
import { createPropsSurface } from './props-surface';
import type { EngineSource, EngineTrack, PlayerEngine, SurfaceProps } from './types';

export type VlcOptions = {
  /** MediaCodec renders into libVLC's GL texture (zero copy); off copies decoded frames back first. */
  directRendering?: boolean;
};

// libVLC only uses Android MediaCodec when asked; `all` keeps its software decoders as the fallback.
function decodingOptions({ directRendering = false }: VlcOptions): string[] {
  if (Platform.OS !== 'android') return [];
  return [
    ':codec=mediacodec_ndk,mediacodec_jni,all',
    directRendering ? ':mediacodec-dr' : ':no-mediacodec-dr',
  ];
}

type VlcStats = {
  displayedPictures?: number;
  lostPictures?: number;
  decodedVideo?: number;
  decodedAudio?: number;
  playedAbuffers?: number;
  lostAbuffers?: number;
};
// getStats is added by patches/expo-libvlc-player (libVLC on Android, VLCKit statistics on Apple).
type VlcViewRef = LibVlcPlayerViewRef & { getStats?: () => Promise<VlcStats | null> };

/** Clock seconds of decoded but never displayed video before direct rendering is turned off (D23). */
const NO_PICTURE_SECONDS = 4;

type Props = {
  source: string | null;
  options: string[];
  tracks: { audio?: number; subtitle: number };
  /** Milliseconds; `:start-time` made libVLC report time and length relative to the start. */
  time?: number;
  nonce: number;
  mute: boolean;
};

const TIME_EVENT_MS = 250;

/** libVLC (Android) / VLCKit 4 (Apple) via expo-libvlc-player: the fallback engine. */
export class VlcEngine extends EngineBase implements PlayerEngine {
  readonly kind = 'vlc' as const;
  private readonly props = new PropsStore<Props>({
    source: null,
    options: [],
    tracks: { subtitle: -1 },
    nonce: 0,
    mute: effectiveMuted(false),
  });
  private readonly view = createRef<VlcViewRef>();
  private raw: MediaTracks = { audio: [], video: [], subtitle: [] };
  private started = false;
  /** A pause before the first picture at the start position would leave frame 0 on screen. */
  private pendingPause = false;
  private onStopped: (() => void) | null = null;
  private seekGuard: { target: number; until: number } | null = null;
  private timeAt = 0;
  /** MediaCodec direct rendering; turned off for good when it decodes without showing a picture. */
  private directRendering: boolean;

  constructor(options: VlcOptions = {}) {
    super();
    this.directRendering = !!options.directRendering;
  }

  readonly Surface = createPropsSurface(this.props, (props, style, fit) =>
    this.renderView(props, style, fit)
  );

  private renderView(props: Props, style: SurfaceProps['style'], fit: SurfaceProps['fit']) {
    if (!props.source) return null;
    return (
      <LibVlcPlayerView
        key={props.nonce}
        ref={this.view}
        style={style}
        source={props.source}
        options={props.options}
        tracks={props.tracks}
        time={props.time}
        mute={props.mute}
        autoplay
        contentFit={fit ?? 'contain'}
        onBuffering={() => {
          if (this.started) this.emit({ type: 'buffering', buffering: true });
        }}
        onPlaying={() => {
          if (this.started) this.emit({ type: 'buffering', buffering: false });
          this.setState('playing');
        }}
        onPaused={() => {
          this.setState('paused');
        }}
        onStopped={() => {
          if (this.onStopped) return this.onStopped();
          if (this.started && this.getSnapshot().state !== 'error') {
            this.setState('ended');
            this.emit({ type: 'ended' });
          }
        }}
        onEncounteredError={(error) => {
          this.emit({ type: 'error', reason: error.message });
          this.setState('error');
        }}
        onDialogDisplay={(dialog) => {
          // libVLC waits for an answer (certificate, login, codec question): nobody answers on a TV.
          void this.view.current?.dismiss().catch(() => undefined);
          this.emit({
            type: 'error',
            reason: `vlc_dialog ${dialog.type}: ${dialog.title} ${dialog.text}`.trim(),
          });
          this.setState('error');
        }}
        onTimeChanged={(time) => this.onTime(time.value / 1000)}
        onFirstPlay={(info) => {
          this.emit({
            type: 'time',
            position: this.getSnapshot().position,
            duration: info.media.length / 1000,
          });
          this.publishTracks(info.video.width, info.video.height);
        }}
        onESAdded={(tracks) => {
          this.raw = tracks;
          this.publishTracks();
        }}
      />
    );
  }

  private onTime(reported: number): void {
    const guard = this.seekGuard;
    // libVLC keeps reporting the pre-seek time for a moment; those events would move the clock back.
    if (
      guard &&
      Date.now() < guard.until &&
      (reported < guard.target - 0.5 || reported > guard.target + 3)
    )
      return;
    const start = this.source?.startPosition ?? 0;
    // The clock advancing is the closest observable to a first rendered frame in libVLC.
    if (!this.started && reported > start + 0.05) {
      this.started = true;
      this.emit({ type: 'firstFrame' });
      if (this.pendingPause) {
        this.pendingPause = false;
        void this.view.current?.pause();
      }
    }
    // libVLC reports time unthrottled; the clock needs at most four updates a second.
    const now = Date.now();
    const seeking = !!guard && now < guard.until;
    if (this.started && !seeking && now - this.timeAt < TIME_EVENT_MS) return;
    this.timeAt = now;
    this.emitTime(this.started ? reported : Math.max(reported, start));
  }

  /** libVLC/VLCKit statistics in the one health shape; the controller's watchdog judges them (D23–D25). */
  async readHealth(): Promise<EngineHealth> {
    const view = this.view.current;
    if (!view?.getStats || this.released) return {};
    const stats = await view.getStats().catch(() => null);
    if (!stats || this.released || stats.displayedPictures === undefined) return {};
    const { displayedPictures: pictures = 0, decodedVideo = 0, decodedAudio = 0 } = stats;
    this.emit({
      type: 'stats',
      stats: { droppedFrames: stats.lostPictures, totalFrames: pictures },
    });
    this.checkDirectRendering(pictures, decodedVideo);
    return {
      framesPresented: pictures,
      framesDropped: stats.lostPictures,
      framesDecoded: decodedVideo,
      // Audio counts only once libVLC decodes audio: decoded but never played is silence.
      audioProgress: decodedAudio > 0 ? (stats.playedAbuffers ?? 0) : undefined,
      readyForDisplay: this.started ? pictures > 0 : undefined,
      hasVideoTrack: decodedVideo > 0 ? true : undefined,
      hasAudioTrack: decodedAudio > 0 ? true : undefined,
    };
  }

  /** MediaCodec direct rendering can decode into a texture nobody shows (M3.1 A1): reload without it once. */
  private checkDirectRendering(pictures: number, decoded: number): void {
    const source = this.source;
    const { state, position } = this.getSnapshot();
    if (!this.directRendering || Platform.OS !== 'android' || !source || state !== 'playing')
      return;
    if (pictures > 0 || decoded === 0) return;
    if (position - (source.startPosition ?? 0) < NO_PICTURE_SECONDS) return;
    this.directRendering = false;
    this.load({ ...source, startPosition: position });
  }

  private emitTime(position: number): void {
    this.emit({ type: 'time', position, duration: this.getSnapshot().duration });
  }

  private publishTracks(width?: number, height?: number): void {
    const props = this.props.get();
    // Android reports libVLC's own selection (patches/expo-libvlc-player); elsewhere the requested track stands in.
    const map = (list: { id: number; name: string; selected?: boolean }[], requested?: number) =>
      list
        .filter((track) => track.id >= 0)
        .map<EngineTrack>((track) => ({
          id: String(track.id),
          label: track.name,
          selected: track.selected ?? requested === track.id,
        }));
    const previous = this.getSnapshot().tracks.video;
    this.emit({
      type: 'tracks',
      tracks: {
        audio: map(this.raw.audio, props.tracks.audio ?? 0),
        subtitles: map(this.raw.subtitle, props.tracks.subtitle),
        video: width ? { width, height } : previous,
      },
    });
  }

  load(source: EngineSource): void {
    this.resetForLoad(source);
    this.started = false;
    this.pendingPause = false;
    this.seekGuard = null;
    this.setState('loading');
    this.raw = { audio: [], video: [], subtitle: [] };
    this.props.set({
      source: source.uri,
      options: decodingOptions({ directRendering: this.directRendering }),
      tracks: { subtitle: -1 },
      time: source.startPosition ? Math.round(source.startPosition * 1000) : undefined,
      nonce: this.props.get().nonce + 1,
    });
  }

  play(): void {
    this.pendingPause = false;
    if (this.getSnapshot().state === 'ended' && this.source) {
      this.load({ ...this.source, startPosition: 0 });
      return;
    }
    void this.view.current?.play();
  }

  pause(): void {
    if (!this.started && this.props.get().source) {
      this.pendingPause = true;
      return;
    }
    void this.view.current?.pause();
  }

  seek(position: number): void {
    const target = Math.max(0, position);
    void this.view.current?.seek(target * 1000, 'time');
    // No time event follows a seek while paused, so publish the target right away.
    this.seekGuard = { target, until: Date.now() + 2000 };
    this.emitTime(target);
  }

  setMuted(muted: boolean): void {
    this.props.set({ mute: effectiveMuted(muted) });
  }

  setAudioTrack(id: string): void {
    this.props.set({ tracks: { ...this.props.get().tracks, audio: Number(id) } });
    this.publishTracks();
  }

  setSubtitleTrack(id: string | null): void {
    this.props.set({
      tracks: { ...this.props.get().tracks, subtitle: id === null ? -1 : Number(id) },
    });
    this.publishTracks();
  }

  /** Releasing a playing libVLC player from the view's teardown deadlocked the UI thread (ANR) in M3.1. */
  async shutdown(): Promise<void> {
    const view = this.view.current;
    if (!view || !this.props.get().source) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 3000);
      this.onStopped = () => {
        clearTimeout(timer);
        resolve();
      };
      void view.stop().catch(() => resolve());
    });
    this.onStopped = null;
  }

  release(): void {
    super.release();
    this.props.set({ source: null });
  }
}
