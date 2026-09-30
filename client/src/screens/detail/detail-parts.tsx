import { useRouter } from 'expo-router';
import type { ReactNode } from 'react';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { toAppError } from '@/api/errors';
import { ErrorState } from '@/components/states/error-state';
import { Skeleton, SkeletonText } from '@/components/ui/skeleton';
import { colors, useDesign } from '@/theme';

/** A positive TMDB id / season number from a route param, else undefined. */
export function routeNumber(value: string | string[] | undefined): number | undefined {
  const number = Number(Array.isArray(value) ? value[0] : value);
  return Number.isInteger(number) && number >= 0 ? number : undefined;
}

/** Scrolling page of a title screen (TV: item snapping like the other pages). */
export function DetailScroll({ children, testID }: { children: ReactNode; testID?: string }) {
  const design = useDesign();
  const insets = useSafeAreaInsets();
  return (
    <ScrollView
      testID={testID}
      style={{ flex: 1, backgroundColor: colors.background }}
      contentContainerStyle={{
        paddingBottom: Math.max(insets.bottom, design.layout.edgeVertical) + design.space['3xl'],
        gap: design.layout.sectionGap,
      }}
      snapToAlignment={design.isTV ? 'item' : undefined}
      snapToItemPadding={design.isTV ? design.layout.edgeVertical : undefined}>
      {children}
    </ScrollView>
  );
}

/** Hero-shaped placeholder while the title loads. */
export function HeroSkeleton() {
  const design = useDesign();
  const { gutter, heroHeight, controlHeight } = design.layout;
  const wide = design.formFactor !== 'phone';
  return (
    <View
      testID="hero-skeleton"
      aria-busy
      collapsable={false}
      scrollSnapAlign={design.isTV ? 'start' : undefined}
      style={{ height: heroHeight, justifyContent: 'flex-end' }}>
      <Skeleton
        radius={0}
        height={heroHeight}
        style={{ position: 'absolute', left: 0, right: 0, top: 0 }}
      />
      <View
        style={{
          paddingHorizontal: gutter,
          paddingBottom: design.space['2xl'],
          maxWidth: wide ? design.px(560) + gutter : undefined,
          gap: design.space.sm,
        }}>
        <SkeletonText width="30%" variant="caption" />
        <Skeleton width="80%" height={design.type.display.fontSize} radius={design.radius.sm} />
        <SkeletonText width="45%" />
        <SkeletonText width="95%" />
        <SkeletonText width="70%" />
        <View style={{ flexDirection: 'row', gap: design.space.md, marginTop: design.space.sm }}>
          <Skeleton width={design.px(120)} height={controlHeight.md} />
          <Skeleton width={design.px(120)} height={controlHeight.md} />
        </View>
      </View>
    </View>
  );
}

/** Full-screen error of a title screen: retry (transient failures), or go back. */
export function DetailError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const router = useRouter();
  const appError = error ? toAppError(error) : undefined;
  return (
    <View style={{ flex: 1, justifyContent: 'center', backgroundColor: colors.background }}>
      <ErrorState
        testID="detail-error"
        code={appError?.code ?? 'not_found'}
        params={appError?.params}
        actions={appError?.isTransient ? ['retry', 'back'] : ['back']}
        autoFocus
        onAction={(action) => {
          if (action === 'retry') onRetry();
          else if (router.canGoBack()) router.back();
          else router.replace('/');
        }}
      />
    </View>
  );
}
