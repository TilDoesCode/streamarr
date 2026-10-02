import { Film } from 'lucide-react-native';
import { createContext, use, useState, type Ref, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { findNodeHandle, Platform, ScrollView, View } from 'react-native';
import Animated, { interpolateColor, useAnimatedStyle } from 'react-native-reanimated';

import { toAppError } from '@/api/errors';
import { useVersions, type Version } from '@/browse/queries';
import {
  methodReasons,
  predictedMethod,
  versionDetails,
  versionFormats,
  versionHeadline,
} from '@/browse/version-format';
import {
  Focusable,
  FocusGuide,
  FocusLift,
  useFocusGlowRoom,
  useFocusState,
} from '@/components/focus';
import { Glass, tvGlassAlpha, tvPanelUnderlay } from '@/components/glass';
import { methodTone, SignalBars, SPEC_TONES, versionSignal } from '@/components/spec';
import { EmptyState } from '@/components/states/empty-state';
import { ErrorState } from '@/components/states/error-state';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useFormat } from '@/i18n/format';
import { useShell } from '@/shell/use-shell';
import { colors, fonts, useFocusGap } from '@/theme';

const APPLE_TV = Platform.OS === 'ios' && Platform.isTV;

export type VersionPanelProps = {
  workId: string | null | undefined;
  /** The version the viewer played last ("Last played" badge). */
  currentReleaseId?: string | null;
  onPlay: (version: Version) => void;
  tint?: string | null;
  /** Title art highlight: Android TV sizes the panel glass from it. */
  artHighlight?: string | null;
  /** The card Right from the actions (and "Versions") lands on: Recommended, else the first. */
  entryRef?: RefObject<View | null>;
  /** The entry card mounted (or unmounted: null). */
  onEntry?: (view: View | null) => void;
  /** TV: focus entered (true) or left (false) the panel. */
  onFocusInside?: (inside: boolean) => void;
  /** Web: briefly highlighted after "Versions" was pressed. */
  highlight?: boolean;
  /** Heading override (series: the episode the panel belongs to). */
  subtitle?: string;
  testID?: string;
};

/** Index of the card focus enters on: Recommended, else the first. */
export function entryIndex(versions: readonly Pick<Version, 'recommended'>[]): number {
  return Math.max(
    0,
    versions.findIndex((version) => version.recommended)
  );
}

// Android TV glass is already smoked; a lighter underlay keeps muted text >= 4.5:1 (tv-glass.test.ts).
const SMOKED_TV = Platform.OS === 'android' && Platform.isTV;

