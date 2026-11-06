import { createRef, useState, type ReactNode } from 'react';
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import {
  StreamyboxPlayerView,
  type StreamyboxNativeEvent,
  type StreamyboxViewRef,
} from '@modules/streamybox-player';

import { colors } from '@/theme';

import type { EngineHealth } from '../health/types';
import { effectiveMuted } from '../test-muted';
import { EngineBase, PropsStore } from './base';
import { createPropsSurface } from './props-surface';
import type {
  EngineEvent,
  EngineSource,
  EngineState,
  EngineStats,
  EngineTrack,
  EngineTracks,
  PlayerEngine,
  SurfaceProps,
} from './types';

type RawTrack = {
  id?: number;
  label?: string;
  title?: string;
  language?: string;
  codec?: string;
  channels?: number;
  forced?: boolean;
  external?: boolean;
  selected?: boolean;
  /** Player 1.5.6+: what the output gets of this audio track, `passthrough:<codec>` or `pcm:<channels>`. */
  output?: string;
};

type RawVideo = {
  width?: number;
  height?: number;
  /** Display aspect ratio with the pixel aspect applied (anamorphic sources); optional. */
  aspect?: number;
  codec?: string;
  frameRate?: number;
  range?: string;
  dolbyVisionProfile?: number;
  output?: string;
  hwdec?: string;
};

/** One event of the embedded renderer contract (`dev.streamybox.player.render`), as the player sends it. */
export type StreamyboxEvent =
  | { type: 'state'; state: string }
  | { type: 'time'; positionMs: number; durationMs?: number; bufferedMs?: number }
  | { type: 'buffering'; buffering: boolean }
  | { type: 'firstFrame' }
  | { type: 'tracks'; audio?: RawTrack[]; subtitles?: RawTrack[]; video?: RawVideo | null }
  | {
      type: 'stats';
      decoder?: string;
      droppedFrames?: number;
      totalFrames?: number;
      hwdec?: string;
    }
  | { type: 'ended' }
  | { type: 'error'; reason?: string; fatal?: boolean; status?: number }
  /** The current text cue while the player shows video straight from the decoder (it draws no text itself then). */
  | { type: 'subtitle'; text?: string; visible?: boolean };

export type ExternalSubtitle = { url: string; title?: string; language?: string };

const STATES = new Set<EngineState>([
  'idle',
  'loading',
  'playing',
  'paused',
  'buffering',
  'ended',
  'error',
]);

/** Errors of the binding itself (Streamarr side or a replaced session): the next load binds a fresh view. */
const BINDING_ERROR = /^(streamybox_|replaced$)/;
/** Stats older than this no longer speak for the picture (the watchdog would read a frozen counter). */
const STATS_FRESH_MS = 3_000;
const STOP_TIMEOUT_MS = 2_000;

export function parseStreamyboxEvent(json: string): StreamyboxEvent | null {
  try {
    const value: unknown = JSON.parse(json);
    if (
      !value ||
      typeof value !== 'object' ||
      typeof (value as { type?: unknown }).type !== 'string'
    )
      return null;
    return value as StreamyboxEvent;
  } catch {
    return null;
  }
}

const seconds = (ms: number | undefined) => (typeof ms === 'number' && ms >= 0 ? ms / 1000 : 0);

function trackLabel(track: RawTrack, index: number): string {
  const name = track.label?.trim() || track.title?.trim();
  if (name) return name;
  return track.language?.trim() || `Track ${index + 1}`;
}

function mapTrackList(list: RawTrack[] | undefined): EngineTrack[] {
  return (list ?? [])
    .filter((track) => typeof track.id === 'number' && track.id >= 0)
    .map((track, index) => ({
      id: String(track.id),
      label: trackLabel(track, index),
      ...(track.language ? { language: track.language } : {}),
      ...(track.codec ? { codec: track.codec } : {}),
      ...(track.forced ? { forced: true } : {}),
      selected: !!track.selected,
    }));
}

