import type { TFunction } from 'i18next';
import {
  ArrowRightLeft,
  CircleCheck,
  CircleHelp,
  History,
  RefreshCw,
  TrafficCone,
  type LucideIcon,
} from 'lucide-react-native';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, Pressable, View } from 'react-native';

import type { PlayTarget } from '@/browse/play-target';
import type { Version } from '@/browse/queries';
import {
  predictedMethod,
  reasonTexts,
  versionSpec,
  type PredictedMethod,
} from '@/browse/version-format';
import { methodTone, SPEC_TONES } from '@/components/spec';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useFormat } from '@/i18n/format';
import {
  audioCodecLabel,
  hdrLabel,
  MEDIA_LABELS,
  resolutionLabel,
  videoCodecLabel,
} from '@/lib/media-labels';
import { MIN_TEXT } from '@/shell/shell-metrics';
import { useShell } from '@/shell/use-shell';
import { colors, fonts } from '@/theme';

/** Fixed block (1920 × 1080 points): gap to the buttons, chip row, gap, reason line. */
export const CHIPS = { top: 22, row: 44, gap: 10, reason: 28, chipGap: 10 } as const;

export type SpecChipKey = 'resolution' | 'hdr' | 'video' | 'audio' | 'source' | 'size';
export type SpecChip = { key: SpecChipKey; label: string; muted?: boolean };

// Chips name the short Dolby forms like release names do.
const CHIP_AUDIO: Record<string, string> = { ac3: 'DD', eac3: 'DD+' };
const chipAudio = (codec: string) => CHIP_AUDIO[codec.toLowerCase()] ?? audioCodecLabel(codec);

/** Spec chips of one version in reading order: resolution, HDR, video (+bit), audio + channels, source, size. */
export function specChips(
  version: Version,
  t: TFunction,
  fileSize: (bytes: number) => string
): SpecChip[] {
  const spec = versionSpec(version);
  const chips: SpecChip[] = [];
  if (spec?.resolution) chips.push({ key: 'resolution', label: spec.resolution });
  if (spec?.hdr) chips.push({ key: 'hdr', label: spec.hdr });
  if (version.videoCodec)
    chips.push({
      key: 'video',
      label:
        version.bitDepth && version.bitDepth > 8
          ? t('versions.bitDepth', {
              codec: videoCodecLabel(version.videoCodec),
              bits: version.bitDepth,
            })
          : videoCodecLabel(version.videoCodec),
    });
  const audio = [
    version.audioCodec ? chipAudio(version.audioCodec) : null,
    version.audioChannels,
    version.atmos ? MEDIA_LABELS.atmos : null,
  ].filter(Boolean);
  if (audio.length) chips.push({ key: 'audio', label: audio.join(' ') });
  if (version.source) chips.push({ key: 'source', label: version.source });
  // A season pack's size is the whole season.
  if (version.sizeBytes && !version.seasonPack)
    chips.push({ key: 'size', label: fileSize(version.sizeBytes), muted: true });
  return chips;
}

/** Audio chip without the codec ("7.1 Atmos"), or null when only the codec is known. */
function channelsOnly(version: Version): string | null {
  const parts = [version.audioChannels, version.atmos ? MEDIA_LABELS.atmos : null].filter(Boolean);
  return parts.length ? parts.join(' ') : null;
}

/** The chips that fit `width`: drops size, source, the audio codec (channels stay), video codec — in that order. */
export function fitChips(
  chips: readonly SpecChip[],
  version: Version,
  width: number,
  widthOf: (chip: SpecChip) => number,
  gap: number
): SpecChip[] {
  const total = (list: readonly SpecChip[]) =>
    list.reduce((sum, chip, index) => sum + widthOf(chip) + (index ? gap : 0), 0);
  let list = [...chips];
  const steps: ((current: SpecChip[]) => SpecChip[])[] = [
    (current) => current.filter((chip) => chip.key !== 'size'),
    (current) => current.filter((chip) => chip.key !== 'source'),
    (current) => {
      const channels = channelsOnly(version);
      return current.flatMap((chip) =>
        chip.key !== 'audio' ? [chip] : channels ? [{ ...chip, label: channels }] : []
      );
    },
    (current) => current.filter((chip) => chip.key !== 'video'),
  ];
  for (const step of steps) {
    if (total(list) <= width) break;
    list = step(list);
  }
  return list;
}

