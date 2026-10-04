import { useFocusEffect, useRouter } from 'expo-router';
import { Info, Play } from '@/components/icons';
import { useCallback, useEffect, useRef, useState, type Ref } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, StyleSheet, View } from 'react-native';
import Animated, {
  FadeIn,
  FadeOut,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useTVEvents } from '@/components/focus/use-tv-events';
import { resumeSeconds, watchProgress } from '@/browse/title-actions';
import { useClearAmbient, useSetAmbient } from '@/components/ambient';
import { GlassButton } from '@/components/glass';
import { Artwork } from '@/components/media/artwork';
import { HeroTitle } from '@/components/media/hero';
import { SpecLabels } from '@/components/spec';
import { Text } from '@/components/ui/text';
import { useFormat } from '@/i18n/format';
import { TICKS_PER_SECOND } from '@/player/playback-api';
import { CopyWash, HeroFade } from '@/shell/hero-fade';
import { SHELL } from '@/shell/shell-metrics';
import { useShell } from '@/shell/use-shell';
import { useWindowControlsInset } from '@/shell/window-controls';
import { colors, fonts, motion, useFocusGap } from '@/theme';
import { META_SEPARATOR } from '@/lib/media-labels';

import { useFeatured, type Featured, type FeaturedStore } from './featured';
import { featuredInfoHref, useFeaturedDetail, useMeta, usePlayFeatured } from './home-hero';

const LOGO_HEIGHT =
  Platform.OS === 'ios' && Platform.isTV ? SHELL.logo.tvosHeight : SHELL.logo.height;

const TITLE_LINE = 1.05;

/** A text title (no logo) gets two full lines in the logo box: smaller type rather than a cut first line (Q1-55). */
export function heroTitleSize(boxHeight: number, size: number): number {
  return Math.min(size, Math.floor(boxHeight / (2 * TITLE_LINE)));
}

/** Copy top: the mockup's, raised on short windows (tablet text/button floors), never above the rail top. */
export function heroCopyTop(
  s: (value: number) => number,
  copyHeight: number,
  safeTop: number,
  rowsTop = s(SHELL.row.top)
) {
  const fitTop = rowsTop - s(SHELL.row.gap * 2) - copyHeight;
  return Math.max(safeTop + s(SHELL.rail.top), Math.min(s(SHELL.hero.copyTop), fitTop));
}

/** Rows top: the mockup's, or lower when the copy still ends within two row gaps of it. */
export function heroRowsTop(
  s: (value: number) => number,
  copyBottom: number,
  rowsTop = s(SHELL.row.top)
) {
  return Math.max(rowsTop, copyBottom + s(SHELL.row.gap * 2));
}

export type ShellHeroProps = {
  store: FeaturedStore;
  /** TV: rows below the first are focused, the hero copy steps back (Apple TV style). */
  collapsed?: boolean;
  /** TV: the hero's first button, the target of Up from the first row. */
  targetRef?: Ref<View>;
  onButtonFocus?: (focused: boolean) => void;
  onCopyBottom?: (bottom: number) => void;
};

