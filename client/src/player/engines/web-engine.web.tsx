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
import { probeStatus } from './status-probe';
import { liftCues } from './web-cues';
import { FRAG_RETRY_DELAY_MS, fragLoadPolicy, statusLoader, type LoadStatus } from './hls-retry';
import { LUMA_WINDOW_S } from '../health/watchdog';
import { createLumaSampler } from './web-luma';
import { lastFrame } from './web-poster';
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
/** hls.js errors that mean the segment's data is broken (B13b); quota/append-progress errors are excluded (review B2). */
const CORRUPT_FRAGMENT = new Set(['fragParsingError', 'fragDecryptError', 'bufferAppendError']);
/** Video segments the conversion speed is measured over (one slow first byte says nothing, review B3). */
const CONVERSION_SEGMENTS = 3;

/** Media seconds the server delivered per second of waiting, over the last segments; undefined until known. */
export function conversionRate(
  waits: readonly { waitMs: number; mediaMs: number }[]
): number | undefined {
  if (waits.length < CONVERSION_SEGMENTS) return undefined;
  const waited = waits.reduce((sum, item) => sum + item.waitMs, 0);
  const media = waits.reduce((sum, item) => sum + item.mediaMs, 0);
  return waited > 0 ? media / waited : undefined;
}

/** Media errors further apart than this start a new recovery round. */
const MEDIA_RECOVERY_WINDOW_MS = 30_000;
/** In-engine media recoveries per source, whatever their spacing: then the ladder takes over (review 18). */
const MEDIA_RECOVERY_TOTAL = 6;
/** The same fragment failing to parse or decode this often goes to the ladder (B13b: no hot retry loop). */
export const FRAG_FAIL_BUDGET = 3;
/** Main fragments loaded this recently mean the network is fine while the audio fails. */
const AUDIO_ALONE_MS = 15_000;
/** hls.js `ErrorDetails.INTERNAL_ABORTED`. */
const SELF_ABORTED = 'aborted';

