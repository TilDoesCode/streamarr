import { useLocalSearchParams, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { END_OF_ROW, FocusGuide, FocusSection } from '@/components/focus';
import { Hero } from '@/components/media/hero';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Tag } from '@/components/ui/tag';
import { Text } from '@/components/ui/text';
import { useDesign } from '@/theme';

import {
  DetailError,
  DetailScroll,
  HeroSkeleton,
  routeNumber,
  SkeletonSection,
  useSeriesDetail,
} from './detail-parts';

/** Series placeholder: live header and seasons; episodes open per season. */
export function SeriesScreen() {
  const { t } = useTranslation();
  const design = useDesign();
  const router = useRouter();
  const params = useLocalSearchParams<{ id: string }>();
  const tmdbId = routeNumber(params.id);
  const series = useSeriesDetail(tmdbId);

  if (tmdbId === undefined || (series.error && !series.data))
    return <DetailError error={series.error} onRetry={() => void series.refetch()} />;

  const data = series.data;
  const seasons = data?.seasons ?? [];
  return (
    <DetailScroll testID={`series-screen-${tmdbId}`}>
      {data ? (
        <Hero
          eyebrow={t('detail.series')}
          title={data.title ?? ''}
          backdropUri={data.backdropUrl}
          meta={[
            data.year ? String(data.year) : null,
            data.seasonCount ? t('media.seasons', { count: data.seasonCount }) : null,
            data.genres?.slice(0, 2).join(', ') || null,
          ].filter((part): part is string => !!part)}
          badges={data.certification ? <Badge label={data.certification} /> : undefined}
          overview={data.overview ?? undefined}
        />
      ) : (
        <HeroSkeleton />
      )}
      <FocusSection testID="series-seasons">
        <View style={{ gap: design.space.md, paddingHorizontal: design.layout.gutter }}>
          <Text variant="heading">{t('detail.seasons')}</Text>
          <FocusGuide
            remember
            trap={END_OF_ROW}
            style={{ flexDirection: 'row', flexWrap: 'wrap', gap: design.space.sm }}>
            {data
              ? seasons.map((season, index) => (
                  <Tag
                    key={season.seasonNumber}
                    testID={`season-${season.seasonNumber}`}
                    label={season.title ?? t('media.season', { season: season.seasonNumber })}
                    hasTVPreferredFocus={index === 0}
                    onPress={() =>
                      router.push({
                        pathname: '/series/[id]/season/[n]',
                        params: { id: String(tmdbId), n: String(season.seasonNumber) },
                      })
                    }
                  />
                ))
              : [0, 1, 2].map((index) => (
                  <Skeleton
                    key={index}
                    width={design.px(96)}
                    height={design.layout.controlHeight.sm}
                    radius={design.radius.full}
                  />
                ))}
          </FocusGuide>
        </View>
      </FocusSection>
      <SkeletonSection title={t('detail.moreLikeThis')} testID="series-more" />
    </DetailScroll>
  );
}
