import { useFocusEffect, useRouter } from 'expo-router';
import { Info, Play } from 'lucide-react-native';
import { useCallback, useEffect, useRef, type Ref } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, useTVEventHandler, View } from 'react-native';
import Animated, {
  FadeIn,
  FadeOut,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

import { resumeSeconds, usePlay, watchProgress } from '@/browse/title-actions';
import { useSetAmbient } from '@/components/ambient';
import { GlassButton } from '@/components/glass';
import { Artwork } from '@/components/media/artwork';
import { HeroTitle } from '@/components/media/hero';
import { SpecLabels } from '@/components/spec';
import { Text } from '@/components/ui/text';
import { useFormat } from '@/i18n/format';
import { titleHref } from '@/navigation/routes';
import { TICKS_PER_SECOND } from '@/player/playback-api';
import { CopyWash, HeroFade } from '@/shell/hero-fade';
import { SHELL } from '@/shell/shell-metrics';
import { useShell } from '@/shell/use-shell';
import { colors, fonts, motion } from '@/theme';

import { useFeatured, type Featured, type FeaturedStore } from './featured';
import { useFeaturedDetail, useMeta } from './home-hero';

const useTVEvents: typeof useTVEventHandler = useTVEventHandler ?? (() => undefined);

export type ShellHeroProps = {
  store: FeaturedStore;
  /** TV: rows below the first are focused, the hero copy steps back (Apple TV style). */
  collapsed?: boolean;
  /** TV: the hero's first button, the target of Up from the first row. */
  targetRef?: Ref<View>;
  onButtonFocus?: (focused: boolean) => void;
};

/** Large-screen hero: follows the focused (TV) or hovered (web) title and paints the ambient backdrop. */
export function ShellHero({ store, collapsed = false, targetRef, onButtonFocus }: ShellHeroProps) {
  const { s } = useShell();
  const shown = useSharedValue(1);
  useEffect(() => {
    shown.set(withTiming(collapsed ? 0 : 1, { duration: motion.enter }));
  }, [collapsed, shown]);
  const copyStyle = useAnimatedStyle(() => ({ opacity: shown.get() }));
  const artStyle = useAnimatedStyle(() => ({ opacity: 0.45 + 0.55 * shown.get() }));
  const featured = useFeatured(store);
  const detail = useFeaturedDetail(featured);
  const setAmbient = useSetAmbient();
  const image = featured?.backdropUrl ?? detail?.backdropUrl ?? null;
  const tint = featured?.tint ?? null;
  const tint2 = featured?.tint2 ?? null;
  // Only the focused Home paints the room; other tabs and screens start from the neutral wash.
  useFocusEffect(
    useCallback(() => {
      setAmbient(image ? { image, tint, tint2 } : null);
      return () => setAmbient(null);
    }, [setAmbient, image, tint, tint2])
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
        height: s(SHELL.hero.height),
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
            width: s(1100),
            height: s(SHELL.hero.height + 120),
          }}>
          <CopyWash color={colors.scrim.DEFAULT} />
        </View>
        {featured ? (
          <HeroCopy
            featured={featured}
            detail={detail}
            hidden={collapsed}
            targetRef={targetRef}
            onButtonFocus={onButtonFocus}
          />
        ) : null}
      </Animated.View>
    </View>
  );
}

function HeroCopy({
  featured,
  detail,
  hidden,
  targetRef,
  onButtonFocus,
}: {
  featured: Featured;
  detail: ReturnType<typeof useFeaturedDetail>;
  hidden: boolean;
  targetRef?: Ref<View>;
  onButtonFocus?: (focused: boolean) => void;
}) {
  const { t } = useTranslation();
  const format = useFormat();
  const router = useRouter();
  const play = usePlay();
  const { s } = useShell();
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
  const screenFocused = useRef(false);
  useFocusEffect(
    useCallback(() => {
      screenFocused.current = true;
      return () => {
        screenFocused.current = false;
      };
    }, [])
  );
  const playFeatured = () =>
    detail?.playWorkId &&
    play({ workId: detail.playWorkId, title: detail.playTitle, startSeconds: resume });
  // TV remote Play/Pause on a Home card or hero button starts the featured title.
  useTVEvents((event) => {
    const keyAction = (event as { eventKeyAction?: number }).eventKeyAction;
    if (event.eventType === 'playPause' && screenFocused.current && keyAction !== 0) playFeatured();
  });
  const focusProps = {
    focusable: !hidden,
    onFocus: () => onButtonFocus?.(true),
    onBlur: () => onButtonFocus?.(false),
  };
  const openInfo = () =>
    router.push(
      titleHref({ mediaType: featured.kind === 'series' ? 'tv' : 'movie', tmdbId: featured.tmdbId })
    );

  return (
    <View
      style={{
        position: 'absolute',
        left: s(SHELL.hero.copyLeft - SHELL.rail.width),
        top: s(SHELL.hero.copyTop),
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
        style={{ height: s(SHELL.logo.height), justifyContent: 'flex-end' }}>
        <HeroTitle
          title={featured.title}
          logoUri={detail?.logoUrl}
          logoHeight={s(SHELL.logo.height - 30)}
          logoWidth={s(SHELL.logo.width)}
          textStyle={{
            fontFamily: fonts.displayBold,
            fontSize: s(type.heroTitle),
            lineHeight: s(type.heroTitle * 1.05),
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
            {meta.join('  ·  ')}
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
          gap: s(16),
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
          ref={detail?.playWorkId ? undefined : targetRef}
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