type HlsModule = typeof import('hls.js');
let hlsModule: HlsModule | null = null;
let hlsLoading: Promise<HlsModule> | null = null;

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
          // No cast button: casting is not offered by design (A20); B2 covers a cast started outside the app.
          disableRemotePlayback: true,
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
  /** The bottom share of the picture the control bar covers now (Q2-02). */
  private subtitleLift = 0;
  private hls: HlsPlayer | null = null;
  private pending: EngineSource | null = null;
  private started = false;
  /** When the last main (video) fragment arrived, and how long its server wait and transfer took. */
  private lastMainLoad = 0;
  private lastFetch: EngineHealth['fetch'];
  /** The server waits of the last video segments and their media length (conversion speed, C08). */
  private recentWaits: { waitMs: number; mediaMs: number }[] = [];
  /** Parse/decode failures per fragment of this source, and the pending delayed retry. */
  private readonly fragFailures = new Map<string, number>();
  private fragRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private mediaRecovery = { count: 0, at: 0, total: 0 };
  /** Safari's native HLS: frame counters count only once they were seen moving on this element. */
  private framesProven = false;
  private framesAtLoad: number | undefined;
  /** Decoded audio bytes count only once they were seen moving on this element (no silence verdict from a dead counter). */
  private audioProven = false;
  private audioFirst: number | undefined;
  /** Frames the element had presented before this source: the probe counts this source only. */
  private framesBase = 0;
  /** Clock at the load: the picture is only sampled in the first minute after it (watchdog luma window). */
  private lumaFrom = 0;
  private lastPresented: number | undefined;
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
        const code = element.error?.code;
        const message = element.error?.message;
        // The MediaError code stays in the reason: a browser message alone hides "network" behind decoder words (D09).
        const reason = `media_error_${code ?? 0}${message ? `: ${message}` : ''}`;
        const uri = this.source?.uri;
        // A network or "not supported" error of a direct-play URL: its HTTP status tells session loss from transport (D09).
        if (this.source?.kind === 'progressive' && uri && (code === 2 || code === 4))
          return void probeStatus(uri).then((status) => {
            if (this.video !== element || this.source?.uri !== uri) return;
            this.emit({ type: 'error', reason, ...(status === undefined ? null : { status }) });
            this.setState('error');
          });
        this.emit({ type: 'error', reason });
        this.setState('error');
      }),
    ];
    const lists = [element.textTracks, (element as VideoWithTracks).audioTracks].filter(
      (list) => !!list
    );
    // hls.js adds cues as segments load: the ones on screen follow the lift (cheap, a few at a time).
    const onCues = () =>
      this.subtitleLift &&
      liftCues(element.textTracks, this.subtitleLift, true, element.clientHeight ?? 0);
    const onTracks = () => {
      this.emitTracks();
      onCues();
      // hls.js re-reads text track modes on the next tick and may switch the app's subtitle off.
      if (this.hls) setTimeout(() => this.hls && this.keepSubtitle(this.hls), 0);
    };
    for (const list of lists) {
      list.addEventListener('addtrack', onTracks);
      list.addEventListener('change', onTracks);
    }
    element.addEventListener('timeupdate', onCues);
    this.detach = () => {
      element.removeEventListener('timeupdate', onCues);
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
      video.poster = '';
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
    // The picture of the old source stays until the new one shows its first frame (E18).
    const poster = this.hls && source.keepLastFrame ? lastFrame(video) : undefined;
    this.teardown();
    video.poster = poster ?? '';
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
    this.fragFailures.clear();
    if (this.fragRetryTimer) clearTimeout(this.fragRetryTimer);
    this.fragRetryTimer = null;
    this.framesAtLoad = undefined;
    // The proof that the counters work belongs to a source, not to the element (Safari direct → native HLS).
    this.framesProven = false;
    this.audioProven = false;
    this.audioFirst = undefined;
    this.framesBase = this.presentedFrames(video);
    this.lumaFrom = source.startPosition ?? 0;
    this.lastPresented = undefined;
    this.wantedSubtitle = undefined;
    this.startSeek.cancel();
    this.watchFirstFrame(video);
    if (source.kind === 'hls' && this.mode === 'hls.js' && hlsModule) {
      const { default: Hls, Events, ErrorTypes } = hlsModule;
      const lastStatus: LoadStatus = {};
      this.lastMainLoad = 0;
      this.lastFetch = undefined;
      this.recentWaits = [];
      const BaseLoader = (Hls as { DefaultConfig?: { loader?: unknown } }).DefaultConfig?.loader;
      const hls = new Hls({
        startPosition: source.startPosition ?? -1,
        enableWebVTT: true,
        fragLoadPolicy: fragLoadPolicy(lastStatus),
        ...(BaseLoader
          ? { loader: statusLoader(BaseLoader as Parameters<typeof statusLoader>[0], lastStatus) }
          : null),
      } as ConstructorParameters<typeof Hls>[0]);
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
      // A WebVTT segment that does not parse (C23): the subtitles fail, the playback goes on.
      hls.on(Events.SUBTITLE_FRAG_PROCESSED, (_event, data) => {
        if (!data.success) this.emit({ type: 'subtitleError', code: 'subtitle_unreadable' });
      });
      hls.on(Events.FRAG_LOADED, (_event, data) => {
        if (data.frag.type === 'main') {
          this.lastMainLoad = Date.now();
          // Waiting for the first byte is the server; the transfer after it is the network (C08 vs C03).
          const { loading, loaded } = data.frag.stats;
          if (loading.first > 0 && loading.end >= loading.first) {
            const waitMs = loading.first - loading.start;
            this.lastFetch = { waitMs, transferMs: loading.end - loading.first, bytes: loaded };
            this.recentWaits = [
              ...this.recentWaits,
              { waitMs, mediaMs: data.frag.duration * 1000 },
            ].slice(-CONVERSION_SEGMENTS);
          }
        }
        this.emit({ type: 'stats', stats: { bandwidth: Math.round(hls.bandwidthEstimate) } });
      });
      hls.on(Events.ERROR, (_event, data: ErrorData) => {
        // hls.js cancels its own requests on a seek or a track switch: never a failure (S9a2 SEEK-SUB, D29).
        if (!data.fatal && data.details === SELF_ABORTED) return;
        const audioCode = audioErrorCode(data);
        if (audioCode) this.emit({ type: 'audioError', code: audioCode });
        // hls.js nudges over a stall without a `waiting` from the element: the status layer shows it (D04).
        if (!data.fatal && data.details === 'bufferStalledError' && this.started)
          this.emit({ type: 'buffering', buffering: true });
        const subtitle = subtitleFailure(data);
        if (subtitle) return this.emit({ type: 'subtitleError', code: subtitle });
        const status = (data as { response?: { code?: number } }).response?.code;
        if (this.fragmentFails(hls, data)) return;
        // The audio rendition fails while the video keeps loading: its own failure, not the network (S9a D36).
        const audioRendition = data.type === ErrorTypes.NETWORK_ERROR && this.audioFails(data);
        if (!data.fatal) {
          // hls.js retries a failed segment or playlist itself: the stall it causes is the server's, not the bandwidth's.
          if (
            data.type === ErrorTypes.NETWORK_ERROR &&
            (typeof status === 'number' || audioRendition)
          )
            this.emit({ type: 'loadRetry', status, audio: audioRendition });
          return;
        }
        if (data.type === ErrorTypes.MEDIA_ERROR && this.recoverMedia(hls)) return;
        this.emit({
          type: 'error',
          reason: audioRendition
            ? `audioRendition:${data.details}`
            : `${data.type}:${data.details}${audioOnly(data) ? ':audio' : ''}`,
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

  /** A segment that keeps failing to parse or decode gets 1 s, 2 s, then the ladder, never a hot loop (B13b). */
  private fragmentFails(hls: HlsPlayer, data: ErrorData): boolean {
    const frag = data.frag;
    // Quota and append pressure is hls.js's own business (it shrinks the buffer, D05); only bad segment data counts.
    if (
      !frag ||
      !CORRUPT_FRAGMENT.has(data.details) ||
      (frag.type !== 'main' && frag.type !== 'audio')
    )
      return false;
    const key = `${frag.type}:${frag.level}:${String(frag.sn)}`;
    const count = (this.fragFailures.get(key) ?? 0) + 1;
    this.fragFailures.set(key, count);
    if (count >= FRAG_FAIL_BUDGET) {
      if (this.fragRetryTimer) clearTimeout(this.fragRetryTimer);
      hls.stopLoad();
      this.emit({
        type: 'error',
        reason: `${data.type}:${data.details}${audioOnly(data) ? ':audio' : ''}`,
      });
      this.setState('error');
      return true;
    }
    if (data.fatal) return false;
    hls.stopLoad();
    if (this.fragRetryTimer) clearTimeout(this.fragRetryTimer);
    this.fragRetryTimer = setTimeout(
      () => {
        this.fragRetryTimer = null;
        if (this.hls === hls) hls.startLoad();
      },
      FRAG_RETRY_DELAY_MS * 2 ** (count - 1)
    );
    return true;
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
    const total = quality ? quality.totalVideoFrames - quality.droppedVideoFrames : undefined;
    // A new MediaSource restarts the element's counters; anything below the base is this source from 0.
    const presented =
      total === undefined ? undefined : total >= this.framesBase ? total - this.framesBase : total;
    const framesMoved =
      presented !== undefined &&
      this.lastPresented !== undefined &&
      presented !== this.lastPresented;
    this.lastPresented = presented;
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
      fetch: this.lastFetch,
      conversionRate: conversionRate(this.recentWaits),
      external: video.remote?.state === 'connected' ? true : undefined,
      nativePosition: video.currentTime,
      // Only MSE data passed CORS (a plain cross-origin `src` would taint the canvas); only while the rule can fire.
      luma:
        this.hls && !framesMoved && video.currentTime - this.lumaFrom < LUMA_WINDOW_S
          ? this.luma(video)
          : undefined,
    });
  }

  private presentedFrames(video: HTMLVideoElement): number {
    if (typeof video.getVideoPlaybackQuality !== 'function') return 0;
    const quality = video.getVideoPlaybackQuality();
    return quality.totalVideoFrames - quality.droppedVideoFrames;
  }

  /** An audio fragment or playlist failed while main fragments still arrive (the last 15 s). */
  private audioFails(data: ErrorData): boolean {
    const audio = data.frag?.type === 'audio' || /^audioTrack/.test(data.details);
    return audio && Date.now() - this.lastMainLoad < AUDIO_ALONE_MS;
  }

  private teardown(): void {
    this.deferred = null;
    if (this.fragRetryTimer) clearTimeout(this.fragRetryTimer);
    this.fragRetryTimer = null;
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

  setSubtitleLift(fraction: number): void {
    this.subtitleLift = fraction;
    liftCues(this.video?.textTracks, fraction, false, this.video?.clientHeight ?? 0);
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

/** A media error of the audio buffer alone (audio codec or decoder): `:audio` lets the ladder convert the audio (D13). */
function audioOnly(data: ErrorData): boolean {
  if (data.type === 'networkError') return false;
  const { sourceBufferName, mimeType, frag } = data as ErrorData & { sourceBufferName?: string };
  return sourceBufferName === 'audio' || frag?.type === 'audio' || /^audio\//.test(mimeType ?? '');
}

/** Subtitle playlist or segment failures never stop the playback (C22, C23): their own code instead of an error. */
function subtitleFailure(data: ErrorData): string | null {
  const status = (data as { response?: { code?: number } }).response?.code;
  const subtitle =
    data.details === 'subtitleTrackLoadError' ||
    data.details === 'subtitleTrackLoadTimeOut' ||
    data.frag?.type === 'subtitle';
  if (!subtitle) return null;
  if (/TimeOut/.test(data.details)) return 'subtitle_timeout';
  return status === 404 ? 'unknown_subtitle_stream' : 'subtitle_unavailable';
}
