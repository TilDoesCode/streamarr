'use no memo';
import { useTranslation } from 'react-i18next';

import { View } from 'react-native';

import { useVersions } from '@/browse/queries';
import { languageName, plainReasons, versionHeadline } from '@/browse/version-format';
import { Focusable, FocusLift } from '@/components/focus';
import { methodTone, SpecLabel } from '@/components/spec';
import { Text } from '@/components/ui/text';
import { VersionPicker } from '@/browse/version-picker';
import { Sheet, SheetItem } from '@/components/ui/sheet';
import { audioCodecLabel } from '@/lib/media-labels';
import type { AudioTrack, PlaybackController, SubtitleTrack } from '@/player/controller';
import { ENGINE_LABELS } from '@/player/engines';
import {
  audioTransfer,
  betterVersion,
  containerTransfer,
  videoTransfer,
} from '@/player/overlay-labels';
import type { Clock } from '@/player/use-clock';
import { usePlayerT, type PlayerT } from '@/player/use-player-t';
import { useShell } from '@/shell/use-shell';
import { colors, fonts } from '@/theme';

export type PanelKind = 'audio' | 'subtitles' | 'version' | 'quality' | 'engine' | 'info';
export const PANELS: readonly PanelKind[] = [
  'audio',
  'subtitles',
  'version',
  'quality',
  'engine',
  'info',
];

const QUALITIES = [null, 2160, 1080, 720, 480] as const;
const ENGINES = ['auto', 'native', 'vlc'] as const;

type Props = {
  panel: PanelKind | null;
  onClose: () => void;
  controller: PlaybackController;
  title: string;
  /** Large shell (TV, web desktop): floating glass panels on the right (Aurora C-player). */
  glass?: boolean;
  clock?: Clock;
  onPanel?: (panel: PanelKind) => void;
};

function trackLabel(
  track: { index: number; language?: string | null; title?: string | null },
  locale: string,
  pt: PlayerT
): string {
  const language = track.language ? languageName(track.language, locale) : '';
  return (
    [language, track.title].filter(Boolean).join(' · ') ||
    pt('trackFallback', { index: track.index })
  );
}

function audioDescription(track: AudioTrack): string {
  const codec = track.codec ? audioCodecLabel(track.codec) : '';
  return [codec, track.channels ? `${track.channels}ch` : ''].filter(Boolean).join(' · ');
}

function subtitleDescription(track: SubtitleTrack, pt: PlayerT): string {
  return [track.codec?.toUpperCase(), track.forced ? pt('forced') : ''].filter(Boolean).join(' · ');
}

/** Audio, subtitle, version, quality, engine and info panels of the player. */
export function PlayerPanels({
  panel,
  onClose,
  controller,
  title,
  glass = false,
  clock,
  onPanel,
}: Props) {
  const pt = usePlayerT();
  const { i18n } = useTranslation();
  const locale = i18n.language;
  const playback = controller.playback;
  const info = playback?.mediaInfo;
  const pick = (action: () => Promise<unknown> | void) => {
    onClose();
    void action();
  };

  if (panel === 'version')
    return (
      <VersionPicker
        open
        onClose={onClose}
        workId={playback?.workId}
        title={title}
        currentReleaseId={playback?.version?.releaseId}
        glass={glass}
        onPlay={(version) => {
          if (version.releaseId && version.releaseId !== playback?.version?.releaseId)
            pick(() => controller.selectVersion(version.releaseId ?? ''));
          else onClose();
        }}
      />
    );

  const audio = controller.currentAudio();
  const subtitle = controller.currentSubtitle();
  const maxHeight = controller.preferences.maxHeight ?? null;
  const engine = controller.preferences.engine ?? 'auto';

  return (
    <Sheet
      open={panel !== null}
      onClose={onClose}
      testID={panel ? `player-panel-${panel}` : undefined}
      title={panel ? pt(panel === 'info' ? 'info.title' : `controls.${panel}`) : ''}
      subtitle={
        panel === 'quality'
          ? pt('quality.hint')
          : panel === 'engine'
            ? pt('enginePref.hint')
            : undefined
      }
      wide={panel === 'info'}
      glass={glass ? { width: panel === 'info' ? 620 : 520 } : false}
      accessory={
        panel === 'info' && playback?.method ? (
          <SpecLabel
            label={pt(`methods.${playback.method as 'direct'}`)}
            tone={methodTone(playback.method)}
          />
        ) : undefined
      }>
      {panel === 'audio'
        ? (info?.audioTracks ?? []).map((track) => (
            <SheetItem
              key={track.index}
              label={trackLabel(track, locale, pt)}
              description={audioDescription(track)}
              selected={audio === track.index}
              preferred={audio === track.index}
              onPress={() => pick(() => controller.selectAudio(track))}
            />
          ))
        : null}
      {panel === 'subtitles' ? (
        <>
          <SheetItem
            label={pt('subtitlesOff')}
            selected={subtitle === null}
            preferred={subtitle === null}
            onPress={() => pick(() => controller.selectSubtitle(null))}
          />
          {(info?.subtitleTracks ?? []).map((track) => (
            <SheetItem
              key={track.index}
              label={trackLabel(track, locale, pt)}
              description={subtitleDescription(track, pt)}
              selected={subtitle === track.index}
              preferred={subtitle === track.index}
              onPress={() => pick(() => controller.selectSubtitle(track))}
            />
          ))}
        </>
      ) : null}
      {panel === 'quality'
        ? QUALITIES.map((height) => (
            <SheetItem
              key={height ?? 'original'}
              label={height ? pt('quality.height', { height }) : pt('quality.original')}
              selected={maxHeight === height}
              preferred={maxHeight === height}
              onPress={() =>
                pick(() => (maxHeight === height ? undefined : controller.setQuality(height)))
              }
            />
          ))
        : null}
      {panel === 'engine'
        ? ENGINES.map((kind) => (
            <SheetItem
              key={kind}
              label={pt(`enginePref.${kind}`)}
              selected={engine === kind}
              preferred={engine === kind}
              onPress={() =>
                pick(() => (engine === kind ? undefined : controller.setEnginePreference(kind)))
              }
            />
          ))
        : null}
      {panel === 'info' ? (
        <InfoTable controller={controller} clock={clock} onSwitch={() => onPanel?.('version')} />
      ) : null}
    </Sheet>
  );
}