/** mpv's track lists in the engine shape: ids are mpv `aid`/`sid`, in mpv order (file order, then external files). */
export function mapStreamyboxTracks(
  event: Extract<StreamyboxEvent, { type: 'tracks' }>
): EngineTracks {
  const video = event.video;
  return {
    audio: mapTrackList(event.audio),
    subtitles: mapTrackList(event.subtitles),
    ...(video
      ? {
          video: {
            width: video.width,
            height: video.height,
            codec: video.codec,
            frameRate: video.frameRate,
            range: video.range,
          },
        }
      : {}),
  };
}

/** The audio output of the selected track (`passthrough:truehd` → bitstream, `pcm:2` → PCM 2.0); empty before 1.5.6. */
export function audioOutputStats(audio: RawTrack[] | undefined): EngineStats {
  const output = audio?.find((track) => track.selected)?.output ?? '';
  const [kind, value] = output.split(':');
  if (kind === 'passthrough' && value)
    return { audioEncoding: value.toLowerCase(), audioChannels: undefined };
  const channels = Number(value);
  if (kind === 'pcm')
    return { audioEncoding: 'pcm', ...(channels > 0 ? { audioChannels: channels } : {}) };
  return {};
}

export function mapStreamyboxStats(
  event: Extract<StreamyboxEvent, { type: 'stats' }>
): EngineStats {
  const decoder = [event.decoder, event.hwdec && `hwdec=${event.hwdec}`].filter(Boolean).join(' ');
  return {
    ...(decoder ? { decoder } : {}),
    ...(typeof event.droppedFrames === 'number' ? { droppedFrames: event.droppedFrames } : {}),
    ...(typeof event.totalFrames === 'number' ? { totalFrames: event.totalFrames } : {}),
  };
}

/** The picture's display aspect: the player's `aspect`, else width / height; 0 = unknown (the surface fills its area). */
export function videoAspect(video: RawVideo | null | undefined): number {
  const aspect = video?.aspect;
  if (typeof aspect === 'number' && Number.isFinite(aspect) && aspect > 0) return aspect;
  const width = video?.width ?? 0;
  const height = video?.height ?? 0;
  return width > 0 && height > 0 ? width / height : 0;
}

export type SurfaceRect = { left: number; top: number; width: number; height: number };

/** The surface in a width × height area, centred: `contain` letterboxes, `cover` overfills; null = fill the area. */
export function surfaceRect(
  width: number,
  height: number,
  aspect: number,
  fit: SurfaceProps['fit'] = 'contain'
): SurfaceRect | null {
  if (!(width > 0 && height > 0 && aspect > 0)) return null;
  const wider = width / height > aspect;
  const byHeight = fit === 'cover' ? !wider : wider;
  const w = byHeight ? height * aspect : width;
  const h = byHeight ? height : width / aspect;
  return { left: (width - w) / 2, top: (height - h) / 2, width: w, height: h };
}

/** mediacodec_embed fills its surface: the view takes the picture's shape, re-laid-out on every area or aspect change. */
/** Bitmap formats the player draws into the picture itself; Streamarr never draws over them. */
const BITMAP_SUBTITLES = new Set([
  'hdmv_pgs_subtitle',
  'pgs',
  'pgssub',
  'dvd_subtitle',
  'dvdsub',
  'dvb_subtitle',
  'dvbsub',
  'xsub',
]);

/** A cue as plain lines: ASS override blocks and HTML-style tags go, `\N` breaks a line. */
export function cueText(text: string | undefined): string {
  return (text ?? '')
    .replace(/\{[^}]*\}/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\\[Nn]/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n');
}

