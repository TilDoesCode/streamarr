import { Stack } from 'expo-router';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AmbientBackdrop, AmbientProvider } from '@/components/ambient';
import { useBackHandler } from '@/components/focus';
import { LoaderMotionContext } from '@/components/ui/loader-motion';
import { Text } from '@/components/ui/text';
import { useDesign } from '@/theme';

import { GalleryAurora } from './gallery-aurora';
import {
  GalleryBadges,
  GalleryButtons,
  GalleryIconButtons,
  GalleryLoading,
  GalleryProgress,
} from './gallery-controls';
import { GalleryOverlays, GalleryStates } from './gallery-feedback';
import { GalleryEpisodes, GalleryHero, GalleryShelves } from './gallery-media';
import {
  GalleryColors,
  GalleryFormatting,
  GalleryLanguage,
  GalleryTypography,
} from './gallery-reference';

/** Renders every design-system component and state (dev route /dev/gallery). */
export function GalleryScreen() {
  const { t } = useTranslation();
  const design = useDesign();
  const insets = useSafeAreaInsets();
  const scrollRef = useRef<ScrollView>(null);
  const playRef = useRef<View>(null);
  const heroFocused = useRef(false);
  const [lastAction, setLastAction] = useState<string | null>(null);
  // Infinite loader animations keep Android's UI automation from ever seeing an idle screen.
  const [loadersAnimated, setLoadersAnimated] = useState(!design.isTV);

  // TV back: first return to the top (focus Play), then leave the screen.
  useBackHandler(() => {
    if (!design.isTV || heroFocused.current) return false;
    scrollRef.current?.scrollTo({ y: 0, animated: true });
    playRef.current?.requestTVFocus();
    return true;
  });

  return (
    <LoaderMotionContext value={loadersAnimated}>
      <AmbientProvider>
        <View style={{ flex: 1 }}>
          <AmbientBackdrop testID="gallery-ambient" />
          <Stack.Screen options={{ title: t('gallery.title') }} />
          <ScrollView
            ref={scrollRef}
            testID="gallery-scroll"
            contentContainerStyle={{
              paddingTop: design.isTV ? 0 : insets.top,
              paddingBottom:
                Math.max(insets.bottom, design.layout.edgeVertical) + design.space['3xl'],
              gap: design.layout.sectionGap,
            }}
            snapToAlignment={design.isTV ? 'item' : undefined}
            snapToItemPadding={design.isTV ? design.layout.edgeVertical : undefined}
            // TV: a relayout above the viewport (e.g. a language switch) must not push focus into the overscan band.
            maintainVisibleContentPosition={design.isTV ? { minIndexForVisible: 0 } : undefined}>
            <View collapsable={false} scrollSnapAlign={design.isTV ? 'start' : undefined}>
              <View
                style={{
                  paddingHorizontal: design.layout.gutter,
                  paddingTop: design.layout.edgeVertical,
                  gap: design.space.xs,
                }}>
                <Text variant="title">{t('gallery.title')}</Text>
                <Text testID="gallery-subtitle" variant="caption" tone="subtle">
                  {t('gallery.subtitle', {
                    formFactor: t(`formFactor.${design.formFactor}`),
                    scale: design.scale,
                    width: Math.round(design.window.width),
                    height: Math.round(design.window.height),
                  })}
                </Text>
                <Text testID="gallery-last-action" variant="caption" tone="subtle">
                  {t('gallery.lastAction', { action: lastAction ?? t('gallery.none') })}
                </Text>
              </View>
              <GalleryHero
                playRef={playRef}
                onAction={setLastAction}
                onActionsFocusEnter={() => {
                  heroFocused.current = true;
                }}
                onActionsFocusLeave={() => {
                  heroFocused.current = false;
                }}
              />
            </View>
            <GalleryAurora onAction={setLastAction} />
            <GalleryShelves onAction={setLastAction} />
            <GalleryButtons onAction={setLastAction} />
            <GalleryIconButtons onAction={setLastAction} />
            <GalleryBadges />
            <GalleryEpisodes onAction={setLastAction} />
            <GalleryOverlays onAction={setLastAction} />
            <GalleryStates onAction={setLastAction} />
            <GalleryProgress />
            <GalleryLoading
              animated={loadersAnimated}
              onToggleAnimated={() => setLoadersAnimated((value) => !value)}
            />
            <GalleryLanguage />
            <GalleryFormatting />
            <GalleryColors />
            <GalleryTypography />
          </ScrollView>
        </View>
      </AmbientProvider>
    </LoaderMotionContext>
  );
}
