import { createRef, memo, type ComponentType, type RefObject } from 'react';
import { Platform } from 'react-native';
import {
  createVideoPlayer,
  VideoView,
  type AudioTrack,
  type SubtitleTrack,
  type VideoPlayer,
} from 'expo-video';

import { effectiveMuted } from '../test-muted';
import { EngineBase } from './base';
import type { EngineSource, EngineTrack, PlayerEngine, SurfaceProps } from './types';

type Subscription = { remove(): void };

function sameTrack(a: AudioTrack | SubtitleTrack | null, b: AudioTrack | SubtitleTrack): boolean {
  if (!a) return false;
  if (a.id !== undefined && b.id !== undefined) return a.id === b.id;
  return a.language === b.language && a.label === b.label;
}

// Picture-in-picture and AirPlay on phones/tablets; TV has neither.
const PIP = (Platform.OS === 'android' || Platform.OS === 'ios') && !Platform.isTV;
const AIRPLAY = Platform.OS === 'ios' && !Platform.isTV;

type SurfaceHooks = {
  onFirstFrame: () => void;
  onPip: (active: boolean) => void;
  view: RefObject<VideoView | null>;
};

function createExpoVideoSurface(
  player: VideoPlayer,
  { onFirstFrame, onPip, view }: SurfaceHooks
): ComponentType<SurfaceProps> {
  function ExpoVideoSurface({ style, fit }: SurfaceProps) {
    return (
      <VideoView
        ref={view}
        player={player}
        style={style}
        nativeControls={false}
        allowsVideoFrameAnalysis={false}
        contentFit={fit ?? 'contain'}
        allowsPictureInPicture={PIP}
        startsPictureInPictureAutomatically={PIP}
        onPictureInPictureStart={() => onPip(true)}
        onPictureInPictureStop={() => onPip(false)}
        onFirstFrameRender={onFirstFrame}
      />
    );
  }
  return memo(ExpoVideoSurface);
}

/** expo-video (ExoPlayer on Android, AVPlayer on Apple). */
export class ExpoVideoEngine extends EngineBase implements PlayerEngine {
  readonly kind = 'expo-video' as const;
  private readonly player: VideoPlayer = createVideoPlayer(null);
  private readonly subscriptions: Subscription[] = [];
  private ready = false;

  constructor() {
    super();
    const player = this.player;
    player.timeUpdateEventInterval = 0.1;
    player.keepScreenOnWhilePlaying = true;
    player.muted = effectiveMuted(false);
    if (AIRPLAY) player.allowsExternalPlayback = true;
    this.subscriptions.push(
      player.addListener('statusChange', ({ status, error }) => {
        if (status === 'error') {
          this.emit({ type: 'error', reason: error?.message ?? 'expo_video_error' });
          this.setState('error');
        } else if (status === 'loading') {
          if (this.ready) this.emit({ type: 'buffering', buffering: true });
          this.setState(this.ready ? 'buffering' : 'loading');
        } else if (status === 'readyToPlay') {
          if (this.ready) this.emit({ type: 'buffering', buffering: false });
          this.ready = true;
          this.setState(player.playing ? 'playing' : 'paused');
        }
      }),
      player.addListener('playingChange', ({ isPlaying }) => {
        if (this.getSnapshot().state === 'ended' && !isPlaying) return;
        if (player.status === 'readyToPlay') this.setState(isPlaying ? 'playing' : 'paused');
      }),
      player.addListener('timeUpdate', ({ currentTime, bufferedPosition }) =>
        this.emit({
          type: 'time',
          position: currentTime,
          duration: player.duration,
          buffered: bufferedPosition,
        })
      ),
      player.addListener('playToEnd', () => {
        this.setState('ended');
        this.emit({ type: 'ended' });
      }),
      player.addListener('sourceLoad', () => this.emitTracks()),
      player.addListener('availableAudioTracksChange', () => this.emitTracks()),
      player.addListener('audioTrackChange', () => this.emitTracks()),
      player.addListener('availableSubtitleTracksChange', () => this.emitTracks()),
      player.addListener('subtitleTrackChange', () => this.emitTracks()),
      player.addListener('videoTrackChange', () => this.emitTracks())
    );
  }

  readonly supportsPictureInPicture = PIP;
  readonly supportsAirPlay = AIRPLAY;
  private readonly view = createRef<VideoView>();
  readonly Surface = createExpoVideoSurface(this.player, {
    onFirstFrame: () => this.emit({ type: 'firstFrame' }),
    onPip: (active) => this.emit({ type: 'pip', active }),
    view: this.view,
  });

  startPictureInPicture(): void {
    if (PIP) void this.view.current?.startPictureInPicture().catch(() => undefined);
  }

  private emitTracks(): void {
    try {
      this.readTracks();
    } catch {
      // expo-video's track lists can throw ConcurrentModificationException while ExoPlayer updates them.
      setTimeout(() => this.readTracks(), 100);
    }
  }

  private readTracks(): void {
    const player = this.player;
    const audio: EngineTrack[] = player.availableAudioTracks.map((track, index) => ({
      id: `a${index}`,
      label: track.label || track.name || track.language || `#${index + 1}`,
      language: track.language || undefined,
      selected: sameTrack(player.audioTrack, track),
    }));
    const subtitles: EngineTrack[] = player.availableSubtitleTracks.map((track, index) => ({
      id: `s${index}`,
      label: track.label || track.name || track.language || `#${index + 1}`,
      language: track.language || undefined,
      selected: sameTrack(player.subtitleTrack, track),
    }));
    const video = player.videoTrack;
    this.emit({
      type: 'tracks',
      tracks: {
        audio,
        subtitles,
        video: video
          ? {
              width: video.size.width,
              height: video.size.height,
              codec: video.mimeType ?? undefined,
              bitrate: video.bitrate ?? undefined,
              frameRate: video.frameRate ?? undefined,
              range: video.videoRange,
            }
          : undefined,
      },
    });
  }

  load(source: EngineSource): void {
    this.resetForLoad(source);
    this.ready = false;
    const player = this.player;
    void player
      .replaceAsync({ uri: source.uri, contentType: source.kind === 'hls' ? 'hls' : 'progressive' })
      .then(() => {
        if (this.released || this.source !== source) return;
        if (source.startPosition) player.currentTime = source.startPosition;
        player.play();
      })
      .catch((error: Error) => this.emit({ type: 'error', reason: error.message }));
  }

  play(): void {
    if (this.getSnapshot().state === 'ended') this.player.currentTime = 0;
    this.player.play();
  }

  setMuted(muted: boolean): void {
    this.player.muted = effectiveMuted(muted);
  }

  pause(): void {
    this.player.pause();
  }

  seek(position: number): void {
    this.player.currentTime = Math.max(0, position);
  }

  setAudioTrack(id: string): void {
    const track = this.player.availableAudioTracks[Number(id.slice(1))];
    if (track) this.player.audioTrack = track;
  }

  setSubtitleTrack(id: string | null): void {
    this.player.subtitleTrack =
      id === null ? null : (this.player.availableSubtitleTracks[Number(id.slice(1))] ?? null);
  }

  release(): void {
    super.release();
    for (const subscription of this.subscriptions) subscription.remove();
    this.player.release();
  }
}