/** Large-screen hero: follows the focused (TV) or hovered (web) title and paints the ambient backdrop. */
export function ShellHero({
  store,
  collapsed = false,
  targetRef,
  onButtonFocus,
  onCopyBottom,
}: ShellHeroProps) {
  const { s, heroFrame } = useShell();
  const shown = useSharedValue(1);
  useEffect(() => {
    shown.set(withTiming(collapsed ? 0 : 1, { duration: motion.enter }));
  }, [collapsed, shown]);
  const copyStyle = useAnimatedStyle(() => ({ opacity: shown.get() }));
  const artStyle = useAnimatedStyle(() => ({ opacity: 0.45 + 0.55 * shown.get() }));
  const featured = useFeatured(store);
  const detail = useFeaturedDetail(featured);
  const setAmbient = useSetAmbient();
  const clearAmbient = useClearAmbient();
  const image = featured?.backdropUrl ?? detail?.backdropUrl ?? null;
  const tint = featured?.tint ?? null;
  const tint2 = featured?.tint2 ?? null;
  const highlight = featured?.highlight ?? null;
  // Only the focused Home paints the room; other tabs and screens start from the neutral wash.
  useFocusEffect(
    useCallback(() => {
      const title = image ? { image, tint, tint2, highlight } : null;
      setAmbient(title);
      return () => clearAmbient(title);
    }, [setAmbient, clearAmbient, image, tint, tint2, highlight])
  );

  return (
    <View
      testID="home-tv-hero"
      style={{
        pointerEvents: 'box-none',
        position: 'absolute',
        left: 0,
        top: 0,
        right: 0,
        height: heroFrame.heroHeight,
      }}>
      <Animated.View
        style={[
          {
            pointerEvents: 'none',
            position: 'absolute',
            top: 0,
            right: 0,
            bottom: 0,
            width: s(SHELL.hero.backdropWidth),
          },
          artStyle,
        ]}>
        <HeroFade>
          {image ? (
            <Animated.View
              key={image}
              entering={FadeIn.duration(motion.ambient)}
              exiting={FadeOut.duration(motion.ambient)}
              style={StyleSheet.absoluteFill}>
              <Artwork uri={image} />
            </Animated.View>
          ) : null}
        </HeroFade>
      </Animated.View>
      <Animated.View
        style={[
          StyleSheet.absoluteFill,
          { pointerEvents: collapsed ? 'none' : 'box-none' },
          copyStyle,
        ]}>
        <View
          style={{
            pointerEvents: 'none',
            position: 'absolute',
            left: 0,
            top: 0,
            width: s(1200),
            height: s(SHELL.hero.height + 120),
          }}>
          <CopyWash color={colors.scrim.DEFAULT} />
        </View>
        {featured ? (
          <HeroCopy
            featured={featured}
            detail={detail}
            store={store}
            hidden={collapsed}
            targetRef={targetRef}
            onButtonFocus={onButtonFocus}
            onCopyBottom={onCopyBottom}
          />
        ) : null}
      </Animated.View>
    </View>
  );
}

