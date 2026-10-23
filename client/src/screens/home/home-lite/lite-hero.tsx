import { useFocusEffect, useRouter } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

import { resumeSeconds } from '@/browse/title-actions';
import { useTVEvents } from '@/components/focus/use-tv-events';
import { FocusGuide, END_OF_ROW } from '@/components/focus';
import { GlassButton } from '@/components/glass';
import { Info, Play } from '@/components/icons';
import { Artwork } from '@/components/media/artwork';
import { HeroTitle } from '@/components/media/hero';
import { Text } from '@/components/ui/text';
import { withAlpha } from '@/lib/color';
import { META_SEPARATOR } from '@/lib/media-labels';
import { SHELL } from '@/shell/shell-metrics';
import { useShell } from '@/shell/use-shell';
import { colors, fonts, useFocusGap } from '@/theme';

import { useFeatured, type Featured, type FeaturedStore } from '../featured';
import { featuredInfoHref, useFeaturedDetail, useMeta, usePlayFeatured } from '../home-hero';

/** Lite hero size in 1920 × 1080 shell points: a short banner instead of the 660 pt stage. */
export const LITE_HERO = { height: 430, artWidth: 1180, logoHeight: 120, titleSize: 60 };

// Any snap offset beyond the page height clamps the TV scroll to 0 (as FocusSection's pageTop).
export const TOP_SNAP = 100_000;

/** Lite Home banner: the lead title (first Continue watching card, else the top pick), static; it never follows focus. */
export function LiteHero({ store, fallback }: { store: FeaturedStore; fallback?: Featured }) {
  const { s } = useShell();
  const featured = useFeatured(store) ?? fallback ?? null;
  const detail = useFeaturedDetail(featured);
  const image = featured?.backdropUrl ?? detail?.backdropUrl ?? null;
  const sizes = featured?.backdropUrl ? featured.backdropSizes : detail?.backdropSizes;
  return (
    <View
      testID="home-lite-hero"
      collapsable={false}
      scrollSnapOffset={TOP_SNAP}
      style={{ height: s(LITE_HERO.height) }}>
      <View
        style={{
          pointerEvents: 'none',
          position: 'absolute',
          top: 0,
          right: 0,
          bottom: 0,
          width: s(LITE_HERO.artWidth),
        }}>
        {image ? (
          <Artwork uri={image} sizes={sizes} request={{ kind: 'backdrop', size: 'medium' }} />
        ) : null}
        {/* Two static washes instead of masks: drawn once, nothing animates. */}
        <LinearGradient
          style={StyleSheet.absoluteFill}
          colors={[colors.background, withAlpha(colors.background, 0)]}
          locations={[0, 0.55]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 0 }}
        />
        <LinearGradient
          style={StyleSheet.absoluteFill}
          colors={[withAlpha(colors.background, 0), colors.background]}
          locations={[0.45, 1]}
        />
      </View>
      {featured ? <LiteHeroCopy featured={featured} detail={detail} store={store} /> : null}
    </View>
  );
}

function LiteHeroCopy({
  featured,
  detail,
  store,
}: {
  featured: Featured;
  detail: ReturnType<typeof useFeaturedDetail>;
  store: FeaturedStore;
}) {
  const { t } = useTranslation();
  const router = useRouter();
  const { s } = useShell();
  const buttonGap = useFocusGap(s(16));
  const meta = useMeta(featured, detail);
  const playFeatured = usePlayFeatured(detail);
  const resume = resumeSeconds(detail?.watch);
  const text = (size: number, family: string = fonts.body) => ({
    fontFamily: family,
    fontSize: s(size),
    lineHeight: s(size * 1.35),
  });
  // A hero button focused: the Play key plays the hero's title, not the card focused before.
  const focusProps = { onFocus: () => store.set(featured) };
  return (
    <View
      testID="home-lite-hero-copy"
      style={{
        position: 'absolute',
        left: s(SHELL.hero.copyLeft),
        top: s(56),
        width: s(SHELL.hero.copyWidth),
        gap: s(10),
      }}>
      <Text
        numberOfLines={1}
        style={[text(SHELL.type.eyebrow, fonts.bodyMedium), { color: colors.foreground.muted }]}>
        {featured.eyebrow}
      </Text>
      <View
        testID={`home-lite-hero-${featured.key}`}
        accessibilityLabel={featured.title}
        style={{ height: s(LITE_HERO.logoHeight), justifyContent: 'flex-end' }}>
        <HeroTitle
          title={featured.title}
          logoUri={detail?.logoUrl}
          logoHeight={s(LITE_HERO.logoHeight)}
          logoWidth={s(440)}
          textStyle={{
            fontFamily: fonts.displayBold,
            fontSize: s(LITE_HERO.titleSize),
            lineHeight: s(LITE_HERO.titleSize * 1.05),
          }}
        />
      </View>
      {featured.detail || meta.length ? (
        <Text numberOfLines={1} style={[text(SHELL.type.meta), { color: colors.foreground.muted }]}>
          {[featured.detail, ...meta].filter(Boolean).join(META_SEPARATOR)}
        </Text>
      ) : null}
      {featured.overview ? (
        <Text
          numberOfLines={2}
          style={[text(SHELL.type.cardSubline + 2), { color: colors.foreground.DEFAULT }]}>
          {featured.overview}
        </Text>
      ) : null}
      <FocusGuide
        remember
        trap={END_OF_ROW}
        style={{ flexDirection: 'row', gap: buttonGap, marginTop: s(8) }}>
        {detail?.playWorkId ? (
          <GlassButton
            testID="home-hero-play"
            tone="solid"
            icon={Play}
            {...focusProps}
            label={t(resume ? 'common.resume' : 'common.play')}
            onPress={playFeatured}
          />
        ) : null}
        <GlassButton
          testID="home-hero-info"
          icon={Info}
          {...focusProps}
          label={t('common.moreInfo')}
          onPress={() => router.push(featuredInfoHref(featured, detail))}
        />
      </FocusGuide>
    </View>
  );
}

/** TV remote Play/Pause on Lite Home: starts the focused card's title (or the hero's) once its detail is known. */
export function LitePlayKey({ store, fallback }: { store: FeaturedStore; fallback?: Featured }) {
  const [request, setRequest] = useState<{ featured: Featured; id: number } | null>(null);
  const screenFocused = useRef(false);
  useFocusEffect(
    useCallback(() => {
      screenFocused.current = true;
      return () => {
        screenFocused.current = false;
      };
    }, [])
  );
  useTVEvents((event) => {
    const keyAction = (event as { eventKeyAction?: number }).eventKeyAction;
    if (event.eventType !== 'playPause' || !screenFocused.current || keyAction === 0) return;
    const target = store.playTarget() ?? fallback;
    if (target) setRequest({ featured: target, id: Date.now() });
  });
  return request ? (
    <PlayWhenReady key={request.id} featured={request.featured} onDone={() => setRequest(null)} />
  ) : null;
}

function PlayWhenReady({ featured, onDone }: { featured: Featured; onDone: () => void }) {
  const detail = useFeaturedDetail(featured);
  const play = usePlayFeatured(detail);
  useEffect(() => {
    if (!detail) return;
    play();
    onDone();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail]);
  return null;
}
