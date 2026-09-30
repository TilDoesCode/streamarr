import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { Tv } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { Platform, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { FocusSection } from '@/components/focus';
import { EpisodeRow } from '@/components/media/episode-row';
import { EmptyState } from '@/components/states/empty-state';
import { Skeleton, SkeletonText } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { playHref } from '@/navigation/routes';
import { aspect, useDesign } from '@/theme';

import { DetailError, DetailScroll, routeNumber, useSeasonDetail } from './detail-parts';

/** Season placeholder: the live episode list; episodes open the player placeholder. */
export function SeasonScreen() {
  const { t } = useTranslation();
  const design = useDesign();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ id: string; n: string }>();
  const tmdbId = routeNumber(params.id);
  const seasonNumber = routeNumber(params.n);
  const season = useSeasonDetail(tmdbId, seasonNumber);

  if (tmdbId === undefined || seasonNumber === undefined || (season.error && !season.data))
    return <DetailError error={season.error} onRetry={() => void season.refetch()} />;

  const data = season.data;
  const seasonTitle = data?.title ?? t('media.season', { season: seasonNumber });
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
        <View style={{ paddingHorizontal: design.layout.gutter, gap: design.space.sm }}>
          {data ? (
            episodes.length ? (
              episodes.map((episode, index) => (
                <EpisodeRow
                  key={episode.episodeNumber}
                  testID={`episode-${episode.episodeNumber}`}
                  episodeNumber={episode.episodeNumber}
                  title={
                    episode.title ?? t('media.episodeNumber', { episode: episode.episodeNumber })
                  }
                  overview={episode.overview ?? undefined}
                  stillUri={episode.stillUrl}
                  runtimeMinutes={episode.runtimeMinutes ?? undefined}
                  airDate={episode.airDate ?? undefined}
                  played={episode.watch.played}
                  progress={(episode.watch.progressPercent ?? 0) / 100 || undefined}
                  hasTVPreferredFocus={index === 0}
                  onPress={() =>
                    router.push(
                      playHref('preview', {
                        workId: episode.workId,
                        title: episode.title ?? seasonTitle,
                      })
                    )
                  }
                />
              ))
            ) : (
              <EmptyState
                icon={Tv}
                title={t('states.empty.title')}
                message={t('states.empty.message')}
              />
            )
          ) : (
            [0, 1, 2].map((index) => <EpisodeRowSkeleton key={index} />)
          )}
        </View>
      </FocusSection>
    </DetailScroll>
  );
}

function EpisodeRowSkeleton() {
  const design = useDesign();
  const thumb = design.layout.episodeThumbWidth;
  return (
    <View style={{ flexDirection: 'row', gap: design.space.lg, padding: design.space.sm }}>
      <Skeleton width={thumb} aspectRatio={aspect.landscape} />
      <View style={{ flex: 1, gap: design.space.xs, justifyContent: 'center' }}>
        <SkeletonText width="50%" variant="heading" />
        <SkeletonText width="30%" variant="caption" />
        <SkeletonText width="90%" />
      </View>
    </View>
  );
}
