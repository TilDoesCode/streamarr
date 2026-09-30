import type { TFunction } from 'i18next';

import type { Version } from '@/browse/queries';
import type { CatalogSpec } from '@/components/spec';
import {
  audioCodecLabel,
  hdrLabel,
  MEDIA_LABELS,
  resolutionLabel,
  videoCodecLabel,
} from '@/lib/media-labels';

export type PredictedMethod = 'direct' | 'remux' | 'transcode' | 'vlc' | 'unknown';

export function predictedMethod(version: Version): PredictedMethod | undefined {
  const method = version.predictedMethod;
  return method === 'direct' ||
    method === 'remux' ||
    method === 'transcode' ||
    method === 'vlc' ||
    method === 'unknown'
    ? method
    : undefined;
}

/** Localized language name ("de" → "Deutsch"): own translations, then Intl.DisplayNames, else the code. */
export function languageName(code: string, locale: string, t?: TFunction): string {
  const own = t?.(`versions.languages.${code.toLowerCase()}` as 'versions.languages.de', {
    defaultValue: '',
  });
  if (own) return own;
  try {
    const names = new Intl.DisplayNames([locale], { type: 'language' });
    return names.of(code) ?? code.toUpperCase();
  } catch {
    return code.toUpperCase();
  }
}

/** Headline of a version card: "4K · HDR10 · BluRay". */
export function versionHeadline(version: Version): string {
  const hdr = version.hdrFormats?.length
    ? version.hdrFormats.map(hdrLabel).join(' / ')
    : version.hdr
      ? hdrLabel(version.hdr)
      : null;
  return [version.resolution ? resolutionLabel(version.resolution) : null, hdr, version.source]
    .filter((part): part is string => !!part)
    .join(' · ');
}

/** Spec labels (resolution, HDR, codec, audio) of one version, in the catalog summary's shape. */
export function versionSpec(version: Version | undefined): CatalogSpec | null {
  if (!version) return null;
  const hdr = version.hdrFormats?.[0] ?? version.hdr;
  return {
    resolution: version.resolution ? resolutionLabel(version.resolution) : null,
    hdr: hdr ? hdrLabel(hdr) : null,
    videoCodec: version.videoCodec ? videoCodecLabel(version.videoCodec) : null,
    audio: version.atmos
      ? MEDIA_LABELS.atmos
      : (version.audioChannels ??
        (version.audioCodec ? audioCodecLabel(version.audioCodec) : null)),
  };
}

// Assumptions and pass-throughs explain nothing to a viewer; the panel shows what changes.
const QUIET_REASONS = new Set(['audio_copied', 'direct_play']);

/** Up to `max` plain reasons why a version does not play as is (assumptions left out). */
export function methodReasons(version: Version, t: TFunction, max = 2): string[] {
  return plainReasons(version.predictionReasons, t, max);
}

type Reason = { code?: string | null; params?: Record<string, string> | null };

/** The one reason formatter for panels and the player: what changes, max `max` lines. */
export function plainReasons(
  reasons: readonly Reason[] | null | undefined,
  t: TFunction,
  max = 2
): string[] {
  const shown = (reasons ?? []).filter(
    (reason) =>
      !!reason.code && !reason.code.endsWith('_assumed') && !QUIET_REASONS.has(reason.code)
  );
  return reasonTexts(
    [...shown].sort((a, b) => reasonWeight(a.code) - reasonWeight(b.code)),
    t
  ).slice(0, max);
}

// Picture before sound before packaging before subtitles.
function reasonWeight(code: string | null | undefined): number {
  const prefix = ['video', 'hdr', 'dolby', 'bit', 'resolution', 'audio', 'container', 'bitrate'];
  const index = prefix.findIndex((part) => code?.startsWith(part));
  return index < 0 ? prefix.length : index;
}

