import type HlsPlayer from 'hls.js';
import type { ErrorData } from 'hls.js';
import { createElement, memo, type ComponentType } from 'react';
import { View } from 'react-native';

import { colors } from '@/theme';

import type { EngineHealth } from '../health/types';
import { effectiveMuted } from '../test-muted';
import { EngineBase } from './base';
import { audioErrorCode } from './hls-audio-error';
import { importHls } from './hls-import';
import { StartSeek } from './start-seek';
import { createLumaSampler } from './web-luma';
import type { EngineSource, EngineTrack, PlayerEngine, SurfaceProps } from './types';

type NativeTrackList<T> = EventTarget & { length: number; [index: number]: T };
type NativeAudioTrack = { id: string; label: string; language: string; enabled: boolean };
type VideoWithTracks = HTMLVideoElement & { audioTracks?: NativeTrackList<NativeAudioTrack> };
/** Vendor counters: decoded audio bytes (Chrome, Safari), audio presence (Firefox), Remote Playback. */
type WebMediaCounters = {
  webkitAudioDecodedByteCount?: number;
  mozHasAudio?: boolean;
  remote?: { state?: string };
};

const MAX_SUBTITLE_REASSERTS = 5;
/** Media errors further apart than this start a new recovery round. */
const MEDIA_RECOVERY_WINDOW_MS = 30_000;
/** In-engine media recoveries per source, whatever their spacing: then the ladder takes over (review 18). */
const MEDIA_RECOVERY_TOTAL = 6;

type HlsModule = typeof import('hls.js');
let hlsModule: HlsModule | null = null;
let hlsLoading: Promise<HlsModule> | null = null;

/** A transcode slower than real time answers a segment late: wait 30 s for the first byte, retry twice (C08). */
export const FRAG_LOAD_POLICY = {
  default: {
    maxTimeToFirstByteMs: 30_000,
    maxLoadTimeMs: 120_000,
    timeoutRetry: { maxNumRetry: 2, retryDelayMs: 0, maxRetryDelayMs: 0 },
    errorRetry: { maxNumRetry: 6, retryDelayMs: 1_000, maxRetryDelayMs: 8_000 },
  },
};

/** Pauses between the retries of a failed hls.js chunk (stale deploy, flaky network: D06). */
export const HLS_IMPORT_RETRY_MS = [1_000, 3_000];

async function importWithRetry(): Promise<HlsModule> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await importHls();
    } catch (error) {
      const wait = HLS_IMPORT_RETRY_MS[attempt];
      if (wait === undefined) throw error;
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}

/** hls.js is a separate web chunk: only the MSE player needs it (Safari plays HLS natively). */
export function loadHls(): Promise<HlsModule> {
  hlsLoading ??= importWithRetry().then(
    (loaded) => (hlsModule = loaded),
    (error: unknown) => {
      hlsLoading = null;
      throw error;
    }
  );
  return hlsLoading;
}

/** HTTP status of a media URL (HEAD); 0 when nothing answers. */
async function probeStatus(uri: string): Promise<number> {
  try {
    return (await fetch(uri, { method: 'HEAD' })).status;
  } catch {
    return 0;
  }
}

function mseAvailable(): boolean {
  const scope = globalThis as { MediaSource?: unknown; ManagedMediaSource?: unknown };
  return scope.MediaSource !== undefined || scope.ManagedMediaSource !== undefined;
}

/** Safari plays HLS natively (HDR, AirPlay); everything else uses hls.js on MSE. */
export function prefersNativeHls(): boolean {
  if (typeof document === 'undefined') return false;
  const agent = navigator.userAgent;
  const safari = /Safari\//.test(agent) && !/Chrome\/|Chromium\/|Edg\//.test(agent);
  const native = document.createElement('video').canPlayType('application/vnd.apple.mpegurl');
  return (safari && native !== '') || (!mseAvailable() && native !== '');
}

function createWebSurface(
  ref: (element: HTMLVideoElement | null) => void
): ComponentType<SurfaceProps> {
  function WebSurface({ style, fit }: SurfaceProps) {
    return (
      <View style={[{ backgroundColor: colors.video }, style]}>
        {createElement('video', {
          ref,
          playsInline: true,
          style: { width: '100%', height: '100%', objectFit: fit ?? 'contain', display: 'block' },
        })}
      </View>
    );
  }
  return memo(WebSurface);
}

