import { type Ref } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, View } from 'react-native';
import Animated, { interpolateColor, useAnimatedStyle } from 'react-native-reanimated';

import { useAudioLanguages, useMeasuredBandwidthKbps, type Version } from '@/browse/queries';
import {
  methodReasons,
  predictedMethod,
  versionDetails,
  versionFormats,
  versionHeadline,
  versionLanguages,
} from '@/browse/version-format';
import { Focusable, FocusLift, useFocusState } from '@/components/focus';
import { AudioLines, Gauge } from '@/components/icons';
import { methodTone, SignalBars, SPEC_TONES, versionSignal } from '@/components/spec';
import { Text } from '@/components/ui/text';
import { useFormat } from '@/i18n/format';
import { MIN_TEXT } from '@/shell/shell-metrics';
import { useShell } from '@/shell/use-shell';
import { colors, fonts } from '@/theme';

/** Index of the card focus enters on: Recommended, else the first. */
export function entryIndex(versions: readonly Pick<Version, 'recommended'>[]): number {
  return Math.max(
    0,
    versions.findIndex((version) => version.recommended)
  );
}

/** One compact version card of the version sheet (also the player's glass version panel). */
export function VersionPanelCard({
  version,
  current,
  tint,
  onPress,
  ref,
  focusable,
  onFocus,
  preferred,
}: {
  version: Version;
  current: boolean;
  tint?: string | null;
  onPress: () => void;
  ref?: Ref<View>;
  focusable?: boolean;
  onFocus?: () => void;
  /** TV: takes the first focus when its screen appears (the version sheet). */
  preferred?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const format = useFormat();
  const { s, font } = useShell();
  const audioLanguage = useAudioLanguages().split(',')[0];
  const method = predictedMethod(version);
  const reasons = methodReasons(version, t);
  const headline = versionHeadline(version) || version.name || '';
  const group = version.releaseGroup;
  const languages = versionLanguages(version, t, i18n.language);
  // The viewer's own language stands out: it decides more than any codec which version to pick.
  const ownLanguage = !!version.languages?.some((code) => code.toLowerCase() === audioLanguage);
  const formats = [
    ...versionFormats(version, t),
    ...versionDetails(version, t, i18n.language, { audio: false }).filter((part) => part !== group),
  ];
  const facts = [
    version.sizeBytes ? format.fileSize(version.sizeBytes) : null,
    version.estimatedBitrateKbps
      ? t('versions.bitrate', { mbps: version.estimatedBitrateKbps / 1000 })
      : null,
    version.ageDays != null ? t('versions.age', { days: version.ageDays }) : null,
  ].filter((part): part is string => !!part);
  const signal = versionSignal(version);
  const health =
    version.health === 'ready'
      ? t('versions.health.ready')
      : version.health === 'degraded'
        ? t('versions.health.degraded')
        : null;
  const local =
    version.local === 'ready'
      ? t('versions.local.ready')
      : version.local === 'downloading'
        ? t('versions.local.downloading')
        : null;
  const methodLabel = method ? t(`versions.method.${method}`) : undefined;
  const fit = useBandwidthMarker(version);
  // One line on the card (the weightiest change); every reason stays in the accessibility label.
  const reason = method !== 'direct' ? reasons[0] : undefined;
  const why = method
    ? (reason?.replace(/-/g, '\u2011') ?? t(`versions.plain.${method}`))
    : undefined;
  const radius = s(22);
  const text = (size: number, line = size * 1.35) => ({
    fontSize: font(size, MIN_TEXT.subline),
    lineHeight: font(line, MIN_TEXT.subline * (line / size)),
  });

  return (
    <Focusable
      ref={ref}
      testID={`version-${version.rank}`}
      focusable={focusable}
      onFocus={onFocus}
      hasTVPreferredFocus={preferred}
      role="button"
      accessibilityLabel={[
        headline,
        t('versions.audioLanguages', { languages: languages ?? t('versions.languageUnknown') }),
        formats.join(' · '),
        facts.join(', '),
        health,
        local,
        version.affinity && !current ? t('versions.affinity') : null,
        methodLabel,
        reason ? reasons.join('. ') : why,
        fit ? [fit.title, fit.detail].filter(Boolean).join(', ') : null,
      ]
        .filter(Boolean)
        .join('. ')}
      onPress={onPress}>
      <FocusLift kind="none" radius={radius} tint={tint}>
        <CardSurface radius={radius}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: s(10) }}>
            <Text
              numberOfLines={1}
              style={{
                flex: 1,
                fontFamily: fonts.displayBold,
                fontSize: font(25, MIN_TEXT.caption),
                lineHeight: font(32, 20),
                color: colors.foreground.DEFAULT,
              }}>
              {headline}
            </Text>
            {signal ? <SignalBars level={signal.level} tone={signal.tone} size={s(15)} /> : null}
            {local ? (
              <Pill label={local} tone={version.local === 'ready' ? 'local' : 'neutral'} />
            ) : null}
            {version.recommended ? (
              <Pill label={t('media.recommended')} tone="recommended" />
            ) : null}
            {current ? <Pill label={t('versions.current')} tone="neutral" /> : null}
            {version.affinity && !current ? (
              <Pill label={t('versions.affinity')} tone="neutral" />
            ) : null}
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: s(12) }}>
            <LanguagePill
              testID={`version-${version.rank}-language`}
              label={languages ?? t('versions.languageUnknown')}
              tone={ownLanguage ? 'own' : languages ? 'other' : 'unknown'}
            />
            {formats.length || facts.length ? (
              <Text
                testID={`version-${version.rank}-meta`}
                tone="muted"
                numberOfLines={1}
                style={[text(18), { flex: 1 }]}>
                {[...formats, ...facts].join(' · ')}
              </Text>
            ) : null}
          </View>
          {methodLabel ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: s(12) }}>
              <View
                testID={`version-${version.rank}-method`}
                style={{
                  borderRadius: s(8),
                  paddingHorizontal: s(10),
                  paddingVertical: s(1),
                  backgroundColor: SPEC_TONES[methodTone(method)].bg,
                }}>
                <Text
                  style={[
                    text(16, 22),
                    {
                      fontFamily: fonts.bodySemiBold,
                      color: SPEC_TONES[methodTone(method)].fg,
                    },
                  ]}>
                  {methodLabel}
                </Text>
              </View>
              {why ? (
                <Text
                  testID={`version-${version.rank}-plain`}
                  tone="muted"
                  numberOfLines={1}
                  style={[text(16, 22), { flex: 1 }]}>
                  {why}
                </Text>
              ) : null}
            </View>
          ) : null}
          {fit ? (
            <View
              testID={`version-${version.rank}-fit`}
              style={{
                flexDirection: 'row',
                flexWrap: 'wrap',
                alignItems: 'center',
                columnGap: s(10),
                rowGap: s(2),
              }}>
              <View
                testID={`version-${version.rank}-fit-${fit.kind}`}
                style={{
                  flexShrink: 1,
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: s(6),
                  borderRadius: s(8),
                  paddingHorizontal: s(10),
                  paddingVertical: s(1),
                  backgroundColor: SPEC_TONES[fit.tone].bg,
                }}>
                <Gauge size={s(16)} color={SPEC_TONES[fit.tone].fg} />
                <Text
                  numberOfLines={1}
                  style={[
                    text(16, 22),
                    {
                      flexShrink: 1,
                      fontFamily: fonts.bodySemiBold,
                      color: SPEC_TONES[fit.tone].fg,
                    },
                  ]}>
                  {fit.title}
                </Text>
              </View>
              {fit.detail ? (
                <Text tone="muted" numberOfLines={1} style={text(16, 22)}>
                  {fit.detail}
                </Text>
              ) : null}
            </View>
          ) : null}
          {version.name ? (
            <Text
              testID={`version-${version.rank}-name`}
              tone={Platform.isTV ? 'muted' : 'subtle'}
              numberOfLines={1}
              selectable={Platform.OS === 'web'}
              style={{
                fontFamily: fonts.mono,
                fontSize: font(13, MIN_TEXT.spec),
                lineHeight: font(18, 15),
              }}>
              {version.name}
            </Text>
          ) : null}
        </CardSurface>
      </FocusLift>
    </Focusable>
  );
}

