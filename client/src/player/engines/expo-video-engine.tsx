import { createRef, memo, type ComponentType, type RefObject } from 'react';
import { Platform } from 'react-native';
import {
  createVideoPlayer,
  VideoView,
  type AudioTrack,
  type SubtitleTrack,
  type VideoPlayer,
} from 'expo-video';

import type { EngineHealth } from '../health/types';
import type { SystemCause } from '../recovery/classify';
import { effectiveMuted } from '../test-muted';
import { EngineBase } from './base';
import { StartSeek } from './start-seek';
import type { EngineSource, EngineTrack, PlayerEngine, SurfaceProps } from './types';
import {
  errorReason,
  systemCause,
  toHealth,
  type NativeError,
  type NativeProbe,
} from './native-probe';

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

/** Time events while playing; the clock shows whole seconds. */
const TIME_UPDATE_SECONDS = 0.5;
/** AVPlayer: count frames with an AVPlayerItemVideoOutput (S6 measures its cost on Apple TV). */
const FRAME_COUNTER = true;
/** A pause this soon after picture-in-picture closed was the window's ✕ (A16). */
const PIP_CLOSE_MS = 2_000;

/** expo-video (ExoPlayer on Android, AVPlayer on Apple). */
export class ExpoVideoEngine extends EngineBase implements PlayerEngine {
  readonly kind = 'expo-video' as const;
  private readonly player: VideoPlayer = createVideoPlayer(null);
  private readonly subscriptions: Subscription[] = [];
  private ready = false;
  private loaded = false;
  private wantPlay = false;
  private start = new StartSeek(0, () => undefined);
  /** Paused by the OS (call, other audio, headphones, lock); a resume the OS allows plays again. */
  private systemPause: SystemCause | null = null;
  private pipClosedAt = 0;
  private externalDevice: string | undefined;

  constructor() {
    super();
    const player = this.player;
    player.timeUpdateEventInterval = TIME_UPDATE_SECONDS;
    player.keepScreenOnWhilePlaying = true;
    player.muted = effectiveMuted(false);
    if (AIRPLAY) player.allowsExternalPlayback = true;
    this.subscriptions.push(
      player.addListener('statusChange', ({ status, error }) => {
        if (status === 'error') {
          const native = error as NativeError | undefined;
          this.emit({
            type: 'error',
            reason: errorReason(native),
            status: native?.httpStatus ?? undefined,
          });
          this.setState('error');
        } else if (status === 'loading') {
          if (this.ready) this.emit({ type: 'buffering', buffering: true });
          this.setState(this.ready ? 'buffering' : 'loading');
        } else if (status === 'readyToPlay') {
          if (this.ready) this.emit({ type: 'buffering', buffering: false });
          this.ready = true;
          if (this.loaded) this.applyStart();
          this.setState(player.playing ? 'playing' : 'paused');
        }
      }),
      player.addListener('playingChange', ({ isPlaying }) => {
        // Android keeps posting time updates while paused; each one wakes the JS thread.
        player.timeUpdateEventInterval = isPlaying ? TIME_UPDATE_SECONDS : 0;
        if (this.getSnapshot().state === 'ended' && !isPlaying) return;
        if (!isPlaying && Date.now() - this.pipClosedAt < PIP_CLOSE_MS)
          this.onSystem(true, 'pipClosed');
        if (player.status === 'readyToPlay') this.setState(isPlaying ? 'playing' : 'paused');
      }),
      (player as unknown as NativeProbe).addListener('systemPlayback', ({ paused, cause }) =>
        this.onSystem(paused, cause)
      ),
      player.addListener('isExternalPlaybackActiveChange', ({ isExternalPlaybackActive }) =>
        this.onExternal(isExternalPlaybackActive)
      ),
      player.addListener('timeUpdate', ({ currentTime, bufferedPosition }) => {
        // Before the start seek the clock still reads 0; the snapshot keeps the start position.
        if (this.start.pending && !this.start.applied) return;
        this.start.time(currentTime);
        this.emit({
          type: 'time',
          position: currentTime,
          duration: player.duration,
          buffered: bufferedPosition,
        });
      }),
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
    onPip: (active) => {
      if (!active) this.pipClosedAt = Date.now();
      this.emit({ type: 'pip', active });
    },
    view: this.view,
  });

