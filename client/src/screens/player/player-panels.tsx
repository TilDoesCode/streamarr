'use no memo';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';

import { languageName, reasonTexts } from '@/browse/version-format';
import { VersionPicker } from '@/browse/version-picker';
import { Sheet, SheetItem } from '@/components/ui/sheet';
import { audioCodecLabel, hdrLabel, videoCodecLabel } from '@/lib/media-labels';
import type { AudioTrack, PlaybackController, SubtitleTrack } from '@/player/controller';
import { ENGINE_LABELS } from '@/player/engines';
import { usePlayerT, type PlayerT } from '@/player/use-player-t';

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
export function PlayerPanels({ panel, onClose, controller, title }: Props) {
  const pt = usePlayerT();
  const { t, i18n } = useTranslation();
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
      wide={panel === 'info'}>
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
      {panel === 'info'
        ? infoRows(controller, pt, t).map(([key, value], index) => (
            <SheetItem
              key={key}
              label={value}
              description={pt(`info.${key}`)}
              preferred={index === 0}
              onPress={() => undefined}
            />
          ))
        : null}
    </Sheet>
  );
}

type InfoKey =
  | 'method'
  | 'engine'
  | 'version'
  | 'container'
  | 'video'
  | 'resolution'
  | 'hdr'
  | 'audio'
  | 'subtitle'
  | 'bitrate'
  | 'decoder'
  | 'droppedFrames'
  | 'reasons';

/** "Stats for nerds": what is played, how and why. */
export function infoRows(
  controller: PlaybackController,
  pt: PlayerT,
  t: TFunction
): [InfoKey, string][] {
  const playback = controller.playback;
  const info = playback?.mediaInfo;
  const video = info?.video;
  const snapshot = controller.engine?.getSnapshot();
  const engineVideo = snapshot?.tracks.video;
  const stats = snapshot?.stats;
  const unknown = pt('info.unknown');
  const method = playback?.method ? pt(`methods.${playback.method as 'direct'}`) : unknown;
  const skippedNames = (playback?.decision?.skipped ?? [])
    .filter((item) => item.method && item.method !== playback?.method)
    .map((item) => pt(`methods.${item.method as 'direct'}`));
  const skipped = [...new Set(skippedNames)];
  const audio = info?.audioTracks?.find((track) => track.index === controller.currentAudio());
  const subtitle = info?.subtitleTracks?.find(
    (track) => track.index === controller.currentSubtitle()
  );
  const width = engineVideo?.width ?? video?.width;
  const height = engineVideo?.height ?? video?.deliveredHeight ?? video?.height;
  const range = engineVideo?.range ?? video?.videoRange ?? video?.hdr;
  const reasons = reasonTexts(playback?.decision?.reasons, t);
  return [
    [
      'method',
      skipped.length
        ? pt('info.from', {
            method,
            skipped:
              skipped.length > 1
                ? `${skipped.slice(0, -1).join(', ')} ${pt('info.and')} ${skipped.at(-1)}`
                : skipped[0],
          })
        : method,
    ],
    [
      'engine',
      [
        playback?.engine ? pt(`engines.${playback.engine as 'native'}`) : '',
        controller.engine ? ENGINE_LABELS[controller.engine.kind] : '',
      ]
        .filter(Boolean)
        .join(' · ') || unknown,
    ],
    ['version', playback?.version?.name ?? unknown],
    ['container', info?.container?.toUpperCase() ?? unknown],
    [
      'video',
      video
        ? [
            videoCodecLabel(video.deliveredCodec ?? video.codec ?? ''),
            video.profile,
            video.bitDepth ? `${video.bitDepth}-bit` : '',
            video.fps ? `${Math.round(video.fps * 100) / 100} fps` : '',
          ]
            .filter(Boolean)
            .join(' · ')
        : unknown,
    ],
    ['resolution', width && height ? `${width}×${height}` : unknown],
    ['hdr', range && range !== 'sdr' && range !== 'none' ? hdrLabel(range) : pt('info.sdr')],
    [
      'audio',
      audio
        ? [
            audioCodecLabel(audio.deliveredCodec ?? audio.codec ?? ''),
            `${audio.deliveredChannels ?? audio.channels}ch`,
            audio.language ?? '',
          ]
            .filter(Boolean)
            .join(' · ')
        : unknown,
    ],
    [
      'subtitle',
      subtitle
        ? [subtitle.language, subtitle.codec, subtitle.deliveredAs].filter(Boolean).join(' · ')
        : pt('subtitlesOff'),
    ],
    ['bitrate', info?.bitrateKbps ? pt('info.kbps', { value: info.bitrateKbps }) : unknown],
    ['decoder', stats?.decoder ?? unknown],
    [
      'droppedFrames',
      stats?.droppedFrames !== undefined
        ? `${stats.droppedFrames}${stats.totalFrames ? ` / ${stats.totalFrames}` : ''}`
        : unknown,
    ],
    ['reasons', reasons.join(' · ') || unknown],
  ];
}