type BandwidthMarker = {
  kind: 'tooHigh' | 'tight' | 'transcode';
  tone: 'bad' | 'warn' | 'info';
  title: string;
  detail: string;
};

/** The server's bitrate fit as a card line, only while this device has a fresh speed test (else the sheet asks for one). */
function useBandwidthMarker(version: Version): BandwidthMarker | undefined {
  const { t } = useTranslation();
  const measured = useMeasuredBandwidthKbps();
  if (!measured) return undefined;
  const mbps = (kbps?: number | null) => (kbps ? Math.max(1, Math.round(kbps / 1000)) : undefined);
  const needed = mbps(version.bandwidthNeededKbps);
  const available = mbps(version.bandwidthAvailableKbps);
  const detail =
    needed && available
      ? [
          t('versions.fit.needs', { needed, available }),
          version.bandwidthLeg === 'usenet' ? t('versions.fit.legUsenet') : null,
        ]
          .filter(Boolean)
          .join(' · ')
      : '';
  if (version.bandwidthFit === 'tooHigh')
    return { kind: 'tooHigh', tone: 'bad', title: t('versions.fit.tooHigh'), detail };
  if (version.bandwidthFit === 'tight')
    return { kind: 'tight', tone: 'warn', title: t('versions.fit.tight'), detail };
  // The server converts it for this device: the original's bitrate would not have fitted, the converted one does.
  if (
    version.bandwidthViaTranscode &&
    version.estimatedBitrateKbps &&
    version.estimatedBitrateKbps > measured
  )
    return { kind: 'transcode', tone: 'info', title: t('versions.fit.viaTranscode'), detail: '' };
  return undefined;
}