/** Large shell: the always-visible glass version panel of a detail screen (Aurora C-detail). */
export function VersionPanel({
  workId,
  currentReleaseId,
  onPlay,
  tint,
  artHighlight,
  entryRef,
  highlight = false,
  subtitle,
  onFocusInside,
  onEntry,
  testID = 'version-panel',
}: VersionPanelProps) {
  const { t } = useTranslation();
  const { s } = useShell();
  const cardGap = useFocusGap(s(18), 'ring');
  const glowRoom = useFocusGlowRoom();
  const versions = useVersions(workId, !!workId);
  const list = versions.data?.versions ?? [];
  const error = versions.error ? toAppError(versions.error) : undefined;
  const entry = entryIndex(list);
  const [entryView, setEntryView] = useState<View | null>(null);
  const entryCallback = (view: View | null) => {
    setEntryView(view);
    if (entryRef) entryRef.current = view;
    onEntry?.(view);
  };

  let body;
  if (!workId || (versions.data === undefined && !error))
    body = [0, 1, 2].map((index) => <PanelCardSkeleton key={index} />);
  else if (versions.data === undefined && error)
    body = (
      <ErrorState
        testID="versions-error"
        code={error.code}
        actions={['retry']}
        onAction={() => void versions.refetch()}
      />
    );
  else if (!list.length)
    body = (
      <EmptyState
        testID="versions-empty"
        icon={Film}
        title={t('versions.emptyTitle')}
        message={t('versions.emptyMessage')}
      />
    );
  else
    body = list.map((version, index) => (
      <VersionPanelCard
        key={version.releaseId ?? index}
        ref={index === entry ? entryCallback : undefined}
        version={version}
        current={!!currentReleaseId && version.releaseId === currentReleaseId}
        tint={tint}
        onPress={() => onPlay(version)}
      />
    ));

  const count = versions.data ? list.length : undefined;
  return (
    <Glass
      testID={testID}
      intensity="regular"
      tint={highlight ? tint : null}
      artHighlight={artHighlight}
      radius={s(44)}
      style={[
        { flex: 1 },
        highlight && { borderWidth: s(2), borderColor: colors.foreground.DEFAULT },
      ]}>
      {/* Smoked underlay: keeps the copy legible over bright artwork (mockup C-detail). */}
      <View
        style={{
          position: 'absolute',
          inset: 0,
          borderRadius: s(44),
          borderCurve: 'continuous',
          backgroundColor: colors.glass.tinted,
          opacity: SMOKED_TV
            ? tvPanelUnderlay(tvGlassAlpha(artHighlight, highlight ? tint : null))
            : 0.7,
        }}
      />
      <View style={{ paddingHorizontal: s(40), paddingTop: s(48), gap: s(6) }}>
        <Text
          role="heading"
          style={{
            fontFamily: fonts.displayBold,
            fontSize: s(44),
            lineHeight: s(52),
            color: colors.foreground.DEFAULT,
          }}>
          {t('versions.title')}
        </Text>
        <Text tone="muted" style={{ fontSize: s(20), lineHeight: s(28) }} numberOfLines={2}>
          {subtitle ??
            (count !== undefined
              ? t('versions.panelSubtitle', { count })
              : t('versions.predicted'))}
        </Text>
      </View>
      <FocusGuide
        remember={false}
        destinations={entryView ? [entryView] : undefined}
        trap={['up', 'down', 'right']}
        onFocusEnter={() => onFocusInside?.(true)}
        onFocusLeave={() => onFocusInside?.(false)}
        style={{ flex: 1 }}>
        <ScrollView
          showsVerticalScrollIndicator={false}
          // Ring and glow room stays inside the viewport, which starts below the subtitle (no overlap when scrolled).
          style={{ flex: 1 }}
          contentContainerStyle={{
            padding: Math.max(s(40), glowRoom),
            paddingTop: Math.max(s(28), glowRoom),
            gap: cardGap,
          }}>
          {body}
        </ScrollView>
      </FocusGuide>
    </Glass>
  );
}

/** Apple TV: where Left from a version card goes (the detail actions; nothing lines up geometrically). */
export const PanelExitContext = createContext<View | null>(null);

/** One version card of the panel (also the player's glass version panel). */
export function VersionPanelCard({
  version,
  current,
  tint,
  onPress,
  ref,
  focusable,
  onFocus,
}: {
  version: Version;
  current: boolean;
  tint?: string | null;
  onPress: () => void;
  ref?: Ref<View>;
  focusable?: boolean;
  onFocus?: () => void;
}) {
  const { t, i18n } = useTranslation();
  const format = useFormat();
  const { s, font } = useShell();
  const exit = use(PanelExitContext);
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
      nextFocusLeft={APPLE_TV && exit ? (findNodeHandle(exit) ?? undefined) : undefined}
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
        paddingVertical: s(3),
        backgroundColor: recommended ? SPEC_TONES.ok.fg : colors.glass.strong,
      }}>
      <Text
        style={{
          fontFamily: fonts.bodySemiBold,
          fontSize: s(15),
          lineHeight: s(22),
          color: recommended ? colors.background : colors.foreground.DEFAULT,
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

function PanelCardSkeleton() {
  const { s } = useShell();
  return (
    <View testID="versions-loading" style={{ gap: s(12), padding: s(26) }}>
      <Skeleton width={s(140)} height={s(26)} radius={s(13)} />
      <Skeleton width="60%" height={s(34)} radius={s(8)} />
      <Skeleton width="85%" height={s(22)} radius={s(6)} />
      <Skeleton width="45%" height={s(20)} radius={s(6)} />
    </View>
  );
}