const SHORT_REASONS = new Set([
  'audio_codec_unsupported',
  'audio_converted',
  'bit_depth_unsupported',
  'dolby_vision_profile_unsupported',
  'hdr_unsupported',
  'image_subtitle_vlc',
  'resolution_exceeds_limit',
  'subtitle_burned_in',
  'video_codec_not_remuxable',
  'video_codec_unsupported',
  'vlc_fallback',
  'bitrate_exceeds_limit',
]);

// Engine, then picture before sound before subtitles (the panel's reasonWeight order).
const WEIGHT = [
  'vlc',
  'image',
  'video',
  'hdr',
  'dolby',
  'bit_depth',
  'resolution',
  'audio',
  'subtitle',
  'bitrate',
];
const weight = (code: string) => {
  const index = WEIGHT.findIndex((prefix) => code.startsWith(prefix));
  return index < 0 ? WEIGHT.length : index;
};

/** Short reasons for the chip row (max two); direct stream names only audio conversions, repackaging stays quiet. */
export function shortReasons(version: Version, method: PredictedMethod, t: TFunction): string[] {
  if (method === 'direct' || method === 'unknown') return [];
  const reasons = (version.predictionReasons ?? []).filter(
    (reason): reason is { code: string; params?: Record<string, string> | null } =>
      !!reason.code &&
      SHORT_REASONS.has(reason.code) &&
      (method !== 'remux' || reason.code.startsWith('audio_'))
  );
  const converted = reasons.some((reason) => reason.code === 'audio_converted');
  return reasons
    .filter((reason) => !(converted && reason.code === 'audio_codec_unsupported'))
    .sort((a, b) => weight(a.code) - weight(b.code))
    .slice(0, 2)
    .map((reason) => {
      const params = reason.params ?? {};
      return t(`versions.reasonsShort.${reason.code}` as 'versions.reasonsShort.hdr_unsupported', {
        ...params,
        codec: params.codec
          ? reason.code.startsWith('audio_')
            ? chipAudio(params.codec)
            : videoCodecLabel(params.codec)
          : '',
        from: params.from ? chipAudio(params.from) : '',
        to: params.to ? chipAudio(params.to) : '',
        hdr: params.hdr ? hdrLabel(params.hdr) : 'HDR',
      });
    });
}

/** "1080p WEB-DL": how the reason line names another version. */
export function versionName(version: Version): string {
  const hdr = version.hdrFormats?.[0] ?? version.hdr;
  return [
    version.resolution ? resolutionLabel(version.resolution) : null,
    hdr ? hdrLabel(hdr) : null,
    version.source,
  ]
    .filter(Boolean)
    .join(' ');
}

export type ReasonPart = { text: string; tone: 'method' | 'plain' | 'muted' | 'ok' };
/** One phrase of the reason line; phrases are joined with " · ". */
export type ReasonSegment = ReasonPart[];

const SEGMENT_GAP = '  ·  ';

/** Plain text of reason segments as the line renders them. */
export function reasonText(segments: readonly ReasonSegment[]): string {
  return segments.map((segment) => segment.map((part) => part.text).join(' ')).join(SEGMENT_GAP);
}

/** Reason segments that fit `width`: drop "in „Versions“", then trailing segments; the first always stays. */
export function fitReasons(
  segments: readonly ReasonSegment[],
  width: number,
  widthOf: (text: string) => number,
  inVersions: string
): ReasonSegment[] {
  const fits = (list: readonly ReasonSegment[]) => widthOf(reasonText(list)) <= width;
  let list = [...segments];
  if (fits(list)) return list;
  list = list.map((segment) => segment.filter((part) => part.text !== inVersions));
  while (list.length > 1 && !fits(list)) list = list.slice(0, -1);
  return list;
}