  startPictureInPicture(): void {
    if (PIP) void this.view.current?.startPictureInPicture().catch(() => undefined);
  }

  /** A pause or resume the app did not ask for; the controller adopts it with its cause (A12–A14, A16, A19). */
  private onSystem(paused: boolean, cause: string): void {
    if (paused) {
      if (!this.wantPlay) return;
      this.wantPlay = false;
      this.systemPause = systemCause(cause);
      this.emit({ type: 'userPlayback', paused: true, cause: this.systemPause ?? undefined });
    } else if (cause === 'resume' && this.systemPause) {
      // The OS ended the interruption and allows the playback to continue (end of a call).
      this.play();
      this.emit({ type: 'userPlayback', paused: false });
    }
  }

  private onExternal(active: boolean): void {
    this.emit({ type: 'external', active, device: active ? this.externalDevice : undefined });
    if (active)
      void this.readHealth().then(() => {
        if (this.player.isExternalPlaybackActive && this.externalDevice)
          this.emit({ type: 'external', active: true, device: this.externalDevice });
      });
  }

  /** The patched expo-video's probe (state-matrix § 2 a); an unpatched build reports nothing (no rule runs). */
  async readHealth(): Promise<EngineHealth> {
    const probe = this.player as unknown as NativeProbe;
    if (this.released || typeof probe.readHealthAsync !== 'function') return {};
    const raw = await probe.readHealthAsync(FRAME_COUNTER);
    if (typeof raw?.externalDevice === 'string') this.externalDevice = raw.externalDevice;
    return toHealth(raw);
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
      // `name` is the HLS NAME / file title; ExoPlayer's `label` is only the localised language.
      label: track.name || track.label || track.language || `#${index + 1}`,
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
    this.loaded = false;
    this.wantPlay = true;
    const player = this.player;
    this.start.cancel();
    this.start = new StartSeek(source.startPosition ?? 0, (position) => {
      player.currentTime = position;
    });
    void player
      .replaceAsync({ uri: source.uri, contentType: source.kind === 'hls' ? 'hls' : 'progressive' })
      .then(() => {
        if (this.released || this.source !== source) return;
        this.loaded = true;
        if (!this.start.pending) {
          if (this.wantPlay) player.play();
        } else if (player.status === 'readyToPlay') this.applyStart();
      })
      .catch((error: Error) => {
        if (this.released || this.source !== source) return;
        this.emit({ type: 'error', reason: error.message });
        this.setState('error');
      });
  }

  /** AVPlayer can drop a seek issued before the item is ready, so the start waits for readyToPlay. */
  private applyStart(): void {
    if (!this.start.pending || this.start.applied) return;
    this.start.ready();
    if (this.wantPlay) this.player.play();
  }

  play(): void {
    this.wantPlay = true;
    this.systemPause = null;
    if (this.start.pending && !this.start.applied) return;
    if (this.getSnapshot().state === 'ended') this.player.currentTime = 0;
    this.player.play();
  }

  setMuted(muted: boolean): void {
    this.player.muted = effectiveMuted(muted);
  }

  pause(): void {
    this.wantPlay = false;
    this.player.pause();
  }

  seek(position: number): void {
    this.start.cancel();
    this.player.currentTime = Math.max(0, position);
    // The next time event is up to 0.5 s away (none while paused): the clock jumps to the target now.
    const { duration, buffered } = this.getSnapshot();
    this.emit({ type: 'time', position: Math.max(0, position), duration, buffered });
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