function HeroCopy({
  featured,
  detail,
  store,
  hidden,
  targetRef,
  onButtonFocus,
  onCopyBottom,
}: {
  featured: Featured;
  detail: ReturnType<typeof useFeaturedDetail>;
  store: FeaturedStore;
  hidden: boolean;
  targetRef?: Ref<View>;
  onButtonFocus?: (focused: boolean) => void;
  onCopyBottom?: (bottom: number) => void;
}) {
  const { t } = useTranslation();
  const format = useFormat();
  const router = useRouter();
  const { s, heroFrame } = useShell();
  const buttonGap = useFocusGap(s(16));
  const insets = useSafeAreaInsets();
  const controls = useWindowControlsInset();
  const [copyHeight, setCopyHeight] = useState(0);
  const meta = useMeta(featured, detail);
  const watch = detail?.watch;
  const progress = featured.progress ?? watchProgress(watch);
  const resume = resumeSeconds(watch);
  const left =
    watch?.durationTicks && watch.positionTicks
      ? (watch.durationTicks - watch.positionTicks) / TICKS_PER_SECOND
      : undefined;
  const text = (size: number, family: string = fonts.body) => ({
    fontFamily: family,
    fontSize: s(size),
    lineHeight: s(size * 1.4),
  });
  const { type } = SHELL;
  const titleSize = heroTitleSize(s(LOGO_HEIGHT), s(type.heroTitle));
  const screenFocused = useRef(false);
  useFocusEffect(
    useCallback(() => {
      screenFocused.current = true;
      return () => {
        screenFocused.current = false;
      };
    }, [])
  );
  const playFeatured = usePlayFeatured(detail);
  // Set when Play/Pause hit a card the hero has not caught up with; plays once its detail is loaded.
  const playWhenReady = useRef<string | null>(null);
  useEffect(() => {
    if (playWhenReady.current !== featured.key || !detail?.playWorkId) return;
    playWhenReady.current = null;
    playFeatured();
  });
  // TV remote Play/Pause on a Home card or hero button starts the focused card's title.
  useTVEvents((event) => {
    const keyAction = (event as { eventKeyAction?: number }).eventKeyAction;
    if (event.eventType !== 'playPause' || !screenFocused.current || keyAction === 0) return;
    const target = store.playTarget();
    if (!target || target.key === featured.key) {
      if (detail?.playWorkId) playFeatured();
      else playWhenReady.current = featured.key;
      return;
    }
    playWhenReady.current = target.key;
    store.flush();
  });
  const focusProps = {
    focusable: !hidden,
    onFocus: () => onButtonFocus?.(true),
    onBlur: () => onButtonFocus?.(false),
  };
  const openInfo = () => router.push(featuredInfoHref(featured, detail));

  const copyTop = heroCopyTop(s, copyHeight, insets.top + controls, heroFrame.rowsTop);
  // From the computed top: web's onLayout misses moves without a resize, so its y can be stale (Q1-22).
  useEffect(() => {
    if (copyHeight) onCopyBottom?.(copyTop + copyHeight);
  }, [copyTop, copyHeight, onCopyBottom]);

  return (
    <View
      testID="home-tv-hero-copy"
      onLayout={(event) => setCopyHeight(event.nativeEvent.layout.height)}
      style={{
        position: 'absolute',
        left: s(SHELL.hero.copyLeft),
        top: copyTop,
        width: s(SHELL.hero.copyWidth),
        gap: s(14),
      }}>
      <View
        testID="home-tv-hero-eyebrow"
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
            backgroundColor: featured.tint ?? colors.accent.DEFAULT,
          }}
        />
        <Text
          numberOfLines={1}
          style={[text(type.eyebrow, fonts.bodyMedium), { color: colors.foreground.DEFAULT }]}>
          {featured.eyebrow}
        </Text>
      </View>
      <View
        testID={`home-tv-hero-${featured.key}`}
        accessibilityLabel={featured.title}
        style={{ height: s(LOGO_HEIGHT), justifyContent: 'flex-end' }}>
        <HeroTitle
          title={featured.title}
          logoUri={detail?.logoUrl}
          logoHeight={s(LOGO_HEIGHT - 30)}
          logoWidth={s(SHELL.logo.width)}
          textStyle={{
            fontFamily: fonts.displayBold,
            fontSize: titleSize,
            lineHeight: titleSize * TITLE_LINE,
            letterSpacing: -s(1.5),
          }}
        />
      </View>
      {featured.detail ? (
        <Text
          numberOfLines={1}
          style={[text(type.meta, fonts.bodySemiBold), { color: colors.foreground.DEFAULT }]}>
          {featured.detail}
        </Text>
      ) : null}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: s(12), flexWrap: 'wrap' }}>
        {meta.length ? (
          <Text numberOfLines={1} style={[text(type.meta), { color: colors.foreground.muted }]}>
            {meta.join(META_SEPARATOR)}
          </Text>
        ) : null}
        {detail?.certification ? (
          <View
            style={{
              borderWidth: s(1.5),
              borderColor: colors.foreground.muted,
              borderRadius: s(4),
              paddingHorizontal: s(8),
            }}>
            <Text style={[text(17, fonts.bodySemiBold), { color: colors.foreground.muted }]}>
              {detail.certification}
            </Text>
          </View>
        ) : null}
        <SpecLabels spec={featured.spec} max={4} />
      </View>
      {progress !== undefined && progress > 0 ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: s(16) }}>
          <View
            style={{
              width: s(220),
              height: s(4),
              borderRadius: s(2),
              backgroundColor: colors.glass.strong,
            }}>
            <View
              style={{
                width: `${Math.round(progress * 100)}%`,
                height: '100%',
                borderRadius: s(2),
                backgroundColor: colors.foreground.DEFAULT,
              }}
            />
          </View>
          {left ? (
            <Text style={[text(18), { color: colors.foreground.muted }]}>
              {t('media.remaining', { time: format.duration(left) })}
            </Text>
          ) : null}
        </View>
      ) : null}
      {featured.overview ? (
        <Text
          numberOfLines={2}
          style={[text(type.overview), { color: colors.foreground.DEFAULT, opacity: 0.86 }]}>
          {featured.overview}
        </Text>
      ) : null}
      <View
        style={{
          flexDirection: 'row',
          gap: buttonGap,
          marginTop: s(16),
        }}>
        {detail?.playWorkId ? (
          <GlassButton
            testID="home-hero-play"
            ref={targetRef}
            tone="solid"
            icon={Play}
            {...focusProps}
            label={t(resume ? 'common.resume' : 'common.play')}
            onPress={playFeatured}
          />
        ) : null}
        <GlassButton
          testID="home-hero-info"
          // Only once the details are known: a Play button that appears later must not lose focus to it.
          ref={detail && !detail.playWorkId ? targetRef : undefined}
          icon={Info}
          {...focusProps}
          tint={featured.tint}
          label={t('common.moreInfo')}
          onPress={openInfo}
        />
      </View>
    </View>
  );
}
