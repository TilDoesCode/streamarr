import type { TFunction } from 'i18next';

import type { Version } from '@/browse/queries';
import type { CatalogSpec } from '@/components/spec';
import {
  audioCodecLabel,
  hdrLabel,
  MEDIA_LABELS,
  resolutionLabel,
  subtitleCodecLabel,
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

// Engine, then picture before sound before packaging before subtitles.
function reasonWeight(code: string | null | undefined): number {
  const prefix = [
    'vlc',
    'video',
    'hdr',
    'dolby',
    'bit',
    'resolution',
    'audio',
    'container',
    'bitrate',
  ];
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

/** The audio languages the release name states ("German, English"), "several", else null. */
export function versionLanguages(version: Version, t: TFunction, locale: string): string | null {
  const languages = version.languages ?? [];
  if (languages.length) return languages.map((code) => languageName(code, locale, t)).join(', ');
  return version.multiLanguage ? t('versions.multiLanguage') : null;
}

/** Audio languages (unless shown on their own), subtitles, edition, group and release flags. */
export function versionDetails(
  version: Version,
  t: TFunction,
  locale: string,
  { audio = true }: { audio?: boolean } = {}
): string[] {
  const parts: string[] = [];
  const languages = audio ? versionLanguages(version, t, locale) : null;
  if (languages)
    parts.push(version.languages?.length ? t('versions.audioLanguages', { languages }) : languages);
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
  'better_engine',
  'bit_depth_assumed',
  'bit_depth_unsupported',
  'bitrate_exceeds_limit',
  'container_assumed',
  'container_unsupported',
  'direct_play',
  'dolby_vision_base_layer',
  'dolby_vision_dual_layer',
  'dolby_vision_profile_unknown',
  'dolby_vision_profile_unsupported',
  'hdr_tone_mapped',
  'hdr_unsupported',
  'image_subtitle_vlc',
  'resolution_assumed',
  'resolution_exceeds_limit',
  'subtitle_burned_in',
  'subtitle_format_unsupported',
  'subtitle_not_deliverable',
  'transcode_height_limited',
  'transcode_width_limited',
  'transcoding_disabled',
  'transcoding_not_allowed',
  'video_codec_not_remuxable',
  'video_codec_unknown',
  'video_codec_unsupported',
  'video_profile_unsupported',
  'vlc_fallback',
]);

type ReasonCode = typeof REASONS extends Set<infer T> ? T : never;

/** Localized planner reasons (`decision.reasons`, prediction reasons); unknown codes are left out. */
export function reasonTexts(reasons: readonly Reason[] | null | undefined, t: TFunction): string[] {
  const list = reasons ?? [];
  const converted = list.some((reason) => reason.code === 'audio_converted');
  return list.flatMap((reason) => {
    if (!reason.code || !REASONS.has(reason.code)) return [];
    if (converted && reason.code === 'audio_codec_unsupported') return [];
    const params = reason.params ?? {};
    const codecLabel = reason.code.startsWith('audio_')
      ? audioCodecLabel
      : reason.code.includes('subtitle')
        ? subtitleCodecLabel
        : videoCodecLabel;
    const codec = params.codec ? codecLabel(params.codec) : '';
    return [
      t(`versions.reasons.${reason.code as ReasonCode}` as 'versions.reasons.direct_play', {
        ...params,
        codec,
        container: params.container ? params.container.toUpperCase() : '',
        from: params.from ? audioCodecLabel(params.from) : '',
        to: params.to ? audioCodecLabel(params.to) : '',
        hdr: params.hdr ? hdrLabel(params.hdr) : '',
        by: params.by
          ? t(
              `versions.reasons.transcode_height_by_${params.by}` as 'versions.reasons.transcode_height_by_server'
            )
          : '',
        engine: params.engine === 'vlc' ? 'VLC' : t('versions.reasons.engine_native'),
      }),
    ];
  });
}

const HDR_RANK: Record<string, number> = { dolbyvision: 4, hdr10plus: 3, hdr10: 2, hlg: 1 };

/** Vertical resolution of a version ("2160p" / "4K" → 2160); unknown → 0. */
export function versionHeight(version: Pick<Version, 'resolution'>): number {
  const resolution = version.resolution ?? '';
  if (/^(4k|uhd)/i.test(resolution)) return 2160;
  return Number.parseInt(resolution, 10) || 0;
}

function hdrRank(version: Version): number {
  const formats = [...(version.hdrFormats ?? []), version.hdr ?? ''];
  return Math.max(0, ...formats.map((format) => HDR_RANK[format.toLowerCase()] ?? 0));
}

/** The best picture on offer: resolution, then HDR format, then the ranker's order; never language or device. */
export function bestPicture(versions: readonly Version[]): Version | undefined {
  return versions.reduce<Version | undefined>((top, version) => {
    if (!top) return version;
    const order =
      versionHeight(version) - versionHeight(top) ||
      hdrRank(version) - hdrRank(top) ||
      (top.qualityRank ?? top.rank) - (version.qualityRank ?? version.rank);
    return order > 0 ? version : top;
  }, undefined);
}

// Servers without predictedHeight/predictedHdr: reasons that scale the picture down or leave SDR on this screen.
const HEIGHT_REASONS = new Set(['resolution_exceeds_limit', 'transcode_height_limited']);
const SDR_REASONS = new Set([
  'hdr_unsupported',
  'hdr_tone_mapped',
  'dolby_vision_profile_unsupported',
]);

function reasonHdr(version: Version, spec: CatalogSpec | null): string | null {
  const reasons = version.predictionReasons ?? [];
  if (reasons.some((reason) => !!reason.code && SDR_REASONS.has(reason.code))) return null;
  const base = reasons.find((reason) => reason.code === 'dolby_vision_base_layer')?.params?.hdr;
  if (base) return base === 'sdr' ? null : hdrLabel(base);
  return spec?.hdr ?? null;
}

/** Resolution and HDR format this device shows of a version (`predictedHeight`/`predictedHdr`, else the reasons); null HDR = SDR. */
export function deviceOutput(version: Version): { resolution: string | null; hdr: string | null } {
  const spec = versionSpec(version);
  const height =
    version.predictedHeight ??
    Number(
      version.predictionReasons?.find((reason) => !!reason.code && HEIGHT_REASONS.has(reason.code))
        ?.params?.max
    );
  const resolution =
    height > 0 && height < versionHeight(version)
      ? resolutionLabel(`${height}p`)
      : (spec?.resolution ?? null);
  const predicted = version.predictedHdr;
  const hdr = predicted
    ? predicted === 'sdr'
      ? null
      : hdrLabel(predicted)
    : reasonHdr(version, spec);
  return { resolution, hdr };
}

/** "4K · Dolby Vision", "1080p · SDR"; SDR is named only when `sdr` is set. */
function pictureLabel(picture: { resolution?: string | null; hdr?: string | null }, sdr: boolean) {
  return [picture.resolution, picture.hdr ?? (sdr && picture.resolution ? 'SDR' : null)]
    .filter(Boolean)
    .join(' · ');
}

/** The version Play starts: Recommended, else the first. */
function playedHere(versions: readonly Version[]): Version | undefined {
  return versions.find((version) => version.recommended) ?? versions[0];
}

/** Detail: the best picture on offer vs what this device shows of the one Play starts, when they differ. */
export function specGap(versions: readonly Version[]): { best: string; here: string } | undefined {
  const here = playedHere(versions);
  const best = bestPicture(versions);
  if (!here || !best) return undefined;
  const bestSpec = versionSpec(best);
  const gap = {
    best: pictureLabel(bestSpec ?? {}, false),
    here: pictureLabel(deviceOutput(here), !!bestSpec?.hdr),
  };
  return gap.best && gap.here && gap.best !== gap.here ? gap : undefined;
}

/** "4K · HDR10 available · plays here in 1080p · SDR", or undefined when the best picture plays here. */
export function specNote(versions: readonly Version[], t: TFunction): string | undefined {
  const gap = specGap(versions);
  return gap ? t('detail.specGap', gap) : undefined;
}

const PLAYS_UNCHANGED: readonly (PredictedMethod | undefined)[] = ['direct', 'remux', 'vlc'];

function outputRank(picture: { height: number; version: Version }): number {
  return (
    picture.height * 10 +
    (picture.version.predictedHdr && picture.version.predictedHdr !== 'sdr' ? 1 : 0)
  );
}

/** The best picture this device shows of any version: without a transcode if one plays so, else a transcode's; undefined without predictions. */
export function devicePicture(versions: readonly Version[]): Version | undefined {
  const predicted = (methods: readonly (PredictedMethod | undefined)[]) =>
    versions
      .filter((version) => methods.includes(predictedMethod(version)))
      .map((version) => ({
        version,
        height: version.predictedHeight ?? Math.min(versionHeight(version), 2160),
      }))
      .reduce<{ version: Version; height: number } | undefined>(
        (top, next) => (!top || outputRank(next) > outputRank(top) ? next : top),
        undefined
      )?.version;
  return predicted(PLAYS_UNCHANGED) ?? predicted(['transcode']);
}

export type SheetSpecs = {
  /** The best picture on offer ("4K · Dolby Vision"). */
  best: string;
  /** The best picture this device shows of any version ("4K · HDR10"); without predictions, what Play starts. */
  here: string;
  /** What Play starts, when it is less than `here`, and why when the server said so. */
  recommended?: { picture: string; why?: 'local' | 'affinity' };
  /** The sharper resolution on offer ("4K") that needs more bandwidth than this device's limit allows. */
  bandwidthLimited?: string;
};

/** Version sheet header: the best picture on offer, the best this device shows, and what Play starts when that is less. */
export function sheetSpecs(versions: readonly Version[]): SheetSpecs | undefined {
  const played = playedHere(versions);
  const best = bestPicture(versions);
  if (!played || !best) return undefined;
  const capable = devicePicture(versions) ?? played;
  const specs: SheetSpecs = {
    best: pictureLabel(versionSpec(best) ?? {}, true),
    here: pictureLabel(deviceOutput(capable), true),
  };
  if (!specs.best || !specs.here) return undefined;
  const picture = pictureLabel(deviceOutput(played), true);
  if (picture && picture !== specs.here)
    specs.recommended = {
      picture,
      why: played.local === 'ready' ? 'local' : played.affinity ? 'affinity' : undefined,
    };
  const sharper = versionHeight(best) > versionHeight(capable);
  if (
    sharper &&
    versions.some(
      (version) =>
        versionHeight(version) > versionHeight(capable) &&
        version.predictionReasons?.some((reason) => reason.code === 'bitrate_exceeds_limit')
    )
  )
    specs.bandwidthLimited = best.resolution ? resolutionLabel(best.resolution) : undefined;
  return specs;
}
