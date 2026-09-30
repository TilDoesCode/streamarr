import { useLocalSearchParams, useRouter } from 'expo-router';
import { Play } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';

import { Hero } from '@/components/media/hero';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useFormat } from '@/i18n/format';
import { playHref } from '@/navigation/routes';

import {
  DetailError,
  DetailScroll,
  HeroSkeleton,
  routeNumber,
  SkeletonSection,
  useMovieDetail,
} from './detail-parts';

/** Movie placeholder: live header; versions and more arrive with M4.1. */
export function MovieScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  const format = useFormat();
  const params = useLocalSearchParams<{ id: string }>();
  const tmdbId = routeNumber(params.id);
  const movie = useMovieDetail(tmdbId);

  if (tmdbId === undefined || (movie.error && !movie.data))
    return <DetailError error={movie.error} onRetry={() => void movie.refetch()} />;

  const data = movie.data;
  const title = data?.title ?? '';
  return (
    <DetailScroll testID={`movie-screen-${tmdbId}`}>
      {data ? (
        <Hero
          eyebrow={t('detail.movie')}
          title={title}
          backdropUri={data.backdropUrl}
          meta={[
            data.year ? String(data.year) : null,
            data.runtimeMinutes ? format.duration(data.runtimeMinutes * 60) : null,
            data.genres?.slice(0, 2).join(', ') || null,
          ].filter((part): part is string => !!part)}
          badges={data.certification ? <Badge label={data.certification} /> : undefined}
          overview={data.overview ?? undefined}
          actions={
            <Button
              testID="movie-play"
              icon={Play}
              label={t('common.play')}
              hasTVPreferredFocus
              onPress={() => router.push(playHref('preview', { workId: data.workId, title }))}
            />
          }
        />
      ) : (
        <HeroSkeleton />
      )}
      <SkeletonSection title={t('common.versions')} testID="movie-versions" />
    </DetailScroll>
  );
}
