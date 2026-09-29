'use no memo';
// The overlay reads a mutable PlayerSession; React Compiler memoisation would freeze it.

import {
  Activity,
  AudioLines,
  Pause,
  Play,
  Rewind,
  FastForward,
  Square,
} from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

import { useBackHandler } from '@/components/focus';
import { Button } from '@/components/ui/button';
import { Sheet, SheetItem } from '@/components/ui/sheet';
import { Text } from '@/components/ui/text';
import { ENGINE_LABELS } from '@/player/engines';
import { useRemoteKeys, type RemoteAction } from '@/player/remote-keys';
import { colors, useDesign } from '@/theme';

import type { PlayerSession } from './player-session';

function clock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, '0')}`;
}

const dash = (value: number | string | undefined | null) =>
  value === undefined || value === null ? '–' : String(value);

/** Re-renders at most every `ms` while the session changes (keeps the JS thread free for the engine). */
function useThrottledSession(session: PlayerSession, ms: number): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = session.onChange(() => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        setVersion((value) => value + 1);
      }, ms);
    });
    return () => {
      unsubscribe();
      if (timer) clearTimeout(timer);
    };
  }, [session, ms]);
  return version;
}

function useOverlayLines(session: PlayerSession): string[] {
  const { t } = useTranslation();
  const playback = session.playback;
  const engine = session.engine;
  const metrics = session.recorder?.metrics;
  const snapshot = engine?.getSnapshot();
  const lines: string[] = [];
  if (session.phase === 'starting')
    lines.push(t('devPlayer.overlay.starting', { variant: session.options.variant.id }));
  lines.push(
    t('devPlayer.overlay.server', {
      state: dash(playback?.state),
      method: dash(playback?.method),
      engine: dash(playback?.engine),
      ms: dash(session.apiMs),
    }),
    t('devPlayer.overlay.states', { states: session.serverStates.join(' › ') })
  );
  if (playback?.fallbackFrom?.name)
    lines.push(t('devPlayer.overlay.fallback', { name: playback.fallbackFrom.name }));
  const reasons = (playback?.decision?.reasons ?? []).map((reason) => reason.code).join(', ');
  if (reasons) lines.push(t('devPlayer.overlay.reasons', { codes: reasons }));
  if (session.phase === 'failed')
    lines.push(t('devPlayer.overlay.failed', { code: dash(session.error) }));
  if (engine && snapshot && metrics) {
    const video = snapshot.tracks.video ?? metrics.video;
    lines.push(
      t('devPlayer.overlay.engine', {
        engine: ENGINE_LABELS[engine.kind],
        state: snapshot.state,
        position: clock(snapshot.position),
        duration: clock(snapshot.duration),
      }),
      t('devPlayer.overlay.startup', {
        ttff: dash(metrics.ttffMs),
        startup: dash(metrics.startupMs),
      }),
      t('devPlayer.overlay.seeks', {
        list:
          metrics.seeks.map((seek) => `${Math.round(seek.target)}s:${dash(seek.ms)}`).join(' ') ||
          '–',
      }),
      t('devPlayer.overlay.buffering', { count: metrics.rebuffers, ms: metrics.rebufferMs }),
      t('devPlayer.overlay.frames', {
        dropped: dash(metrics.droppedFrames),
        total: dash(metrics.totalFrames),
      }),
      t('devPlayer.overlay.decoder', {
        name: dash(metrics.decoder),
        kind:
          metrics.decoderHardware === undefined
            ? 'unknown'
            : metrics.decoderHardware
              ? 'hardware'
              : 'software',
      }),
      t('devPlayer.overlay.video', {
        size: video?.width ? `${video.width}×${video.height}` : '–',
        range: video?.range ?? '',
        bitrate: metrics.bandwidth ? `${Math.round(metrics.bandwidth / 1000)} kbit/s` : '–',
      }),
      t('devPlayer.overlay.tracks', {
        audio:
          snapshot.tracks.audio
            .map((track) => `${track.selected ? '●' : '○'}${track.label}`)
            .join(' ') || '–',
        subtitles:
          snapshot.tracks.subtitles
            .map((track) => `${track.selected ? '●' : '○'}${track.label}`)
            .join(' ') || '–',
      })
    );
    if (metrics.switches.length)
      lines.push(
        t('devPlayer.overlay.switches', {
          list: metrics.switches
            .map((item) => `${item.kind}/${item.via}:${dash(item.ms)}`)
            .join(' '),
        })
      );
    if (metrics.keys.length)
      lines.push(
        t('devPlayer.overlay.keys', {
          list: metrics.keys.map((key) => `${key.key}→${key.action}`).join(' '),
        })
      );
    if (metrics.errors.length)
      lines.push(t('devPlayer.overlay.error', { message: metrics.errors.join('; ') }));
  }
  return lines;
}

export type PlayerViewProps = {
  session: PlayerSession;
  measuring: boolean;
  onMeasure: () => void;
  onExit: () => void;
};

/** Fullscreen lab player: engine surface, statistics overlay, remote keys, track panel. */
export function PlayerView({ session, measuring, onMeasure, onExit }: PlayerViewProps) {
  const { t } = useTranslation();
  const design = useDesign();
  useThrottledSession(session, 250);
  const [tracksOpen, setTracksOpen] = useState(false);
  const [statsVisible, setStatsVisible] = useState(true);
  const lines = useOverlayLines(session);
  const engine = session.engine;
  const Surface = engine?.Surface;
  const state = engine?.getSnapshot().state;
  const playing = state === 'playing' || state === 'buffering';
  const info = session.playback?.mediaInfo;

  const act = (action: RemoteAction, key: string) => {
    session.recorder?.markKey(key, action);
    switch (action) {
      case 'toggle':
        session.togglePlay();
        break;
      case 'play':
        session.setPaused(false);
        break;
      case 'pause':
        session.setPaused(true);
        break;
      case 'back10':
        session.seekBy(-10);
        break;
      case 'forward30':
        session.seekBy(30);
        break;
      case 'rewind':
        session.seekBy(-30);
        break;
      case 'fastForward':
        session.seekBy(60);
        break;
      case 'up':
        setTracksOpen(true);
        break;
      case 'down':
        setStatsVisible((value) => !value);
        break;
      case 'stop':
        onExit();
        break;
    }
  };

  useRemoteKeys(!tracksOpen, act);
  useBackHandler(() => {
    session.recorder?.markKey('back', tracksOpen ? 'closePanel' : 'stop');
    if (tracksOpen) setTracksOpen(false);
    else onExit();
    return true;
  });

  const gutter = design.layout.gutter;
  return (
    <View testID="dev-player-view" style={{ flex: 1, backgroundColor: colors.video }}>
      {Surface ? <Surface style={StyleSheet.absoluteFill} /> : null}
      {statsVisible ? (
        <View
          pointerEvents="none"
          style={{
            position: 'absolute',
            top: design.layout.edgeVertical,
            left: gutter,
            maxWidth: design.window.width * (design.isTV ? 0.55 : 0.9),
            padding: design.space.md,
            gap: design.space.xxs,
            borderRadius: design.radius.md,
            backgroundColor: colors.scrim.DEFAULT,
          }}>
          {lines.map((line, index) => (
            <Text key={index} variant="caption" testID={`dev-player-line-${index}`}>
              {line}
            </Text>
          ))}
          {design.isTV ? (
            <Text variant="caption" tone="muted">
              {t('devPlayer.overlay.hint')}
            </Text>
          ) : null}
        </View>
      ) : null}
      {design.isTV ? null : (
        <View
          style={{
            position: 'absolute',
            left: gutter,
            right: gutter,
            bottom: design.layout.edgeVertical,
            flexDirection: 'row',
            flexWrap: 'wrap',
            gap: design.space.sm,
          }}>
          <Button
            testID="dev-player-toggle"
            size="sm"
            icon={playing ? Pause : Play}
            label={t(playing ? 'devPlayer.controls.pause' : 'devPlayer.controls.play')}
            onPress={() => act('toggle', 'button')}
          />
          <Button
            size="sm"
            variant="secondary"
            icon={Rewind}
            label={t('devPlayer.controls.back10')}
            onPress={() => act('back10', 'button')}
          />
          <Button
            size="sm"
            variant="secondary"
            icon={FastForward}
            label={t('devPlayer.controls.forward30')}
            onPress={() => act('forward30', 'button')}
          />
          <Button
            testID="dev-player-tracks"
            size="sm"
            variant="secondary"
            icon={AudioLines}
            label={t('devPlayer.controls.tracks')}
            onPress={() => setTracksOpen(true)}
          />
          <Button
            testID="dev-player-measure"
            size="sm"
            variant="secondary"
            icon={Activity}
            loading={measuring}
            label={t('devPlayer.controls.measure')}
            onPress={onMeasure}
          />
          <Button
            size="sm"
            variant="ghost"
            label={t('devPlayer.controls.stats')}
            onPress={() => setStatsVisible((value) => !value)}
          />
          <Button
            testID="dev-player-stop"
            size="sm"
            variant="destructive"
            icon={Square}
            label={t('devPlayer.controls.stop')}
            onPress={onExit}
          />
        </View>
      )}
      <Sheet
        open={tracksOpen}
        onClose={() => setTracksOpen(false)}
        title={t('devPlayer.tracks.title')}>
        {(info?.audioTracks ?? []).map((track) => (
          <SheetItem
            key={`a${track.index}`}
            label={t('devPlayer.tracks.audio', {
              label: track.title ?? track.language ?? track.index,
            })}
            description={t('devPlayer.tracks.delivery', {
              codec: track.codec ?? '',
              channels: track.channels ? String(track.channels) : 'none',
              delivered: track.deliveredAs ?? '',
            })}
            selected={!!track.selected}
            preferred={!!track.selected}
            onPress={() => {
              setTracksOpen(false);
              void session.selectAudio(track);
            }}
          />
        ))}
        {(info?.subtitleTracks ?? []).map((track) => (
          <SheetItem
            key={`s${track.index}`}
            label={t('devPlayer.tracks.subtitle', {
              label: track.title ?? track.language ?? track.index,
            })}
            description={t('devPlayer.tracks.delivery', {
              codec: track.codec ?? '',
              channels: 'none',
              delivered: track.deliveredAs ?? '',
            })}
            onPress={() => {
              setTracksOpen(false);
              void session.selectSubtitle(track);
            }}
          />
        ))}
        <SheetItem
          label={t('devPlayer.tracks.off')}
          onPress={() => {
            setTracksOpen(false);
            void session.selectSubtitle(null);
          }}
        />
      </Sheet>
    </View>
  );
}