/** `<video>` with full hls.js (WebVTT renditions) or Safari's native HLS. */
export class WebEngine extends EngineBase implements PlayerEngine {
  readonly kind = 'web' as const;
  private video: VideoWithTracks | null = null;
  private hls: HlsPlayer | null = null;
  private pending: EngineSource | null = null;
  private started = false;
  private mediaRecovery = { count: 0, at: 0, total: 0 };
  /** Safari's native HLS: frame counters count only once they were seen moving on this element. */
  private framesProven = false;
  private framesAtLoad: number | undefined;
  /** Decoded audio bytes count only once they were seen moving on this element (no silence verdict from a dead counter). */
  private audioProven = false;
  private audioFirst: number | undefined;
  private readonly luma = createLumaSampler();
  private startSeek = new StartSeek(0, () => undefined);
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private detach: (() => void) | null = null;
  /** hls.js audio track whose first fragment is buffered (AUDIO_TRACK_SWITCHED), `null` until then. */
  private audioSwitched: number | null = null;
  /** hls.js subtitle track the app picked (-1 = off); hls.js's own text-track polling must not override it. */
  private wantedSubtitle: number | undefined;
  /** What the app asked for last; a pause/play the element reports against it came from the system controls. */
  private wantPaused = false;
  private subtitleReasserts = 0;
  /** Source waiting for the hls.js chunk; a newer load or a release replaces it. */
  private deferred: EngineSource | null = null;
  readonly mode: 'hls.js' | 'native' = prefersNativeHls() ? 'native' : 'hls.js';

  private readonly attachRef = (element: HTMLVideoElement | null) => this.attach(element);

  readonly Surface = createWebSurface(this.attachRef);

  private attach(element: HTMLVideoElement | null): void {
    this.detach?.();
    this.detach = null;
    this.video = element;
    if (!element) return;
    if (effectiveMuted(false)) element.muted = true;
    const on = <K extends keyof HTMLMediaElementEventMap>(name: K, handler: () => void) => {
      element.addEventListener(name, handler);
      return () => element.removeEventListener(name, handler);
    };
    const offs = [
      on('timeupdate', () => this.emitTime()),
      on('seeked', () => this.emitTime()),
      on('durationchange', () => this.emitTime()),
      on('waiting', () => {
        if (this.started) this.emit({ type: 'buffering', buffering: true });
        this.setState(this.started ? 'buffering' : 'loading');
      }),
      on('playing', () => {
        if (this.started) this.emit({ type: 'buffering', buffering: false });
        this.setState('playing');
      }),
      on('pause', () => {
        if (element.ended) return;
        this.setState('paused');
        this.syncUserPlayback(element);
      }),
      on('play', () => this.syncUserPlayback(element)),
      // iPhone: leaving the system full-screen player may pause the video without a pause from the app.
      on('webkitendfullscreen' as keyof HTMLMediaElementEventMap, () =>
        this.syncUserPlayback(element)
      ),
      on('ended', () => {
        this.setState('ended');
        this.emit({ type: 'ended' });
      }),
      on('loadedmetadata', () => {
        this.startSeek.ready();
        this.emitTracks();
      }),
      on('error', () => {
        const reason = element.error?.message || `media_error_${element.error?.code ?? 0}`;
        const code = element.error?.code;
        const uri = this.source?.uri;
        // A network or "not supported" error of a plain URL: its HTTP status tells session loss from transport (D09).
        if (!this.hls && uri && (code === 2 || code === 4))
          return void probeStatus(uri).then((status) => {
            if (this.video !== element || this.source?.uri !== uri) return;
            this.emit({ type: 'error', reason, status });
            this.setState('error');
          });
        this.emit({ type: 'error', reason });
        this.setState('error');
      }),
    ];
    const lists = [element.textTracks, (element as VideoWithTracks).audioTracks].filter(
      (list) => !!list
    );
    const onTracks = () => {
      this.emitTracks();
      // hls.js re-reads text track modes on the next tick and may switch the app's subtitle off.
      if (this.hls) setTimeout(() => this.hls && this.keepSubtitle(this.hls), 0);
    };
    for (const list of lists) {
      list.addEventListener('addtrack', onTracks);
      list.addEventListener('change', onTracks);
    }
    this.detach = () => {
      offs.forEach((off) => off());
      for (const list of lists) {
        list.removeEventListener('addtrack', onTracks);
        list.removeEventListener('change', onTracks);
      }
    };
    if (this.pending) this.start(this.pending);
  }