/** The reason line under the chips: reasons (not direct), a direct alternative, else the gap to the best version. */
export function reasonLine(
  target: PlayTarget,
  versions: readonly Version[],
  t: TFunction
): ReasonSegment[] {
  if (target.state === 'error') return [[{ text: t('versions.chips.error'), tone: 'muted' }]];
  if (target.state !== 'ready') return [];
  const segments: ReasonSegment[] = [];
  if (target.method === 'unknown')
    segments.push([{ text: t('versions.chips.unknown'), tone: 'plain' }]);
  for (const reason of shortReasons(target.version, target.method, t))
    segments.push([{ text: reason, tone: 'method' }]);
  if (target.lastPlayedMissing)
    segments.push([{ text: t('versions.chips.lastMissing'), tone: 'muted' }]);
  if (target.directAlternative)
    segments.push([
      { text: t('versions.chips.directPossible'), tone: 'plain' },
      { text: versionName(target.directAlternative), tone: 'ok' },
      { text: t('versions.chips.inVersions'), tone: 'plain' },
    ]);
  else if (!segments.length) {
    const best = versions.reduce<Version | undefined>(
      (top, version) =>
        !top || (version.qualityRank ?? version.rank) < (top.qualityRank ?? top.rank)
          ? version
          : top,
      undefined
    );
    const headline = (version: Version) =>
      [versionSpec(version)?.resolution, versionSpec(version)?.hdr].filter(Boolean).join(' · ');
    if (best && best !== target.version && headline(best) !== headline(target.version)) {
      const method = predictedMethod(best) ?? 'unknown';
      segments.push([
        {
          text: t(`versions.chips.betterOnly.${method}` as 'versions.chips.betterOnly.direct', {
            best: headline(best),
          }),
          tone: 'muted',
        },
      ]);
    }
  }
  return segments;
}

const METHOD_ICON: Record<PredictedMethod, LucideIcon> = {
  direct: CircleCheck,
  remux: ArrowRightLeft,
  transcode: RefreshCw,
  vlc: TrafficCone,
  unknown: CircleHelp,
};

export type VersionChipsProps = {
  target: PlayTarget;
  versions: readonly Version[];
  /** "movie" or "episode": the wording when there is no version. */
  kind?: 'movie' | 'episode';
  /** iPad/web: the row opens the version sheet. */
  onPress?: () => void;
  testID?: string;
};

