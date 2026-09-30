import { Stack, useLocalSearchParams } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Platform, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { EpisodeList } from '@/browse/episode-list';
import { useSeasonDetail, useWatchRefreshOnFocus } from '@/browse/queries';
import { seasonName } from '@/browse/season-name';
import { FocusSection } from '@/components/focus';
import { SkeletonText } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useScreenTitle } from '@/navigation/screen-title';
import { useDesign } from '@/theme';

import { DetailError, DetailScroll, routeNumber } from './detail-parts';

/** One season as its own page (deep links): the episode list with played state and progress. */
export function SeasonScreen() {
  const { t } = useTranslation();
  const design = useDesign();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ id: string; n: string }>();
  const tmdbId = routeNumber(params.id);
  const seasonNumber = routeNumber(params.n);
  const season = useSeasonDetail(tmdbId, seasonNumber);
  useWatchRefreshOnFocus();
  useScreenTitle(
    season.data
      ? `${season.data.seriesTitle ?? ''} · ${seasonName(t, season.data.title, seasonNumber ?? 0)}`
      : undefined
  );

  if (tmdbId === undefined || seasonNumber === undefined || (season.error && !season.data))
    return <DetailError error={season.error} onRetry={() => void season.refetch()} />;

  const data = season.data;
  const seasonTitle = seasonName(t, data?.title, seasonNumber);
  const episodes = data?.episodes ?? [];
  // Handhelds show the title in the native header; TV and web show it on the page.
  const pageHeading = design.isTV || Platform.OS === 'web';
  return (
    <DetailScroll testID={`season-screen-${tmdbId}-${seasonNumber}`}>
      <Stack.Screen options={{ title: seasonTitle }} />
      <View
        style={{
          paddingTop: pageHeading ? design.layout.edgeVertical + insets.top : design.space.lg,
          paddingHorizontal: design.layout.gutter,
          gap: design.space.xs,
        }}>
        {data ? (
          <>
            <Text variant="overline" tone="accent">
              {data.seriesTitle ?? ''}
            </Text>
            {pageHeading ? <Text variant="title">{seasonTitle}</Text> : null}
            <Text variant="callout" tone="muted">
              {t('media.episodes', { count: episodes.length })}
            </Text>
          </>
        ) : (
          <>
            <SkeletonText width="25%" variant="caption" />
            <SkeletonText width="45%" variant="heading" />
          </>
        )}
      </View>
      <FocusSection>
        <View style={{ paddingHorizontal: design.layout.gutter }}>
          <EpisodeList
            episodes={data ? episodes : undefined}
            seriesTitle={data?.seriesTitle ?? ''}
            seasonNumber={seasonNumber}
            takeFocus
            columns={design.formFactor === 'desktop-web' && design.window.width >= 1280 ? 2 : 1}
          />
        </View>
      </FocusSection>
    </DetailScroll>
  );
}
