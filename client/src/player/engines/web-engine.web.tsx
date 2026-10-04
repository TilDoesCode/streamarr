import type HlsPlayer from 'hls.js';
import type { ErrorData } from 'hls.js';
import { createElement, memo, type ComponentType } from 'react';
import { View } from 'react-native';

import { colors } from '@/theme';

import { effectiveMuted } from '../test-muted';
import { EngineBase } from './base';
import { audioErrorCode } from './hls-audio-error';
import { importHls } from './hls-import';
import { StartSeek } from './start-seek';
import type { EngineSource, EngineTrack, PlayerEngine, SurfaceProps } from './types';

type NativeTrackList<T> = EventTarget & { length: number; [index: number]: T };
type NativeAudioTrack = { id: string; label: string; language: string; enabled: boolean };
type VideoWithTracks = HTMLVideoElement & { audioTracks?: NativeTrackList<NativeAudioTrack> };

const MAX_SUBTITLE_REASSERTS = 5;

type HlsModule = typeof import('hls.js');
let hlsModule: HlsModule | null = null;
let hlsLoading: Promise<HlsModule> | null = null;

/** hls.js is a separate web chunk: only the MSE player needs it (Safari plays HLS natively). */
export function loadHls(): Promise<HlsModule> {
  hlsLoading ??= importHls().then(
    (loaded) => (hlsModule = loaded),
    (error: unknown) => {
      hlsLoading = null;
      throw error;
    }
  );
  return hlsLoading;
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
        this.emit({
          type: 'error',
          reason: element.error?.message || `media_error_${element.error?.code ?? 0}`,
        });
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
    else video.addEventListener('playing', done, { once: true });
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
    this.wantedSubtitle = undefined;
    this.startSeek.cancel();
    this.watchFirstFrame(video);
    if (source.kind === 'hls' && this.mode === 'hls.js' && hlsModule) {
      const { default: Hls, Events, ErrorTypes } = hlsModule;
      const hls = new Hls({ startPosition: source.startPosition ?? -1, enableWebVTT: true });
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
        if (!data.fatal) return;
        if (data.type === ErrorTypes.MEDIA_ERROR) {
          hls.recoverMediaError();
          return;
        }
        this.emit({ type: 'error', reason: `${data.type}:${data.details}` });
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

  private async autoplay(video: HTMLVideoElement): Promise<void> {
    try {
      await video.play();
    } catch (error) {
      // Browsers without a prior user gesture only allow muted autoplay.
      if ((error as Error).name !== 'NotAllowedError') return;
      video.muted = true;
      await video.play().catch(() => undefined);
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