function InfoTable({
  controller,
  clock,
  onSwitch,
}: {
  controller: PlaybackController;
  clock?: Clock;
  onSwitch: () => void;
}) {
  const pt = usePlayerT();
  const { t } = useTranslation();
  const { s, font } = useShell();
  const playback = controller.playback;
  const info = playback?.mediaInfo;
  const versions = useVersions(playback?.workId, !!playback?.workId);
  const better = betterVersion(
    versions.data?.versions ?? [],
    playback?.version?.releaseId,
    playback?.method
  );
  const stats = controller.engine?.getSnapshot().stats;
  const audio = info?.audioTracks?.find((track) => track.index === controller.currentAudio());
  const method = playback?.method;
  const why =
    plainReasons(playback?.decision?.reasons, t).join('\n') ||
    (method ? t(`versions.plain.${method as 'direct'}`) : undefined);
  const ahead = clock ? Math.max(0, Math.round(clock.buffered - clock.position)) : undefined;
  const engine = [
    controller.engine ? ENGINE_LABELS[controller.engine.kind] : '',
    stats?.decoder ?? '',
  ]
    .filter(Boolean)
    .join(' · ');
  const rows: [string, string | null | undefined, boolean][] = [
    [pt('info.method'), method ? pt(`methods.${method as 'direct'}`) : null, false],
    [pt('info.why'), why, false],
    [pt('info.video'), videoTransfer(info?.video), true],
    [pt('info.audio'), audioTransfer(audio), true],
    [pt('info.container'), containerTransfer(info?.container, method), true],
    [
      pt('info.bitrate'),
      info?.bitrateKbps ? `${Math.round(info.bitrateKbps / 100) / 10} Mbit/s` : null,
      true,
    ],
    [pt('info.engine'), engine, false],
    [
      pt('info.buffer'),
      [
        ahead !== undefined ? pt('info.bufferAhead', { seconds: ahead }) : '',
        stats?.droppedFrames !== undefined
          ? pt('info.dropped', { count: stats.droppedFrames })
          : '',
      ]
        .filter(Boolean)
        .join(' · '),
      false,
    ],
  ];
  const text = { fontSize: font(21, 14), lineHeight: font(29, 19) };
  return (
    <View testID="player-info-table" style={{ gap: s(10), paddingBottom: s(8) }}>
      {rows.map(([label, value, spec]) => (
        <View key={label} style={{ flexDirection: 'row', gap: s(24) }}>
          <Text tone="muted" style={[text, { width: s(150) }]}>
            {label}
          </Text>
          <Text
            style={[
              text,
              { flex: 1, color: colors.foreground.DEFAULT },
              spec && { fontFamily: fonts.mono, fontSize: font(19, 13), letterSpacing: s(0.3) },
            ]}>
            {value || pt('info.unknown')}
          </Text>
        </View>
      ))}
      {better ? (
        <Focusable
          testID="player-info-better"
          role="button"
          onPress={onSwitch}
          accessibilityLabel={pt('info.switch')}>
          <FocusLift kind="none" radius={s(24)}>
            <View
              style={{
                marginTop: s(10),
                padding: s(20),
                borderRadius: s(24),
                backgroundColor: colors.glass.subtle,
                gap: s(8),
              }}>
              <Text style={[text, { color: colors.foreground.DEFAULT }]}>
                {pt('info.better', { version: versionHeadline(better) || better.name })}
              </Text>
              <Text
                style={[text, { color: colors.accent.DEFAULT, fontFamily: fonts.bodySemiBold }]}>
                {pt('info.switch')}
              </Text>
            </View>
          </FocusLift>
        </Focusable>
      ) : null}
    </View>
  );
}
