import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import type { ReactNode } from 'react';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useActiveAccount } from '@/accounts/accounts-provider';
import { unwrap } from '@/api/client';
import { toAppError } from '@/api/errors';
import { FocusSection } from '@/components/focus';
import { ErrorState } from '@/components/states/error-state';
import { LoaderMotionContext } from '@/components/ui/loader-motion';
import { LandscapeCardSkeleton, Skeleton, SkeletonText } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { accountKey } from '@/query/keys';
import { colors, useDesign } from '@/theme';

/** A positive TMDB id / season number from a route param, else undefined. */
export function routeNumber(value: string | string[] | undefined): number | undefined {
  const number = Number(Array.isArray(value) ? value[0] : value);
  return Number.isInteger(number) && number >= 0 ? number : undefined;
}

export function useMovieDetail(tmdbId: number | undefined) {
  const { account, client } = useActiveAccount();
  return useQuery({
    queryKey: accountKey(account.id, 'catalog', 'movie', tmdbId),
    queryFn: ({ signal }) =>
      unwrap(
        client.GET('/api/v1/viewer/catalog/movies/{tmdbId}', {
          params: { path: { tmdbId: tmdbId ?? 0 } },
          signal,
        })
      ),
    enabled: tmdbId !== undefined,
  });
}

export function useSeriesDetail(tmdbId: number | undefined) {
  const { account, client } = useActiveAccount();
  return useQuery({
    queryKey: accountKey(account.id, 'catalog', 'series', tmdbId),
    queryFn: ({ signal }) =>
      unwrap(
        client.GET('/api/v1/viewer/catalog/series/{tmdbId}', {
          params: { path: { tmdbId: tmdbId ?? 0 } },
          signal,
        })
      ),
    enabled: tmdbId !== undefined,
  });
}

export function useSeasonDetail(tmdbId: number | undefined, season: number | undefined) {
  const { account, client } = useActiveAccount();
  return useQuery({
    queryKey: accountKey(account.id, 'catalog', 'series', tmdbId, 'season', season),
    queryFn: ({ signal }) =>
      unwrap(
        client.GET('/api/v1/viewer/catalog/series/{tmdbId}/seasons/{seasonNumber}', {
          params: { path: { tmdbId: tmdbId ?? 0, seasonNumber: season ?? 0 } },
          signal,
        })
      ),
    enabled: tmdbId !== undefined && season !== undefined,
  });
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

/** Section whose content arrives with the browse screens (M4.1): heading plus a still skeleton row. */
export function SkeletonSection({ title, testID }: { title: string; testID?: string }) {
  const design = useDesign();
  return (
    <FocusSection testID={testID}>
      <View style={{ gap: design.space.md }}>
        <Text variant="heading" style={{ paddingHorizontal: design.layout.gutter }}>
          {title}
        </Text>
        <View
          style={{
            flexDirection: 'row',
            gap: design.layout.cardGap,
            paddingHorizontal: design.layout.gutter,
            overflow: 'hidden',
          }}>
          <LoaderMotionContext value={false}>
            {[0, 1, 2, 3].map((index) => (
              <LandscapeCardSkeleton key={index} />
            ))}
          </LoaderMotionContext>
        </View>
      </View>
    </FocusSection>
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
