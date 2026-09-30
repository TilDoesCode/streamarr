import { createRef } from 'react';
import { LibVlcPlayerView, type LibVlcPlayerViewRef, type MediaTracks } from 'expo-libvlc-player';
import { Platform } from 'react-native';

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

type VlcStats = { displayedPictures?: number; lostPictures?: number };
// getStats is added by patches/expo-libvlc-player (Android); elsewhere it is missing.
type VlcViewRef = LibVlcPlayerViewRef & { getStats?: () => Promise<VlcStats> };

/** Clock seconds without a new picture before libVLC's video output counts as stalled. */
const STALL_SECONDS = 3;
const MAX_RECOVERIES = 4;

type Props = {
  source: string | null;
  options: string[];
  tracks: { audio?: number; subtitle: number };
  /** Milliseconds; `:start-time` made libVLC report time and length relative to the start. */
  time?: number;
  nonce: number;
};

/** libVLC (Android) / VLCKit 4 (Apple) via expo-libvlc-player: the fallback engine. */
export class VlcEngine extends EngineBase implements PlayerEngine {
  readonly kind = 'vlc' as const;
  private readonly props = new PropsStore<Props>({
    source: null,
    options: [],
    tracks: { subtitle: -1 },
    nonce: 0,
  });
  private readonly view = createRef<VlcViewRef>();
  private raw: MediaTracks = { audio: [], video: [], subtitle: [] };
  private started = false;
  /** A pause before the first picture at the start position would leave frame 0 on screen. */
  private pendingPause = false;
  private onStopped: (() => void) | null = null;
  private seekGuard: { target: number; until: number } | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private stall = { pictures: -1, position: 0, recoveries: 0 };

  constructor(private readonly options: VlcOptions = {}) {
    super();
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
    this.emitTime(this.started ? reported : Math.max(reported, start));
  }

  /** libVLC can keep its clock running while the picture freezes (seen after seeks and fresh loads). */
  private async checkStall(): Promise<void> {
    const view = this.view.current;
    const { state, position } = this.getSnapshot();
    if (!view?.getStats || !this.started || state !== 'playing') {
      this.stall.pictures = -1;
      return;
    }
    const stats = await view.getStats().catch(() => null);
    const pictures = stats?.displayedPictures;
    if (!pictures || this.released) return;
    this.emit({
      type: 'stats',
      stats: { droppedFrames: stats.lostPictures, totalFrames: pictures },
    });
    const stall = this.stall;
    if (pictures !== stall.pictures || position < stall.position) {
      if (stall.pictures >= 0 && pictures !== stall.pictures) stall.recoveries = 0;
      stall.pictures = pictures;
      stall.position = position;
      return;
    }
    if (position - stall.position < STALL_SECONDS) return;
    this.recoverStall(position);
  }

  private recoverStall(position: number): void {
    const stall = this.stall;
    stall.recoveries += 1;
    stall.pictures = -1;
    if (stall.recoveries > MAX_RECOVERIES) {
      this.emit({ type: 'error', reason: 'vlc_video_stalled' });
      this.setState('error');
    } else if (stall.recoveries % 2 === 1 || !this.source) this.seek(position);
    else {
      const { recoveries } = stall;
      this.load({ ...this.source, startPosition: position });
      this.stall.recoveries = recoveries;
    }
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
    this.stall = { pictures: -1, position: 0, recoveries: 0 };
    if (!this.watchdog) this.watchdog = setInterval(() => void this.checkStall(), 1000);
    this.raw = { audio: [], video: [], subtitle: [] };
    this.props.set({
      source: source.uri,
      options: decodingOptions(this.options),
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
    this.stall.pictures = -1;
    this.emitTime(target);
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
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    super.release();
    this.props.set({ source: null });
  }
}
