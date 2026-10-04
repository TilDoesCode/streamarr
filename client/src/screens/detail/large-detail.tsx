import { LinearGradient } from 'expo-linear-gradient';
import { ChevronRight, Info } from 'lucide-react-native';
import { useFocusEffect } from 'expo-router';
import type { TFunction } from 'i18next';
import { useCallback, useEffect, useEffectEvent, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, ScrollView, StyleSheet, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { components } from '@/api/schema';
import { CHIPS } from '@/browse/version-chips';

import { useClearAmbient, useSetAmbient } from '@/components/ambient';
import { FocusGuide, Focusable, FocusLift } from '@/components/focus';
import { GlassButton } from '@/components/glass';
import { Artwork } from '@/components/media/artwork';
import { HeroTitle } from '@/components/media/hero';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useFormat } from '@/i18n/format';
import { BackControl, useBackControlClearance } from '@/navigation/back-control';
import { HeroFade } from '@/shell/hero-fade';
import { ShellDesign } from '@/shell/shell-design';
import { SHELL } from '@/shell/shell-metrics';
import { useShell } from '@/shell/use-shell';

import { StageActionRow } from './stage-action-row';
import { liftedTop, MOVIE_INFO_MAX_CUT, movieInfoPlan, nextInfoCut } from './stage-info-fit';
import { colors, fonts, useDesign } from '@/theme';
import { META_SEPARATOR } from '@/lib/media-labels';

/** D2 Bühne (1920 × 1080 points): copy column, info column right, bottom margin. */
const STAGE = {
  copyWidth: 880,
  infoWidth: 460,
  infoRight: 96,
  bottom: 72,
  top: 120,
  stripTop: 64,
  stripBottom: 16,
} as const;

export type Credit = { label: string; value: string };

type Person = components['schemas']['TmdbPerson'];

const CREDIT_KINDS = [
  { key: 'director', types: ['director', 'directing'] },
  { key: 'writer', types: ['writer', 'writing', 'screenplay'] },
  { key: 'cast', types: ['cast', 'actor', 'acting'] },
] as const;

/** Director, writing and the first three cast members, in that order; kinds without people are left out. */
export function peopleCredits(
  people: readonly Person[] | null | undefined,
  t: TFunction,
  castCount = 3
): Credit[] {
  const sorted = [...(people ?? [])].sort((a, b) => (a.sortOrder ?? 99) - (b.sortOrder ?? 99));
  return CREDIT_KINDS.flatMap(({ key, types }) => {
    const names = sorted
      .filter((person) => person.name && types.includes((person.type ?? '').toLowerCase() as never))
      .map((person) => person.name!)
      .slice(0, key === 'cast' ? castCount : 2);
    return names.length ? [{ label: t(`detail.credits.${key}`), value: names.join(', ') }] : [];
  });
}

export type LargeDetailProps = {
  testID: string;
  kindLabel: string;
  title: string;
  logoUrl?: string | null;
  backdropUrl?: string | null;
  tint?: string | null;
  tint2?: string | null;
  /** Title art highlight (sizes the TV glass of the rail over this page). */
  highlight?: string | null;
  facts: string[];
  certification?: string | null;
  overview?: string | null;
  /** Series: the selected episode's title under a small logo; the pill then carries `kindLabel`. */
  heading?: string;
  /** Series: replaces the "Details" info column ("About the series"). */
  info?: ReactNode;
  /** Resume bar or the next-episode line. */
  status?: ReactNode;
  actions: ReactNode;
  credits?: Credit[];
  /** Series: season chips and the episode strip under the copy, edge to edge (see stageGutters). */
  children?: ReactNode;
  /** Bühne: the what-plays chip row under the buttons. */
  chips?: ReactNode;
  /** Bühne info column: TMDB rating (0..10). */
  rating?: number | null;
  /** The "Details" column opens the About sheet. */
  onInfo?: () => void;
  /** The narrow layout's info button label (default "All details"). */
  infoLabel?: string;
  /** Series: the selected episode; a change fades the copy in (≤ 200 ms, no remount). */
  copyKey?: string;
  /** The title is still loading: skeleton copy. */
  loading?: boolean;
};

/** Left and right page padding of the Bühne; full-width rows (the episode strip) pad themselves with it. */
export function useStageGutters() {
  const { s } = useShell();
  const insets = useSafeAreaInsets();
  return { start: s(SHELL.row.left), end: s(STAGE.infoRight) + insets.right };
}

/** Large shell (TV, web, tablet): the D2 Bühne. */
export function LargeDetail(props: LargeDetailProps) {
  return (
    <ShellDesign>
      <StageLayout {...props} />
    </ShellDesign>
  );
}

