import { createRef, memo, useSyncExternalStore, type ComponentType, type RefObject } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import {
  createVideoPlayer,
  VideoView,
  type AudioTrack,
  type SubtitleTrack,
  type VideoPlayer,
} from 'expo-video';

import { colors } from '@/theme';

import type { EngineHealth } from '../health/types';
import { effectiveMuted } from '../test-muted';
import { EngineBase, PropsStore } from './base';
import { StartSeek } from './start-seek';
import type { EngineSource, EngineTrack, PlayerEngine, SurfaceProps, SystemCause } from './types';
import {
  failureReason,
  isFailedLoad,
  loadErrorPart,
  ownFailure,
  subtitleCode,
  systemCause,
  toHealth,
  toStats,
  type NativeError,
  type NativeLoadError,
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
  /** Black over the picture until a start position is reached (the new item's frame 0 must not show, R5). */
  cover: PropsStore<{ covered: boolean }>;
};

function createExpoVideoSurface(
  player: VideoPlayer,
  { onFirstFrame, onPip, view, cover }: SurfaceHooks
): ComponentType<SurfaceProps> {
  function ExpoVideoSurface({ style, fit }: SurfaceProps) {
    const { covered } = useSyncExternalStore(cover.subscribe, cover.get);
    return (
      <>
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
        {covered ? (
          <View testID="engine-start-cover" style={[StyleSheet.absoluteFill, styles.cover]} />
        ) : null}
      </>
    );
  }
  return memo(ExpoVideoSurface);
}