  private emitTime(): void {
    const video = this.video;
    if (!video) return;
    // Before the start seek the clock still reads 0; the snapshot keeps the start position.
    if (this.startSeek.pending && !this.startSeek.applied) return;
    this.startSeek.time(video.currentTime);
    const buffered = video.buffered.length ? video.buffered.end(video.buffered.length - 1) : 0;
    this.emit({
      type: 'time',
      position: video.currentTime,
      duration: Number.isFinite(video.duration) ? video.duration : 0,
      buffered,
    });
  }

  private watchFirstFrame(video: HTMLVideoElement): void {
    const done = () => {
      if (this.started) return;
      this.started = true;
      this.emit({ type: 'firstFrame' });
    };
    if (typeof video.requestVideoFrameCallback === 'function')
      video.requestVideoFrameCallback(done);
    // Safari's native HLS may never call the frame callback: a clock that runs over decoded data also counts.
    const startedAt = video.currentTime;
    const onTime = () => {
      if (this.started) return void video.removeEventListener('timeupdate', onTime);
      if (video.readyState < 2 || video.paused || video.currentTime === startedAt) return;
      video.removeEventListener('timeupdate', onTime);
      done();
    };
    video.addEventListener('timeupdate', onTime);
    if (typeof video.requestVideoFrameCallback !== 'function')
      video.addEventListener('playing', done, { once: true });
  }

  private emitTracks(): void {
    const video = this.video;
    if (!video) return;
    let audio: EngineTrack[] = [];
    let subtitles: EngineTrack[] = [];
    if (this.hls) {
      const hls = this.hls;
      audio = hls.audioTracks.map((track, index) => ({
        id: String(index),
        label: track.name || track.lang || `#${index + 1}`,
        language: track.lang,
        selected: (this.audioSwitched ?? hls.audioTrack) === index,
      }));
      subtitles = hls.subtitleTracks.map((track, index) => ({
        id: String(index),
        label: track.name || track.lang || `#${index + 1}`,
        language: track.lang,
        selected: hls.subtitleDisplay && hls.subtitleTrack === index,
      }));
    } else {
      const list = video.audioTracks;
      for (let index = 0; list && index < list.length; index++) {
        const track = list[index]!;
        audio.push({
          id: String(index),
          label: track.label || track.language || `#${index + 1}`,
          language: track.language,
          selected: track.enabled,
        });
      }
      for (let index = 0; index < video.textTracks.length; index++) {
        const track = video.textTracks[index]!;
        const kind = track.kind as string;
        if (kind !== 'subtitles' && kind !== 'captions' && kind !== 'forced') continue;
        subtitles.push({
          id: String(index),
          label: track.label || track.language || `#${index + 1}`,
          language: track.language,
          ...(kind === 'forced' ? { forced: true } : null),
          selected: track.mode === 'showing',
        });
      }
    }
    this.emit({
      type: 'tracks',
      tracks: {
        audio,
        subtitles,
        video: { width: video.videoWidth || undefined, height: video.videoHeight || undefined },
      },
    });
  }