/** D2 Bühne (movie): artwork above, copy + buttons + chip row bottom-left, the info column bottom-right. */
function StageLayout({
  testID,
  kindLabel,
  title,
  logoUrl,
  backdropUrl,
  tint,
  tint2,
  highlight,
  facts,
  certification,
  overview,
  status,
  actions,
  credits,
  chips,
  rating,
  heading,
  info,
  children,
  onInfo,
  infoLabel,
  copyKey,
  loading = false,
}: LargeDetailProps) {
  const { t } = useTranslation();
  const gutters = useStageGutters();
  const format = useFormat();
  const { s } = useShell();
  const design = useDesign();
  const insets = useSafeAreaInsets();
  const setAmbient = useSetAmbient();
  const clearAmbient = useClearAmbient();
  const backClearance = useBackControlClearance();
  const copyStyle = useCopyFade(copyKey);
  // Concept "long titles": a two-line episode title shortens the overview to two lines (the stage height is fixed).
  const [headingLines, setHeadingLines] = useState(1);
  useFocusEffect(
    useCallback(() => {
      const art = backdropUrl ? { image: backdropUrl, tint, tint2, highlight } : null;
      setAmbient(art);
      return () => clearAmbient(art);
    }, [setAmbient, clearAmbient, backdropUrl, tint, tint2, highlight])
  );
  const text = (size: number, family: string = fonts.body) => ({
    fontFamily: family,
    fontSize: s(size),
    lineHeight: s(size * 1.4),
  });
  // Tablet portrait / narrow windows: the info column gives way to a button in the action row (concept D2).
  const narrow = design.window.width < s(STAGE.copyWidth + STAGE.infoWidth + 400);
  const infoButton = narrow && onInfo;
  const side =
    info ??
    (credits?.length || rating ? (
      <StageInfo
        title={t('detail.details')}
        more={t('detail.moreDetails')}
        onPress={onInfo}
        maxCut={MOVIE_INFO_MAX_CUT}>
        {(cut) => {
          const plan = movieInfoPlan(cut);
          return (
            <>
              {(credits ?? []).slice(0, plan.credits).map((credit) => (
                <View key={credit.label} style={{ flexDirection: 'row', gap: s(20) }}>
                  <Text
                    numberOfLines={1}
                    style={[text(18), { width: s(110), color: colors.foreground.muted }]}>
                    {credit.label}
                  </Text>
                  <Text
                    numberOfLines={plan.creditLines}
                    style={[text(20, fonts.bodyMedium), { flex: 1 }]}>
                    {credit.value}
                  </Text>
                </View>
              ))}
              {rating && plan.rating ? (
                <View style={{ flexDirection: 'row', gap: s(20), alignItems: 'center' }}>
                  <Text
                    numberOfLines={1}
                    style={[text(18), { width: s(110), color: colors.foreground.muted }]}>
                    {t('detail.rating')}
                  </Text>
                  <Text style={[text(20, fonts.bodyMedium), { flex: 1 }]}>
                    <Text
                      style={{
                        color: colors.warning.DEFAULT,
                      }}>{`★ ${format.decimal(rating)}`}</Text>
                    {t('detail.ratingSource')}
                  </Text>
                </View>
              ) : null}
            </>
          );
        }}
      </StageInfo>
    ) : null);

  return (
    <View testID={testID} style={{ flex: 1 }}>
      <BackControl />
      <View style={[StyleSheet.absoluteFill, { pointerEvents: 'none' }]}>
        <View style={[StyleSheet.absoluteFill, { left: '12%' }]}>
          <HeroFade>{backdropUrl ? <Artwork uri={backdropUrl} /> : null}</HeroFade>
        </View>
        <LinearGradient
          style={StyleSheet.absoluteFill}
          colors={[colors.scrim.DEFAULT, colors.scrim.clear]}
          start={{ x: 0, y: 0 }}
          end={{ x: 0.6, y: 0 }}
        />
        <LinearGradient
          style={StyleSheet.absoluteFill}
          colors={[colors.scrim.clear, colors.scrim.clear, colors.scrim.DEFAULT]}
          locations={[0, 0.45, 1]}
        />
      </View>
      <ScrollView
        style={{ flex: 1 }}
        // TV series: one fixed stage; focus entering the strip must not scroll the copy away.
        scrollEnabled={!(design.isTV && children)}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{
          flexGrow: 1,
          justifyContent: 'flex-end',
          paddingLeft: gutters.start,
          paddingRight: gutters.end,
          // Series: the strip brings its own focus room at the bottom; the copy may start under the tvOS tab bar.
          paddingTop: Math.max(s(children ? STAGE.stripTop : STAGE.top), backClearance),
          paddingBottom: s(children ? STAGE.stripBottom : STAGE.bottom) + insets.bottom,
        }}>
        <View
          style={{
            flexDirection: narrow ? 'column' : 'row',
            alignItems: narrow ? 'flex-start' : 'flex-end',
            justifyContent: 'space-between',
            gap: s(40),
          }}>
          {loading ? (
            <View testID="hero-skeleton" aria-busy style={{ gap: s(22) }}>
              <Skeleton width={s(120)} height={s(36)} radius={s(18)} />
              <Skeleton width={s(520)} height={s(100)} radius={s(12)} />
              <Skeleton width={s(420)} height={s(28)} radius={s(8)} />
              <Skeleton width={s(820)} height={s(96)} radius={s(8)} />
              <Skeleton width={s(480)} height={s(72)} radius={s(36)} />
              <Skeleton width={s(620)} height={s(80)} radius={s(12)} />
            </View>
          ) : (
            <View style={{ width: s(STAGE.copyWidth), maxWidth: '100%', gap: s(18) }}>
              {heading ? (
                <HeroTitle
                  title={title}
                  logoUri={logoUrl}
                  logoHeight={s(62)}
                  // Apple TV: clear of the native tab bar, which starts at x ≈ 540.
                  logoWidth={s(340)}
                  textStyle={{
                    fontFamily: fonts.displayBold,
                    fontSize: s(48),
                    lineHeight: s(56),
                    color: colors.foreground.DEFAULT,
                  }}
                />
              ) : null}
              <View
                style={{
                  alignSelf: 'flex-start',
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: s(10),
                  height: s(36),
                  paddingHorizontal: s(16),
                  borderRadius: s(18),
                  backgroundColor: colors.glass.DEFAULT,
                }}>
                <View
                  style={{
                    width: s(10),
                    height: s(10),
                    borderRadius: s(5),
                    backgroundColor: tint ?? colors.accent.DEFAULT,
                  }}
                />
                {/* Keyed + one line: Android kept a stale width after an in-place update and hid the number on line 2. */}
                <Text
                  key={kindLabel}
                  testID="stage-pill"
                  numberOfLines={1}
                  style={[text(18, fonts.bodyMedium), { color: colors.foreground.DEFAULT }]}>
                  {kindLabel}
                </Text>
              </View>
              <Animated.View testID="stage-copy" style={[{ gap: s(18) }, copyStyle]}>
                {heading ? (
                  <Text
                    testID="stage-heading"
                    numberOfLines={2}
                    onTextLayout={(event) =>
                      setHeadingLines(Math.min(2, event.nativeEvent.lines.length || 1))
                    }
                    style={{
                      fontFamily: fonts.displayBold,
                      fontSize: s(56),
                      lineHeight: s(64),
                      letterSpacing: -s(1),
                      color: colors.foreground.DEFAULT,
                    }}>
                    {heading}
                  </Text>
                ) : (
                  <HeroTitle
                    title={title}
                    logoUri={logoUrl}
                    logoHeight={s(SHELL.logo.height - 40)}
                    logoWidth={Math.min(s(SHELL.logo.width), s(400))}
                    textStyle={{
                      fontFamily: fonts.displayBold,
                      fontSize: s(92),
                      lineHeight: s(100),
                      letterSpacing: -s(2),
                      color: colors.foreground.DEFAULT,
                    }}
                  />
                )}
                <View
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: s(14),
                    flexWrap: 'wrap',
                  }}>
                  {facts.length ? (
                    <Text numberOfLines={1} style={[text(24), { color: colors.foreground.muted }]}>
                      {facts.join(META_SEPARATOR)}
                    </Text>
                  ) : null}
                  {certification ? (
                    <View
                      testID="detail-certification"
                      style={{
                        borderWidth: s(1.5),
                        borderColor: colors.foreground.muted,
                        borderRadius: s(6),
                        paddingHorizontal: s(8),
                      }}>
                      <Text
                        style={[text(18, fonts.bodySemiBold), { color: colors.foreground.muted }]}>
                        {certification}
                      </Text>
                    </View>
                  ) : null}
                  {status}
                </View>
                {overview ? (
                  <Text
                    testID="stage-overview"
                    numberOfLines={heading && headingLines > 1 ? 2 : 3}
                    style={[text(24), { color: colors.foreground.DEFAULT }]}>
                    {overview}
                  </Text>
                ) : null}
              </Animated.View>
              <View>
                <FocusGuide remember>
                  <StageActionRow>
                    {actions}
                    {infoButton && !loading ? (
                      <GlassButton
                        testID="detail-info-button"
                        iconOnly
                        icon={Info}
                        label={infoLabel ?? t('detail.moreDetails')}
                        tint={tint}
                        onPress={onInfo}
                      />
                    ) : null}
                  </StageActionRow>
                </FocusGuide>
                {chips}
              </View>
            </View>
          )}
          {narrow && (!side || infoButton) ? null : (
            <View
              style={{
                marginBottom: narrow ? 0 : s(CHIPS.top + CHIPS.row + CHIPS.gap + CHIPS.reason),
              }}>
              {side}
            </View>
          )}
        </View>
        {children ? (
          <View
            style={{
              marginTop: s(20),
              marginLeft: -gutters.start,
              marginRight: -gutters.end,
              gap: s(8),
            }}>
            {children}
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

/** Opacity of the stage copy: a new `key` fades it in from 0.35 over 180 ms (skipped with reduced motion). */
function useCopyFade(key: string | undefined) {
  const reduced = useReducedMotion();
  const opacity = useSharedValue(1);
  const first = useRef(key);
  useEffect(() => {
    if (key === first.current || reduced) return;
    first.current = key;
    opacity.set(0.35);
    opacity.set(withTiming(1, { duration: 180 }));
  }, [key, reduced, opacity]);
  return useAnimatedStyle(() => ({ opacity: opacity.get() }));
}

/** The glass info column of the Bühne ("Details", "About the series"); with `onPress` it opens the About sheet. */
export function StageInfo({
  title,
  children,
  more,
  onPress,
  maxCut = 0,
}: {
  title: string;
  /** A function gets the TV content cut (0 = all content) that keeps the lifted column below `useStageTopLimit`. */
  children: ReactNode | ((cut: number) => ReactNode);
  /** "More about the series" line at the bottom of a pressable column. */
  more?: string;
  onPress?: () => void;
  maxCut?: number;
}) {
  const { s } = useShell();
  const design = useDesign();
  const radius = s(32);
  const limit = useStageTopLimit();
  const columnRef = useRef<View>(null);
  const [cut, setCut] = useState(0);
  // TV: hidden until it fits, so a cut never shows as a jump.
  const [settled, setSettled] = useState(!design.isTV || !maxCut);
  const fit = () => {
    if (!design.isTV || !maxCut) return;
    columnRef.current?.measureInWindow((_x, y, _width, height) => {
      const lifted = liftedTop(y, height, design.focus, design.focus.cardScale);
      const next = nextInfoCut(cut, lifted, limit, maxCut);
      if (next !== cut) setCut(next);
      else setSettled(true);
    });
  };
  // A cut that does not change the height fires no layout: check again after every cut.
  const refit = useEffectEvent(fit);
  useEffect(() => {
    if (cut) refit();
  }, [cut]);
  useEffect(() => {
    if (settled) return;
    const timer = setTimeout(() => setSettled(true), 1500);
    return () => clearTimeout(timer);
  }, [settled]);
  const column = (
    <View
      ref={columnRef}
      testID="detail-info"
      onLayout={fit}
      style={{
        width: s(STAGE.infoWidth),
        padding: s(28),
        gap: s(12),
        borderRadius: radius,
        borderCurve: 'continuous',
        borderWidth: 1,
        borderColor: colors.glass.border,
        backgroundColor: colors.glass.tinted,
        opacity: settled ? 1 : 0,
      }}>
      <Text
        style={{
          fontFamily: fonts.bodySemiBold,
          fontSize: s(16),
          lineHeight: s(22),
          letterSpacing: s(1.5),
          color: colors.foreground.muted,
          textTransform: 'uppercase',
        }}>
        {title}
      </Text>
      {typeof children === 'function' ? children(cut) : children}
      {onPress && more ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: s(6) }}>
          <Text
            style={{
              fontFamily: fonts.bodySemiBold,
              fontSize: s(18),
              lineHeight: s(26),
              color: colors.foreground.DEFAULT,
            }}>
            {more}
          </Text>
          <ChevronRight size={s(20)} color={colors.foreground.DEFAULT} />
        </View>
      ) : null}
    </View>
  );
  if (!onPress) return column;
  return (
    <Focusable
      testID="detail-info-open"
      role="button"
      accessibilityLabel={more ? `${title}, ${more}` : title}
      onPress={onPress}>
      <FocusLift kind="card" radius={radius}>
        {column}
      </FocusLift>
    </Focusable>
  );
}

/** TV: the highest y a lifted Bühne element may reach (Apple TV: below the native tab bar; Android TV: screen top). */
function useStageTopLimit(): number {
  const { s } = useShell();
  return Platform.OS === 'ios' ? s(SHELL.tvosTabBarBottom) : 0;
}