/** Technical facts: video codec + bit depth, audio + channels + Atmos. */
export function versionFormats(version: Version, t: TFunction): string[] {
  const parts: string[] = [];
  if (version.videoCodec)
    parts.push(
      version.bitDepth && version.bitDepth > 8
        ? t('versions.bitDepth', {
            codec: videoCodecLabel(version.videoCodec),
            bits: version.bitDepth,
          })
        : videoCodecLabel(version.videoCodec)
    );
  if (version.audioCodec)
    parts.push(
      [
        audioCodecLabel(version.audioCodec),
        version.audioChannels,
        version.atmos ? MEDIA_LABELS.atmos : null,
      ]
        .filter(Boolean)
        .join(' ')
    );
  return parts;
}

/** Audio languages, subtitles, edition, group and release flags. */
export function versionDetails(version: Version, t: TFunction, locale: string): string[] {
  const parts: string[] = [];
  const languages = version.languages ?? [];
  if (languages.length)
    parts.push(
      t('versions.audioLanguages', {
        languages: languages.map((code) => languageName(code, locale, t)).join(', '),
      })
    );
  else if (version.multiLanguage) parts.push(t('versions.multiLanguage'));
  const subtitles = version.subtitleLanguages ?? [];
  if (subtitles.length)
    parts.push(
      t('versions.subtitles', {
        languages: subtitles.map((code) => languageName(code, locale, t)).join(', '),
      })
    );
  else if (version.subtitleHints?.length) parts.push(t('versions.subtitlesUnknown'));
  if (version.edition) parts.push(version.edition);
  if (version.proper) parts.push(t('versions.proper'));
  if (version.repack) parts.push(t('versions.repack'));
  if (version.seasonPack) parts.push(t('versions.seasonPack'));
  if (version.releaseGroup) parts.push(version.releaseGroup);
  return parts;
}

const REASONS = new Set([
  'audio_codec_unknown',
  'audio_codec_unsupported',
  'audio_converted',
  'audio_copied',
  'bit_depth_assumed',
  'bit_depth_unsupported',
  'bitrate_exceeds_limit',
  'container_assumed',
  'container_unsupported',
  'direct_play',
  'dolby_vision_profile_unknown',
  'dolby_vision_profile_unsupported',
  'hdr_unsupported',
  'resolution_assumed',
  'resolution_exceeds_limit',
  'subtitle_burned_in',
  'subtitle_format_unsupported',
  'subtitle_not_deliverable',
  'transcoding_disabled',
  'transcoding_not_allowed',
  'video_codec_not_remuxable',
  'video_codec_unknown',
  'video_codec_unsupported',
  'video_profile_unsupported',
]);

type ReasonCode = typeof REASONS extends Set<infer T> ? T : never;

/** Localized prediction reasons; codes the client does not know are left out. */
export function predictionReasons(version: Version, t: TFunction): string[] {
  return reasonTexts(version.predictionReasons, t);
}

/** Localized planner reasons (`decision.reasons`, prediction reasons); unknown codes are left out. */
export function reasonTexts(reasons: readonly Reason[] | null | undefined, t: TFunction): string[] {
  const list = reasons ?? [];
  const converted = list.some((reason) => reason.code === 'audio_converted');
  return list.flatMap((reason) => {
    if (!reason.code || !REASONS.has(reason.code)) return [];
    if (converted && reason.code === 'audio_codec_unsupported') return [];
    const params = reason.params ?? {};
    const codecLabel = reason.code.startsWith('audio_') ? audioCodecLabel : videoCodecLabel;
    const codec = params.codec ? codecLabel(params.codec) : '';
    return [
      t(`versions.reasons.${reason.code as ReasonCode}` as 'versions.reasons.direct_play', {
        ...params,
        codec,
        container: params.container ? params.container.toUpperCase() : '',
        from: params.from ? audioCodecLabel(params.from) : '',
        to: params.to ? audioCodecLabel(params.to) : '',
        hdr: params.hdr ? hdrLabel(params.hdr) : '',
      }),
    ];
  });
}