  private start(source: EngineSource): void {
    const video = this.video;
    if (!video) {
      this.pending = source;
      return;
    }
    this.pending = null;
    this.teardown();
    if (source.kind === 'hls' && this.mode === 'hls.js' && !hlsModule) {
      this.deferred = source;
      loadHls().then(
        () => {
          if (this.deferred === source && this.video === video) this.start(source);
        },
        () => {
          if (this.deferred !== source) return;
          this.emit({ type: 'error', reason: 'hlsjs:load' });
          this.setState('error');
        }
      );
      return;
    }
    this.audioSwitched = null;
    this.mediaRecovery = { count: 0, at: 0, total: 0 };
    this.framesAtLoad = undefined;
    this.wantedSubtitle = undefined;
    this.startSeek.cancel();
    this.watchFirstFrame(video);
    if (source.kind === 'hls' && this.mode === 'hls.js' && hlsModule) {
      const { default: Hls, Events, ErrorTypes } = hlsModule;
      const hls = new Hls({
        startPosition: source.startPosition ?? -1,
        enableWebVTT: true,
        fragLoadPolicy: FRAG_LOAD_POLICY,
      });
      this.hls = hls;
      hls.subtitleDisplay = false;
      hls.on(Events.MANIFEST_PARSED, () => this.emitTracks());
      hls.on(Events.AUDIO_TRACKS_UPDATED, () => this.emitTracks());
      hls.on(Events.AUDIO_TRACK_SWITCHED, (_event, data) => {
        this.audioSwitched = data.id;
        this.emitTracks();
      });
      hls.on(Events.SUBTITLE_TRACKS_UPDATED, () => this.emitTracks());
      hls.on(Events.SUBTITLE_TRACK_SWITCH, () => {
        this.emitTracks();
        this.keepSubtitle(hls);
      });
      hls.on(Events.FRAG_LOADED, () =>
        this.emit({ type: 'stats', stats: { bandwidth: Math.round(hls.bandwidthEstimate) } })
      );
      hls.on(Events.ERROR, (_event, data: ErrorData) => {
        const audioCode = audioErrorCode(data);
        if (audioCode) this.emit({ type: 'audioError', code: audioCode });
        // hls.js nudges over a stall without a `waiting` from the element: the status layer shows it (D04).
        if (!data.fatal && data.details === 'bufferStalledError' && this.started)
          this.emit({ type: 'buffering', buffering: true });
        if (!data.fatal) return;
        if (data.type === ErrorTypes.MEDIA_ERROR && this.recoverMedia(hls)) return;
        const status = (data as { response?: { code?: number } }).response?.code;
        this.emit({
          type: 'error',
          reason: `${data.type}:${data.details}`,
          ...(typeof status === 'number' ? { status } : null),
        });
        this.setState('error');
      });
      hls.loadSource(source.uri);
      hls.attachMedia(video);
    } else {
      // Safari can drop a currentTime set before the metadata loaded (native HLS).
      this.startSeek = new StartSeek(source.startPosition ?? 0, (position) => {
        if (this.video === video) video.currentTime = position;
      });
      video.src = source.uri;
    }
    void this.autoplay(video);
    this.statsTimer = setInterval(() => this.pollStats(), 1000);
  }

  /** hls.js media errors: recover, then swap the audio codec and recover, then hand the error on (no loop). */
  private recoverMedia(hls: HlsPlayer): boolean {
    const now = Date.now();
    const recent = now - this.mediaRecovery.at < MEDIA_RECOVERY_WINDOW_MS;
    const total = this.mediaRecovery.total + 1;
    this.mediaRecovery = { count: recent ? this.mediaRecovery.count + 1 : 1, at: now, total };
    if (total > MEDIA_RECOVERY_TOTAL) return false;
    if (this.mediaRecovery.count === 1) hls.recoverMediaError();
    else if (this.mediaRecovery.count === 2) {
      hls.swapAudioCodec();
      hls.recoverMediaError();
    } else return false;
    return true;
  }

  private async autoplay(video: HTMLVideoElement): Promise<void> {
    try {
      await video.play();
    } catch (error) {
      // Browsers without a prior user gesture only allow muted autoplay.
      if ((error as Error).name !== 'NotAllowedError') return;
      video.muted = true;
      try {
        await video.play();
        this.emit({ type: 'autoplay', result: 'muted' });
      } catch {
        this.emit({ type: 'autoplay', result: 'blocked' });
      }
    }
  }

  private pollStats(): void {
    const video = this.video;
    if (!video || typeof video.getVideoPlaybackQuality !== 'function') return;
    const quality = video.getVideoPlaybackQuality();
    this.emit({
      type: 'stats',
      stats: {
        droppedFrames: quality.droppedVideoFrames,
        totalFrames: quality.totalVideoFrames,
        decoder: this.hls
          ? 'MSE (hls.js)'
          : this.source?.kind === 'hls'
            ? 'native HLS'
            : 'progressive',
      },
    });
  }