/** Where a cue sits in the area: bottom-centre inside the visible picture, above the TV-safe edge and a lifted control bar. */
export function cueBox(
  area: { width: number; height: number },
  rect: SurfaceRect | null,
  lift = 0
): { left: number; width: number; bottom: number; fontSize: number } {
  const top = Math.max(0, rect?.top ?? 0);
  const bottomEdge = Math.min(area.height, rect ? rect.top + rect.height : area.height);
  const left = Math.max(0, rect?.left ?? 0);
  const right = Math.min(area.width, rect ? rect.left + rect.width : area.width);
  const picture = Math.max(0, bottomEdge - top);
  const below = area.height - bottomEdge;
  const bottom = Math.max(below + picture * CUE_INSET, area.height * TV_SAFE, area.height * lift);
  return {
    left,
    width: Math.max(0, right - left),
    bottom,
    fontSize: Math.max(12, Math.round(picture * CUE_SIZE)),
  };
}

const CUE_INSET = 0.06;
const TV_SAFE = 0.05;
const CUE_SIZE = 0.048;

function Cue({ text, box }: { text: string; box: ReturnType<typeof cueBox> }) {
  return (
    <View
      testID="streamybox-cue"
      pointerEvents="none"
      style={{
        position: 'absolute',
        left: box.left,
        width: box.width,
        bottom: box.bottom,
        alignItems: 'center',
      }}>
      <Text
        testID="streamybox-cue-text"
        style={[
          styles.cue,
          {
            fontSize: box.fontSize,
            lineHeight: Math.round(box.fontSize * 1.25),
            maxWidth: box.width * 0.84,
          },
        ]}>
        {text}
      </Text>
    </View>
  );
}