const styles = StyleSheet.create({ cover: { backgroundColor: colors.video } });

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
  /** When the player stopped while the app wanted it to play (the cause may follow, e.g. PiP ✕ on iOS). */
  private strayPauseAt = 0;
  private readonly cover = new PropsStore({ covered: false });
  /** Shut down behind a card: native status, time, error and end events of the unloaded item are not the playback's. */
  private unloaded = false;
  /** Subtitle renditions that already failed for this source (one notice, not one per retried segment). */
  private failedText = new Set<string>();
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
        if (this.unloaded) return;
        if (status === 'error') {
          const native = ownFailure(error as NativeError | undefined);
          this.emit({
            type: 'error',
            reason: failureReason(native, this.ready, this.source?.kind === 'hls'),
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
        if (!isPlaying && this.wantPlay) this.strayPauseAt = Date.now();
        if (!isPlaying && Date.now() - this.pipClosedAt < PIP_CLOSE_MS)
          this.onSystem(true, 'pipClosed');
        if (player.status === 'readyToPlay') this.setState(isPlaying ? 'playing' : 'paused');
      }),
      (player as unknown as NativeProbe).addListener('systemPlayback', ({ paused, cause }) =>
        this.onSystem(paused, cause)
      ),
      (player as unknown as NativeProbe).addListener('loadError', (event) =>
        this.onLoadError(event)
      ),
      player.addListener('isExternalPlaybackActiveChange', ({ isExternalPlaybackActive }) =>
        this.onExternal(isExternalPlaybackActive)
      ),
      player.addListener('timeUpdate', ({ currentTime, bufferedPosition }) => {
        if (this.unloaded) return;
        // Before the start seek the clock still reads 0; the snapshot keeps the start position.
        if (this.start.pending && !this.start.applied) return;
        this.start.time(currentTime);
        // A start that never reached its target keeps the cover: never the new item's 0:00 frame (S9c seg_corrupt).
        if (!this.start.pending && !this.start.failed) this.uncover();
        this.emit({
          type: 'time',
          position: currentTime,
          duration: player.duration,
          buffered: bufferedPosition,
        });
      }),
      player.addListener('playToEnd', () => {
        // Android has no current-item check: an emptied Exo playlist ends too (R10).
        if (this.unloaded) return;
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
      // iOS pauses on the window's ✕ first and reports the end of picture-in-picture after the animation.
      const stopped = !this.player.playing && this.player.status === 'readyToPlay';
      if (!active && stopped && Date.now() - this.strayPauseAt < PIP_CLOSE_MS)
        this.onSystem(true, 'pipClosed');
    },
    view: this.view,
    cover: this.cover,
  });

  private uncover(): void {
    if (this.cover.get().covered) this.cover.set({ covered: false });
  }

  /** A media request failed and the player retries or drops it: subtitles fail on their own, the rest is a retry (C22, R7). */
  private onLoadError(error: NativeLoadError): void {
    if (this.unloaded || !isFailedLoad(error)) return;
    const part = loadErrorPart(error);
    if (part === 'text') {
      const key = (error.uri ?? '').replace(/\/[^/]*$/, '');
      if (this.failedText.has(key)) return;
      this.failedText.add(key);
      this.emit({ type: 'subtitleError', code: subtitleCode(error.status) });
      return;
    }
    // A transfer that broke off mid-answer (-1005) is the S6t aborted audio rendition's signature; a timeout is not.
    const brokeOff = error.domain === 'NSURLErrorDomain' && error.code === -1005;
    this.emit({
      type: 'loadRetry',
      status: error.status ?? 0,
      audio: part === 'audio',
      ...(brokeOff ? { brokeOff } : {}),
    });
  }

  startPictureInPicture(): void {
    if (PIP) void this.view.current?.startPictureInPicture().catch(() => undefined);
  }

  stopPictureInPicture(): void {
    if (PIP) void this.view.current?.stopPictureInPicture().catch(() => undefined);
  }

  /** A pause or resume the app did not ask for; the controller adopts it with its cause (A12–A14, A16, A19). */
  private onSystem(paused: boolean, cause: string): void {
    if (paused) {
      if (!this.wantPlay) return;
      this.wantPlay = false;
      this.strayPauseAt = 0;
      this.systemPause = systemCause(cause, Platform.isTV);
      this.emit({ type: 'userPlayback', paused: true, cause: this.systemPause ?? undefined });
    } else if (cause === 'resume' && this.systemPause) {
      // The OS ended the interruption and allows the playback to continue (end of a call).
      this.play();
      this.emit({ type: 'userPlayback', paused: false });
    } else if (cause === 'remote' && !this.wantPlay) {
      // Play from the system controls or a media key: the player already plays, the app adopts it.
      this.wantPlay = true;
      this.systemPause = null;
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
    const stats = toStats(raw);
    if (!this.released && Object.keys(stats).length) this.emit({ type: 'stats', stats });
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
    this.unloaded = false;
    this.resetForLoad(source);
    this.ready = false;
    this.loaded = false;
    this.wantPlay = true;
    const player = this.player;
    this.start.cancel();
    this.failedText = new Set();
    this.cover.set({ covered: (source.startPosition ?? 0) > 0 });
    this.start = new StartSeek(source.startPosition ?? 0, (position) => {
      player.currentTime = position;
      // Paused at the start no time event follows: the seeked frame is the one to show.
      if (!this.wantPlay) this.uncover();
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
    this.strayPauseAt = 0;
    if (this.start.pending && !this.start.applied) return;
    if (this.getSnapshot().state === 'ended') this.player.currentTime = 0;
    this.player.play();
  }

  setMuted(muted: boolean): void {
    this.player.muted = effectiveMuted(muted);
  }

  pause(): void {
    // The app's own pause wins: an OS "may resume" after it must not start the picture again.
    this.wantPlay = false;
    if (this.start.applied) this.uncover();
    this.systemPause = null;
    this.strayPauseAt = 0;
    this.player.pause();
  }

  seek(position: number): void {
    this.start.cancel();
    this.uncover();
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

  /** A terminal card: stop decoding and loading (the source is unloaded); the card's Retry loads it again (S6u). */
  async shutdown(): Promise<void> {
    this.unloaded = true;
    this.wantPlay = false;
    this.start.cancel();
    this.player.pause();
    void this.player.replaceAsync(null).catch(() => undefined);
  }

  release(): void {
    this.systemPause = null;
    super.release();
    for (const subscription of this.subscriptions) subscription.remove();
    this.player.release();
  }
}