  /** The web probe for the watchdog: frames, audio bytes, picture readiness, bandwidth (state-matrix § 2 a). */
  readHealth(): Promise<EngineHealth> {
    const video = this.video as (VideoWithTracks & WebMediaCounters) | null;
    if (!video) return Promise.resolve({});
    const quality =
      typeof video.getVideoPlaybackQuality === 'function' ? video.getVideoPlaybackQuality() : null;
    const presented = quality ? quality.totalVideoFrames - quality.droppedVideoFrames : undefined;
    if (presented !== undefined && this.framesAtLoad !== undefined && presented > this.framesAtLoad)
      this.framesProven = true;
    this.framesAtLoad ??= presented;
    const framesKnown = this.mode === 'hls.js' || this.framesProven;
    const audio =
      typeof video.webkitAudioDecodedByteCount === 'number'
        ? video.webkitAudioDecodedByteCount
        : undefined;
    if (audio !== undefined && this.audioFirst !== undefined && audio !== this.audioFirst)
      this.audioProven = true;
    this.audioFirst ??= audio;
    return Promise.resolve({
      framesPresented: framesKnown ? presented : undefined,
      framesDropped: framesKnown ? quality?.droppedVideoFrames : undefined,
      audioProgress: this.audioProven ? audio : undefined,
      hasAudioTrack: typeof video.mozHasAudio === 'boolean' ? video.mozHasAudio : undefined,
      hasVideoTrack: video.videoWidth > 0 ? true : undefined,
      readyForDisplay: this.started ? video.readyState >= 2 : undefined,
      bandwidthBps: this.hls ? Math.round(this.hls.bandwidthEstimate) || undefined : undefined,
      external: video.remote?.state === 'connected' ? true : undefined,
      nativePosition: video.currentTime,
      // Only MSE data passed CORS; a plain cross-origin `src` would taint the canvas.
      luma: this.hls ? this.luma(video) : undefined,
    });
  }

  private teardown(): void {
    this.deferred = null;
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.statsTimer = null;
    this.hls?.destroy();
    this.hls = null;
    const video = this.video;
    if (video) {
      video.removeAttribute('src');
      video.load();
    }
  }

  load(source: EngineSource): void {
    this.resetForLoad(source);
    this.started = false;
    this.wantPaused = false;
    this.start(source);
  }

  play(): void {
    this.wantPaused = false;
    if (this.video) void this.autoplay(this.video);
  }

  setMuted(muted: boolean): void {
    if (this.video) this.video.muted = effectiveMuted(muted);
  }

  pause(): void {
    this.wantPaused = true;
    this.video?.pause();
  }

  private syncUserPlayback(video: HTMLVideoElement): void {
    if (!this.started || video.paused === this.wantPaused) return;
    this.wantPaused = video.paused;
    this.emit({ type: 'userPlayback', paused: video.paused });
  }

  seek(position: number): void {
    this.startSeek.cancel();
    if (!this.video) return;
    this.video.currentTime = Math.max(0, position);
    // `seeked` may take a while on a stream: the clock shows the target at once.
    this.emitTime();
  }

  setAudioTrack(id: string): void {
    const index = Number(id);
    if (this.hls) {
      this.audioSwitched ??= this.hls.audioTrack;
      this.hls.audioTrack = index;
    } else {
      const list = this.video?.audioTracks;
      for (let i = 0; list && i < list.length; i++) list[i]!.enabled = i === index;
      this.emitTracks();
    }
  }

  setSubtitleTrack(id: string | null): void {
    if (this.hls) {
      this.wantedSubtitle = id === null ? -1 : Number(id);
      this.subtitleReasserts = 0;
      this.hls.subtitleDisplay = id !== null;
      this.hls.subtitleTrack = this.wantedSubtitle;
      this.emitTracks();
      return;
    }
    const tracks = this.video?.textTracks;
    for (let i = 0; tracks && i < tracks.length; i++)
      tracks[i]!.mode = id !== null && i === Number(id) ? 'showing' : 'disabled';
  }

  private keepSubtitle(hls: HlsPlayer): void {
    const wanted = this.wantedSubtitle;
    if (wanted === undefined || this.subtitleReasserts >= MAX_SUBTITLE_REASSERTS) return;
    if (hls.subtitleTrack === wanted && (wanted < 0 || hls.subtitleDisplay)) return;
    this.subtitleReasserts += 1;
    hls.subtitleDisplay = wanted >= 0;
    hls.subtitleTrack = wanted;
    this.emitTracks();
  }

  release(): void {
    this.teardown();
    this.detach?.();
    super.release();
  }
}

export function createWebEngine(): PlayerEngine {
  return new WebEngine();
}
