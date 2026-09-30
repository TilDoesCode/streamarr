import HlsPlayer, { ErrorTypes, Events, type ErrorData } from 'hls.js';
import { createElement, memo, type ComponentType } from 'react';
import { View } from 'react-native';

import { colors } from '@/theme';

import { EngineBase } from './base';
import type { EngineSource, EngineTrack, PlayerEngine, SurfaceProps } from './types';

type NativeTrackList<T> = { length: number; [index: number]: T };
type NativeAudioTrack = { id: string; label: string; language: string; enabled: boolean };
type VideoWithTracks = HTMLVideoElement & { audioTracks?: NativeTrackList<NativeAudioTrack> };

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
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private detach: (() => void) | null = null;
  readonly mode: 'hls.js' | 'native' = prefersNativeHls() ? 'native' : 'hls.js';

  private readonly attachRef = (element: HTMLVideoElement | null) => this.attach(element);

  readonly Surface = createWebSurface(this.attachRef);

  private attach(element: HTMLVideoElement | null): void {
    this.detach?.();
    this.detach = null;
    this.video = element;
    if (!element) return;
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
        if (!element.ended) this.setState('paused');
      }),
      on('ended', () => {
        this.setState('ended');
        this.emit({ type: 'ended' });
      }),
      on('loadedmetadata', () => this.emitTracks()),
      on('error', () => {
        this.emit({
          type: 'error',
          reason: element.error?.message || `media_error_${element.error?.code ?? 0}`,
        });
        this.setState('error');
      }),
    ];
    const textTracks = element.textTracks;
    const onTextChange = () => this.emitTracks();
    textTracks.addEventListener('addtrack', onTextChange);
    textTracks.addEventListener('change', onTextChange);
    this.detach = () => {
      offs.forEach((off) => off());
      textTracks.removeEventListener('addtrack', onTextChange);
      textTracks.removeEventListener('change', onTextChange);
    };
    if (this.pending) this.start(this.pending);
  }

  private emitTime(): void {
    const video = this.video;
    if (!video) return;
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
        selected: hls.audioTrack === index,
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
        if (track.kind !== 'subtitles' && track.kind !== 'captions') continue;
        subtitles.push({
          id: String(index),
          label: track.label || track.language || `#${index + 1}`,
          language: track.language,
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
    this.watchFirstFrame(video);
    if (source.kind === 'hls' && this.mode === 'hls.js') {
      const hls = new HlsPlayer({ startPosition: source.startPosition ?? -1, enableWebVTT: true });
      this.hls = hls;
      hls.subtitleDisplay = false;
      hls.on(Events.MANIFEST_PARSED, () => this.emitTracks());
      hls.on(Events.AUDIO_TRACKS_UPDATED, () => this.emitTracks());
      hls.on(Events.AUDIO_TRACK_SWITCHED, () => this.emitTracks());
      hls.on(Events.SUBTITLE_TRACKS_UPDATED, () => this.emitTracks());
      hls.on(Events.SUBTITLE_TRACK_SWITCH, () => this.emitTracks());
      hls.on(Events.FRAG_LOADED, () =>
        this.emit({ type: 'stats', stats: { bandwidth: Math.round(hls.bandwidthEstimate) } })
      );
      hls.on(Events.ERROR, (_event, data: ErrorData) => {
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
      video.src = source.uri;
      if (source.startPosition) video.currentTime = source.startPosition;
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
    this.start(source);
  }

  play(): void {
    if (this.video) void this.autoplay(this.video);
  }

  setMuted(muted: boolean): void {
    if (this.video) this.video.muted = muted;
  }

  pause(): void {
    this.video?.pause();
  }

  seek(position: number): void {
    if (this.video) this.video.currentTime = Math.max(0, position);
  }

  setAudioTrack(id: string): void {
    const index = Number(id);
    if (this.hls) this.hls.audioTrack = index;
    else {
      const list = this.video?.audioTracks;
      for (let i = 0; list && i < list.length; i++) list[i]!.enabled = i === index;
      this.emitTracks();
    }
  }

  setSubtitleTrack(id: string | null): void {
    if (this.hls) {
      this.hls.subtitleDisplay = id !== null;
      this.hls.subtitleTrack = id === null ? -1 : Number(id);
      this.emitTracks();
      return;
    }
    const tracks = this.video?.textTracks;
    for (let i = 0; tracks && i < tracks.length; i++)
      tracks[i]!.mode = id !== null && i === Number(id) ? 'showing' : 'disabled';
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
