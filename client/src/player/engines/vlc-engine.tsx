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

type Props = {
  source: string | null;
  options: string[];
  tracks: { audio?: number; subtitle: number };
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
  private readonly view = createRef<LibVlcPlayerViewRef>();
  private raw: MediaTracks = { audio: [], video: [], subtitle: [] };
  private started = false;
  private onStopped: (() => void) | null = null;

  constructor(private readonly options: VlcOptions = {}) {
    super();
  }

  readonly Surface = createPropsSurface(this.props, (props, style) =>
    this.renderView(props, style)
  );

  private renderView(props: Props, style: SurfaceProps['style']) {
    if (!props.source) return null;
    return (
      <LibVlcPlayerView
        key={props.nonce}
        ref={this.view}
        style={style}
        source={props.source}
        options={props.options}
        tracks={props.tracks}
        autoplay
        contentFit="contain"
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

  private onTime(position: number): void {
    const snapshot = this.getSnapshot();
    // The clock advancing is the closest observable to a first rendered frame in libVLC.
    if (!this.started && position > (this.source?.startPosition ?? 0) + 0.05) {
      this.started = true;
      this.emit({ type: 'firstFrame' });
    }
    this.emit({ type: 'time', position, duration: snapshot.duration });
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
    this.raw = { audio: [], video: [], subtitle: [] };
    const start = source.startPosition ? [`:start-time=${source.startPosition}`] : [];
    this.props.set({
      source: source.uri,
      options: [...decodingOptions(this.options), ...start],
      tracks: { subtitle: -1 },
      nonce: this.props.get().nonce + 1,
    });
  }

  play(): void {
    if (this.getSnapshot().state === 'ended' && this.source) {
      this.load({ ...this.source, startPosition: 0 });
      return;
    }
    void this.view.current?.play();
  }

  pause(): void {
    void this.view.current?.pause();
  }

  seek(position: number): void {
    void this.view.current?.seek(Math.max(0, position) * 1000, 'time');
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