function Pill({ label, tone }: { label: string; tone: 'recommended' | 'local' | 'neutral' }) {
  const { s, font } = useShell();
  const recommended = tone === 'recommended';
  return (
    <View
      style={{
        borderRadius: s(12),
        paddingHorizontal: s(10),
        paddingVertical: s(1) - (recommended ? 0 : s(1.5)),
        backgroundColor: recommended
          ? SPEC_TONES.ok.fg
          : tone === 'local'
            ? SPEC_TONES.ok.bg
            : undefined,
        borderWidth: recommended ? 0 : s(1.5),
        borderColor: tone === 'local' ? SPEC_TONES.ok.border : colors.foreground.subtle,
      }}>
      <Text
        numberOfLines={1}
        style={{
          fontFamily: fonts.bodySemiBold,
          fontSize: font(15, MIN_TEXT.spec),
          lineHeight: font(22, 16),
          color: recommended
            ? colors.background
            : tone === 'local'
              ? SPEC_TONES.ok.fg
              : colors.foreground.muted,
        }}>
        {label}
      </Text>
    </View>
  );
}

/** Audio language badge: the viewer's own language in the accent tone, an unstated one muted. */
function LanguagePill({
  label,
  tone,
  testID,
}: {
  label: string;
  tone: 'own' | 'other' | 'unknown';
  testID?: string;
}) {
  const { s, font } = useShell();
  const palette = SPEC_TONES[tone === 'own' ? 'info' : 'neutral'];
  const color = tone === 'unknown' ? colors.foreground.muted : palette.fg;
  return (
    <View
      testID={testID}
      style={{
        maxWidth: '60%',
        flexDirection: 'row',
        alignItems: 'center',
        gap: s(8),
        borderRadius: s(12),
        paddingHorizontal: s(10),
        paddingVertical: s(1),
        borderWidth: s(1.5),
        borderColor: tone === 'own' ? palette.border : colors.glass.border,
        backgroundColor: tone === 'unknown' ? undefined : palette.bg,
      }}>
      <AudioLines size={s(18)} color={color} />
      <Text
        numberOfLines={1}
        style={{
          flexShrink: 1,
          fontFamily: fonts.bodySemiBold,
          fontSize: font(18, MIN_TEXT.subline),
          lineHeight: font(24, 18),
          color,
        }}>
        {label}
      </Text>
    </View>
  );
}

/** Card body: glass wash, brighter on hover, white ring (tinted glow via FocusLift) on focus. */

function CardSurface({ radius, children }: { radius: number; children: React.ReactNode }) {
  const { s } = useShell();
  const { focus, hover, pressed } = useFocusState();
  const style = useAnimatedStyle(() => {
    const lit = Math.max(focus.get(), hover.get() * 0.6, pressed.get());
    return {
      backgroundColor: interpolateColor(lit, [0, 1], [colors.glass.subtle, colors.glass.DEFAULT]),
    };
  });
  return (
    <Animated.View
      style={[
        {
          gap: s(6),
          paddingHorizontal: s(20),
          paddingVertical: s(14),
          borderRadius: radius,
          borderCurve: 'continuous',
          borderWidth: 1,
          borderColor: colors.glass.border,
        },
        style,
      ]}>
      {children}
    </Animated.View>
  );
}
