import { type Ref } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, View } from 'react-native';
import Animated, { interpolateColor, useAnimatedStyle } from 'react-native-reanimated';

import { type Version } from '@/browse/queries';
import {
  methodReasons,
  predictedMethod,
  versionDetails,
  versionFormats,
  versionHeadline,
} from '@/browse/version-format';
import { Focusable, FocusLift, useFocusState } from '@/components/focus';
import { methodTone, SignalBars, SPEC_TONES, versionSignal } from '@/components/spec';
import { Text } from '@/components/ui/text';
import { useFormat } from '@/i18n/format';
import { useShell } from '@/shell/use-shell';
import { colors, fonts } from '@/theme';

/** Index of the card focus enters on: Recommended, else the first. */
export function entryIndex(versions: readonly Pick<Version, 'recommended'>[]): number {
  return Math.max(
    0,
    versions.findIndex((version) => version.recommended)
  );
}

/** One version card of the version sheet (also the player's glass version panel). */
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
  const method = predictedMethod(version);
  const reasons = methodReasons(version, t);
  const headline = versionHeadline(version) || version.name || '';
  const group = version.releaseGroup;
  const spec = [
    ...versionFormats(version, t),
    ...versionDetails(version, t, i18n.language).filter((part) => part !== group),
  ].join(' · ');
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
  const why = method
    ? method !== 'direct' && reasons.length
      ? reasons.map((reason) => reason.replace(/-/g, '\u2011')).join('\n')
      : t(`versions.plain.${method}`)
    : undefined;
  const radius = s(28);
  const text = (size: number, line = size * 1.4) => ({
    fontSize: font(size, 13),
    lineHeight: font(line, 13 * (line / size)),
  });

  return (
    <Focusable
      ref={ref}
      testID={`version-${version.rank}`}
      focusable={focusable}
      onFocus={onFocus}
      hasTVPreferredFocus={preferred}
      role="button"
      accessibilityLabel={[headline, spec, facts.join(', '), health, local, methodLabel, why]
        .filter(Boolean)
        .join('. ')}
      onPress={onPress}>
      <FocusLift kind="none" radius={radius} tint={tint}>
        <CardSurface radius={radius}>
          {version.recommended || current ? (
            <View style={{ flexDirection: 'row', gap: s(10) }}>
              {version.recommended ? (
                <Pill label={t('media.recommended')} tone="recommended" />
              ) : null}
              {current ? <Pill label={t('versions.current')} tone="neutral" /> : null}
            </View>
          ) : null}
          <Text
            numberOfLines={1}
            style={{
              fontFamily: fonts.displayBold,
              fontSize: s(30),
              lineHeight: s(38),
              color: colors.foreground.DEFAULT,
            }}>
            {headline}
          </Text>
          {spec ? (
            <Text numberOfLines={1} style={text(20)}>
              {spec}
            </Text>
          ) : null}
          {facts.length ? (
            <Text tone="muted" numberOfLines={1} style={text(18)}>
              {facts.join('  ·  ')}
            </Text>
          ) : null}
          {signal || health || local ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: s(12) }}>
              {signal ? <SignalBars level={signal.level} tone={signal.tone} size={s(16)} /> : null}
              {health ? <Text style={text(18)}>{health}</Text> : null}
              {local ? (
                <Text tone="muted" style={text(18)}>
                  {local}
                </Text>
              ) : null}
            </View>
          ) : null}
          {methodLabel ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: s(14) }}>
              <View
                testID={`version-${version.rank}-method`}
                style={{
                  borderRadius: s(10),
                  paddingHorizontal: s(12),
                  paddingVertical: s(4),
                  backgroundColor: SPEC_TONES[methodTone(method)].bg,
                }}>
                <Text
                  style={[
                    text(17, 24),
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
                  style={[text(17, 24), { flex: 1 }]}>
                  {why}
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
              style={{ fontFamily: fonts.mono, fontSize: font(14, 11), lineHeight: font(20, 16) }}>
              {version.name}
            </Text>
          ) : null}
        </CardSurface>
      </FocusLift>
    </Focusable>
  );
}

function Pill({ label, tone }: { label: string; tone: 'recommended' | 'neutral' }) {
  const { s } = useShell();
  const recommended = tone === 'recommended';
  return (
    <View
      style={{
        borderRadius: s(14),
        paddingHorizontal: s(12),
        paddingVertical: s(3) - (recommended ? 0 : s(1.5)),
        backgroundColor: recommended ? SPEC_TONES.ok.fg : undefined,
        borderWidth: recommended ? 0 : s(1.5),
        borderColor: colors.foreground.subtle,
      }}>
      <Text
        style={{
          fontFamily: fonts.bodySemiBold,
          fontSize: s(15),
          lineHeight: s(22),
          color: recommended ? colors.background : colors.foreground.muted,
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
          gap: s(10),
          padding: s(26),
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