/** D2b chip row: the version and playback method the main button starts, in a fixed-height block. */
export function VersionChips({
  target,
  versions,
  kind = 'movie',
  onPress,
  testID = 'play-chips',
}: VersionChipsProps) {
  const { t } = useTranslation();
  const format = useFormat();
  const { s, font } = useShell();
  const [width, setWidth] = useState(0);
  const [tip, setTip] = useState(false);
  const specSize = font(18, MIN_TEXT.spec);
  const methodSize = font(22, MIN_TEXT.caption);
  const reasonSize = font(20, MIN_TEXT.caption);
  const chipPad = s(12);
  const gap = s(CHIPS.chipGap);
  const ready = target.state === 'ready' ? target : undefined;
  const method: PredictedMethod = ready?.method ?? 'unknown';
  const tone = SPEC_TONES[methodTone(method)];
  // Nested spans repeat the whole style: Text re-applies its variant size otherwise.
  const reasonStyle = {
    fontFamily: fonts.bodySemiBold,
    fontSize: reasonSize,
    lineHeight: s(CHIPS.reason),
  };
  const partColor = (part: ReasonPart['tone']) =>
    part === 'method'
      ? tone.fg
      : part === 'ok'
        ? SPEC_TONES.ok.fg
        : part === 'muted'
          ? colors.foreground.muted
          : colors.foreground.DEFAULT;
  const methodLabel = t(`versions.methodShort.${method}`);
  const marker = ready?.isLastPlayed && !ready.version.recommended;
  // Monospace caps: ~0.6 em per character; the method chip and the marker are reserved first.
  const methodWidth = methodLabel.length * methodSize * 0.58 + s(24 + 10 + 28) + 4;
  const markerWidth = marker ? t('versions.current').length * font(17, 11) * 0.56 + s(70) : 0;
  const widthOf = (chip: SpecChip) => chip.label.length * specSize * 0.62 + chipPad * 2 + 2;
  const chips = ready ? specChips(ready.version, t, format.fileSize) : [];
  const shown = ready
    ? width
      ? fitChips(
          chips,
          ready.version,
          width - methodWidth - gap - (marker ? markerWidth + gap : 0),
          widthOf,
          gap
        )
      : chips
    : [];
  // Figtree semibold averages ~0.52 em per character.
  const allReasons = reasonLine(target, versions, t);
  const reasons = width
    ? fitReasons(
        allReasons,
        width,
        (text) => text.length * reasonSize * 0.52,
        t('versions.chips.inVersions')
      )
    : allReasons;
  const block = s(CHIPS.top + CHIPS.row + CHIPS.gap + CHIPS.reason);
  const label =
    ready || target.state === 'error'
      ? t('versions.chips.label', {
          chips: [
            methodLabel,
            ...shown.map((chip) => chip.label),
            ...(marker ? [t('versions.current')] : []),
          ].join(', '),
          reasons: allReasons
            .map((segment) => segment.map((part) => part.text).join(' '))
            .join('. '),
        })
      : undefined;

  // Web: hover or keyboard focus on the method chip explains it in whole sentences (D2b).
  const tipLines = ready ? reasonTexts(ready.version.predictionReasons, t) : [];
  const tipProps =
    Platform.OS === 'web' && ready
      ? ({
          tabIndex: 0,
          'aria-describedby': `${testID}-tooltip`,
          onPointerEnter: () => setTip(true),
          onPointerLeave: () => setTip(false),
          onFocus: () => setTip(true),
          onBlur: () => setTip(false),
        } as object)
      : undefined;

  const body = (
    <View
      testID={testID}
      accessibilityLabel={label}
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      style={{ height: block, paddingTop: s(CHIPS.top), gap: s(CHIPS.gap), zIndex: tip ? 10 : 0 }}>
      {tip && ready ? (
        <View
          testID={`${testID}-tooltip`}
          nativeID={`${testID}-tooltip`}
          role="tooltip"
          pointerEvents="none"
          style={{
            position: 'absolute',
            left: 0,
            bottom: block - s(CHIPS.top) + s(8),
            maxWidth: s(560),
            gap: s(4),
            paddingVertical: s(10),
            paddingHorizontal: s(14),
            borderRadius: s(10),
            borderWidth: 1,
            borderColor: colors.glass.border,
            backgroundColor: colors.background,
          }}>
          <Text style={{ fontFamily: fonts.bodyBold, fontSize: font(18, 13), color: tone.fg }}>
            {t(`versions.method.${method}`)}
          </Text>
          {tipLines.map((line) => (
            <Text key={line} variant="caption" style={{ fontSize: font(16, 12) }}>
              {line}
            </Text>
          ))}
        </View>
      ) : null}
      {target.state === 'loading' ? (
        <View testID={`${testID}-loading`} style={{ gap: s(CHIPS.gap) }}>
          <View style={{ flexDirection: 'row', gap, height: s(CHIPS.row), alignItems: 'center' }}>
            <Skeleton width={s(230)} height={s(44)} radius={s(12)} />
            {[80, 90, 104, 92].map((size, index) => (
              <Skeleton key={index} width={s(size)} height={s(36)} radius={s(8)} />
            ))}
          </View>
          <Skeleton width={s(300)} height={s(20)} radius={s(6)} />
        </View>
      ) : target.state === 'none' ? (
        <Text
          testID={`${testID}-none`}
          numberOfLines={1}
          style={{
            fontFamily: fonts.bodySemiBold,
            fontSize: font(22, MIN_TEXT.caption),
            lineHeight: s(CHIPS.row),
            color: SPEC_TONES.warn.fg,
          }}>
          {t(kind === 'episode' ? 'versions.chips.noneEpisode' : 'versions.chips.noneMovie')}
        </Text>
      ) : (
        <>
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap,
              height: s(CHIPS.row),
              overflow: 'hidden',
            }}>
            <MethodChip
              method={method}
              label={methodLabel}
              testID={`${testID}-method`}
              tipProps={tipProps}
            />
            {shown.map((chip) => (
              <View
                key={chip.key}
                testID={`${testID}-${chip.key}`}
                style={{
                  height: s(36),
                  justifyContent: 'center',
                  paddingHorizontal: chipPad,
                  borderRadius: s(8),
                  borderCurve: 'continuous',
                  borderWidth: 1,
                  borderColor: colors.glass.border,
                  backgroundColor: SPEC_TONES.neutral.bg,
                }}>
                <Text
                  variant="spec"
                  numberOfLines={1}
                  style={{
                    fontSize: specSize,
                    lineHeight: specSize * 1.3,
                    letterSpacing: s(0.6),
                    color: chip.muted ? colors.foreground.muted : colors.foreground.DEFAULT,
                  }}>
                  {chip.label}
                </Text>
              </View>
            ))}
            {marker ? (
              <View
                testID={`${testID}-last-played`}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: s(8),
                  height: s(36),
                  paddingHorizontal: s(14),
                  borderRadius: s(18),
                  // D2b: an outlined, muted marker; a white pill would read as a focused button on TV.
                  borderWidth: s(1.5),
                  borderColor: colors.foreground.subtle,
                }}>
                <History size={s(18)} color={colors.foreground.muted} />
                <Text
                  numberOfLines={1}
                  style={{
                    fontFamily: fonts.bodySemiBold,
                    fontSize: font(17, 11),
                    lineHeight: font(22, 14),
                    color: colors.foreground.muted,
                  }}>
                  {t('versions.current')}
                </Text>
              </View>
            ) : null}
          </View>
          {reasons.length ? (
            <Text testID={`${testID}-reasons`} numberOfLines={1} style={reasonStyle}>
              {reasons.flatMap((segment, index) =>
                segment.map((part, inner) => (
                  <Text
                    key={`${index}-${inner}`}
                    style={[reasonStyle, { color: partColor(part.tone) }]}>
                    {(inner ? ' ' : index ? SEGMENT_GAP : '') + part.text}
                  </Text>
                ))
              )}
            </Text>
          ) : null}
        </>
      )}
    </View>
  );
  if (!onPress || target.state !== 'ready') return body;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={t('versions.chips.openHint')}
      focusable={false}
      onPress={onPress}>
      {body}
    </Pressable>
  );
}

function MethodChip({
  method,
  label,
  testID,
  tipProps,
}: {
  method: PredictedMethod;
  label: string;
  testID: string;
  tipProps?: object;
}) {
  const { s, font } = useShell();
  const tone = SPEC_TONES[methodTone(method)];
  const Icon = METHOD_ICON[method];
  return (
    <View
      testID={testID}
      {...tipProps}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: s(10),
        height: s(CHIPS.row),
        paddingHorizontal: s(14),
        borderRadius: s(12),
        borderCurve: 'continuous',
        borderWidth: s(2),
        borderColor: tone.fg,
        backgroundColor: tone.bg,
      }}>
      <Icon size={s(24)} color={tone.fg} strokeWidth={2.4} />
      <Text
        numberOfLines={1}
        style={{
          fontFamily: fonts.bodyBold,
          fontSize: font(22, MIN_TEXT.caption),
          lineHeight: font(28, MIN_TEXT.caption + 4),
          color: tone.fg,
        }}>
        {label}
      </Text>
    </View>
  );
}