function FittedSurface({
  style,
  aspect,
  fit,
  cue,
  lift,
  children,
}: {
  style: StyleProp<ViewStyle>;
  aspect: number;
  fit: SurfaceProps['fit'];
  cue: string;
  lift: number;
  children: (style: StyleProp<ViewStyle>) => ReactNode;
}) {
  const [area, setArea] = useState({ width: 0, height: 0 });
  const rect = surfaceRect(area.width, area.height, aspect, fit);
  return (
    <View
      testID="streamybox-surface"
      style={[style, styles.clip]}
      onLayout={({ nativeEvent: { layout } }) =>
        setArea((previous) =>
          previous.width === layout.width && previous.height === layout.height
            ? previous
            : { width: layout.width, height: layout.height }
        )
      }>
      {children(rect ? { position: 'absolute', ...rect } : StyleSheet.absoluteFill)}
      {cue && area.height > 0 ? <Cue text={cue} box={cueBox(area, rect, lift)} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  clip: { overflow: 'hidden' },
  cue: {
    color: colors.foreground.DEFAULT,
    textAlign: 'center',
    fontWeight: '600',
    textShadowColor: colors.video,
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 6,
  },
});

/** The server's HLS subtitle renditions (WebVTT media playlists) in playlist order, as absolute URLs. */
export function hlsSubtitleRenditions(master: string, base: string): ExternalSubtitle[] {
  const result: ExternalSubtitle[] = [];
  for (const line of master.split(/\r?\n/)) {
    if (!line.startsWith('#EXT-X-MEDIA:') || !/TYPE=SUBTITLES/.test(line)) continue;
    const attribute = (name: string) => new RegExp(`${name}="([^"]*)"`).exec(line)?.[1];
    const uri = attribute('URI');
    if (!uri) continue;
    let url: string;
    try {
      url = new URL(uri, base).toString();
    } catch {
      continue;
    }
    const title = attribute('NAME');
    const language = attribute('LANGUAGE');
    result.push({ url, ...(title ? { title } : {}), ...(language ? { language } : {}) });
  }
  return result;
}

type Props = {
  source: string | null;
  loadOptions: string;
  loadNonce: number;
  /** A new native view (fresh binding) after the binding failed. */
  viewKey: number;
  paused: boolean;
  muted: boolean;
  audioTrack?: number;
  subtitleTrack: number;
  seekMs: number;
  seekNonce: number;
  /** Display aspect of the current video; 0 = not known yet (the surface fills its area). */
  videoAspect: number;
  /** The text cue Streamarr draws over the picture; empty = none. */
  cue: string;
  /** Share of the area the visible control bar covers from the bottom: cues sit above it. */
  cueLift: number;
};

type LoadOptions = {
  title?: string;
  startPositionMs?: number;
  externalSubtitles?: ExternalSubtitle[];
};

/** The view takes the video's aspect (`tracks.video`): the player may let the decoder fill the surface (mediacodec_embed). */
const SURFACE_FITS_VIDEO = { surfaceFitsVideo: true } as const;
/** Aspect changes below this are rounding, not a new picture shape. */
const ASPECT_EPSILON = 0.001;

/** Streamybox embedded player: dev.streamybox.player renders mpv (Dolby Vision tone-mapped) into Streamarr's surface. */
export class StreamyboxEngine extends EngineBase implements PlayerEngine {
  readonly kind = 'streamybox' as const;
  private readonly props = new PropsStore<Props>({
    source: null,
    loadOptions: '{}',
    loadNonce: 0,
    viewKey: 0,
    paused: false,
    muted: effectiveMuted(false),
    subtitleTrack: -1,
    seekMs: 0,
    seekNonce: 0,
    videoAspect: 0,
    cue: '',
    cueLift: 0,
  });
  private readonly view = createRef<StreamyboxViewRef>();
  private options: LoadOptions = {};
  private bindingBroken = false;
  private ended = false;
  /** The player released mpv (ended or a fatal error): only a new `load` plays again. */
  private spent = false;
  /** The viewer's tracks across a reload of a released mpv. */
  private carried: Pick<Props, 'audioTrack' | 'subtitleTrack'> | null = null;
  private firstFrame = false;
  private statsAt = 0;
  private hasVideo = false;
  private bitmapSubtitle = false;
  /** Bumped by every load: an HLS playlist read for an older load is dropped. */
  private loadSeq = 0;

  readonly Surface = createPropsSurface(this.props, (props, style, fit) => {
    const Player = StreamyboxPlayerView;
    if (!Player || !props.source) return null;
    return (
      <FittedSurface
        style={style}
        aspect={props.videoAspect}
        fit={fit}
        cue={props.cue}
        lift={props.cueLift}>
        {(fitted) => (
          <Player
            key={props.viewKey}
            ref={this.view}
            style={fitted}
            source={props.source}
            loadOptions={props.loadOptions}
            loadNonce={props.loadNonce}
            paused={props.paused}
            muted={props.muted}
            audioTrack={props.audioTrack}
            subtitleTrack={props.subtitleTrack}
            seekMs={props.seekMs}
            seekNonce={props.seekNonce}
            onPlayerEvent={(event: StreamyboxNativeEvent) => this.onNative(event.nativeEvent.json)}
          />
        )}
      </FittedSurface>
    );
  });

  /** One contract event from the player process. */
  onNative(json: string): void {
    const event = parseStreamyboxEvent(json);
    if (!event || this.released) return;
    for (const mapped of this.map(event)) this.emit(mapped);
  }

  private map(event: StreamyboxEvent): EngineEvent[] {
    switch (event.type) {
      case 'state': {
        const state = event.state as EngineState;
        // The player passes through idle/error phases while it opens a file: errors count from `error` events only.
        if (!STATES.has(state) || state === 'idle' || state === 'error') return [];
        if (state === 'ended') return this.endEvents();
        return [{ type: 'state', state }];
      }
      case 'time':
        return [
          {
            type: 'time',
            position: seconds(event.positionMs),
            duration: seconds(event.durationMs),
            ...(typeof event.bufferedMs === 'number'
              ? { buffered: seconds(event.bufferedMs) }
              : {}),
          },
        ];
      case 'buffering':
        return [{ type: 'buffering', buffering: !!event.buffering }];
      case 'firstFrame':
        this.firstFrame = true;
        return [{ type: 'firstFrame' }];
      case 'tracks': {
        const tracks = mapStreamyboxTracks(event);
        this.hasVideo = !!tracks.video;
        this.fitTo(videoAspect(event.video));
        this.bitmapSubtitle = (event.subtitles ?? []).some(
          (track) => track.selected && BITMAP_SUBTITLES.has((track.codec ?? '').toLowerCase())
        );
        if (this.bitmapSubtitle) this.showCue('');
        const output = audioOutputStats(event.audio);
        return output.audioEncoding
          ? [
              { type: 'tracks', tracks },
              { type: 'stats', stats: output },
            ]
          : [{ type: 'tracks', tracks }];
      }
      case 'stats':
        this.statsAt = Date.now();
        return [{ type: 'stats', stats: mapStreamyboxStats(event) }];
      case 'ended':
        this.showCue('');
        return this.endEvents();
      case 'error':
        return this.errorEvents(event);
      case 'subtitle':
        this.showCue(event.visible === false || this.bitmapSubtitle ? '' : cueText(event.text));
        return [];
    }
  }

  private showCue(cue: string): void {
    if (this.props.get().cue !== cue) this.props.set({ cue });
  }

  /** The control bar's share of the screen: cues move above it while it shows (the ceiling is ExoPlayer's own). */
  setSubtitleLift(fraction: number): void {
    const cueLift = Math.min(0.8, Math.max(0, fraction));
    if (this.props.get().cueLift !== cueLift) this.props.set({ cueLift });
  }

  private fitTo(aspect: number): void {
    if (aspect > 0 && Math.abs(aspect - this.props.get().videoAspect) > ASPECT_EPSILON)
      this.props.set({ videoAspect: aspect });
  }

  private endEvents(): EngineEvent[] {
    if (this.ended) return [];
    this.ended = true;
    this.spent = true;
    return [{ type: 'state', state: 'ended' }, { type: 'ended' }];
  }

  private errorEvents(event: Extract<StreamyboxEvent, { type: 'error' }>): EngineEvent[] {
    const reason = event.reason?.trim() || 'streamybox_error';
    // A failed subtitle file does not stop the picture (C22): the player reports it as non-fatal.
    if (event.fatal === false)
      return /sub/i.test(reason)
        ? [
            {
              type: 'subtitleError',
              code: event.status === 404 ? 'unknown_subtitle_stream' : 'subtitle_unavailable',
            },
          ]
        : [];
    if (BINDING_ERROR.test(reason)) this.bindingBroken = true;
    this.spent = true;
    return [
      { type: 'state', state: 'error' },
      typeof event.status === 'number'
        ? { type: 'error', reason, status: event.status }
        : { type: 'error', reason },
    ];
  }

  load(source: EngineSource): void {
    this.resetForLoad(source);
    const seq = ++this.loadSeq;
    this.ended = false;
    this.spent = false;
    this.firstFrame = false;
    this.statsAt = 0;
    this.hasVideo = false;
    if (!StreamyboxPlayerView) {
      this.emit({ type: 'state', state: 'error' });
      this.emit({ type: 'error', reason: 'streamybox_unavailable' });
      return;
    }
    this.options = {
      ...SURFACE_FITS_VIDEO,
      ...(source.title ? { title: source.title } : {}),
      ...(source.startPosition ? { startPositionMs: Math.round(source.startPosition * 1000) } : {}),
    };
    if (source.kind !== 'hls' || !/^https?:/.test(source.uri)) return this.apply(source);
    // mpv (lavf) does not open the WebVTT renditions of an HLS master: they go in as external subtitles.
    void fetch(source.uri)
      .then((response) => (response.ok ? response.text() : ''))
      .catch(() => '')
      .then((master) => {
        if (seq !== this.loadSeq || this.released) return;
        const subtitles = master ? hlsSubtitleRenditions(master, source.uri) : [];
        if (subtitles.length) this.options = { ...this.options, externalSubtitles: subtitles };
        this.apply(source);
      });
  }

  private apply(source: EngineSource): void {
    const props = this.props.get();
    this.props.set({
      source: source.uri,
      loadOptions: JSON.stringify(this.options),
      loadNonce: props.loadNonce + 1,
      viewKey: this.bindingBroken ? props.viewKey + 1 : props.viewKey,
      // Another file has its own shape; a reload of the same one keeps it (no stretched first frame).
      videoAspect: source.uri === props.source ? props.videoAspect : 0,
      cue: '',
      audioTrack: this.carried?.audioTrack,
      subtitleTrack: this.carried?.subtitleTrack ?? -1,
    });
    this.carried = null;
    this.bindingBroken = false;
  }

  play(): void {
    this.props.set({ paused: false });
    if (this.spent && this.source) this.reload(this.ended ? 0 : this.getSnapshot().position);
  }

  pause(): void {
    this.props.set({ paused: true });
  }

  seek(position: number): void {
    const target = Math.max(0, position);
    if (this.spent && this.source) return this.reload(target);
    const seekMs = Math.round(target * 1000);
    // A seek before the session took the load becomes its start position (the native view applies the load first).
    this.options = { ...this.options, startPositionMs: seekMs };
    this.props.set({
      seekMs,
      seekNonce: this.props.get().seekNonce + 1,
      loadOptions: JSON.stringify(this.options),
    });
    this.emit({ type: 'time', position: target, duration: this.getSnapshot().duration });
  }

  /** A released mpv takes no play/seek: the source loads again at `position`, keeping play/pause. */
  private reload(position: number): void {
    if (!this.source) return;
    const { audioTrack, subtitleTrack } = this.props.get();
    this.carried = { audioTrack, subtitleTrack };
    this.load({ ...this.source, startPosition: position });
  }

  setMuted(muted: boolean): void {
    this.props.set({ muted: effectiveMuted(muted) });
  }

  setAudioTrack(id: string): void {
    const aid = Number(id);
    if (!Number.isInteger(aid) || aid < 0) return;
    this.props.set({ audioTrack: aid });
    this.select('audio', id);
  }

  setSubtitleTrack(id: string | null): void {
    const sid = id === null ? -1 : Number(id);
    this.props.set({ subtitleTrack: Number.isInteger(sid) && sid >= 0 ? sid : -1, cue: '' });
    this.select('subtitles', id);
  }

  /** The pick shows at once; the player's next `tracks` event confirms it. */
  private select(kind: 'audio' | 'subtitles', id: string | null): void {
    const tracks = this.getSnapshot().tracks;
    if (!tracks[kind].length) return;
    this.emit({
      type: 'tracks',
      tracks: {
        ...tracks,
        [kind]: tracks[kind].map((track) => ({ ...track, selected: track.id === id })),
      },
    });
  }

  /** The player's frame counters (stats events); nothing once they went stale, so no false frozen picture. */
  async readHealth(): Promise<EngineHealth> {
    if (this.released) return {};
    const { stats } = this.getSnapshot();
    const fresh = this.statsAt > 0 && Date.now() - this.statsAt < STATS_FRESH_MS;
    return {
      ...(fresh && typeof stats.totalFrames === 'number'
        ? { framesPresented: stats.totalFrames }
        : {}),
      ...(fresh && typeof stats.droppedFrames === 'number'
        ? { framesDropped: stats.droppedFrames }
        : {}),
      ...(this.firstFrame ? { readyForDisplay: true } : {}),
      ...(this.hasVideo ? { hasVideoTrack: true } : {}),
    };
  }

  /** Stops the player's decoders before the surface goes away; the session detaches when the view unmounts. */
  async shutdown(): Promise<void> {
    const view = this.view.current;
    if (!view || !this.props.get().source) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      view.stop().catch(() => undefined),
      new Promise<void>((resolve) => (timer = setTimeout(resolve, STOP_TIMEOUT_MS))),
    ]);
    clearTimeout(timer);
  }

  release(): void {
    super.release();
    this.loadSeq += 1;
    this.props.set({ source: null, cue: '' });
  }
}
