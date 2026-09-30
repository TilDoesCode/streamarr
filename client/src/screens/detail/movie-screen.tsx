import { useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useMovieDetail } from '@/browse/queries';
import { ResumeProgress, resumeSeconds, TitleActions, usePlay } from '@/browse/title-actions';
import { VersionPicker } from '@/browse/version-picker';
import { VersionSummary } from '@/browse/version-summary';
import { Hero } from '@/components/media/hero';
import { Badge } from '@/components/ui/badge';
import { useFormat } from '@/i18n/format';

import { DetailError, DetailScroll, HeroSkeleton, routeNumber } from './detail-parts';

/** Movie: hero with logo, play/resume, versions and the watched toggle. */
export function MovieScreen() {
  const { t } = useTranslation();
  const format = useFormat();
  const play = usePlay();
  const params = useLocalSearchParams<{ id: string }>();
  const tmdbId = routeNumber(params.id);
  const movie = useMovieDetail(tmdbId);
  const [versionsOpen, setVersionsOpen] = useState(false);

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
          logoUri={data.logoUrl}
          meta={[
            data.year ? String(data.year) : null,
            data.runtimeMinutes ? format.duration(data.runtimeMinutes * 60) : null,
            data.genres?.slice(0, 3).join(', ') || null,
          ].filter((part): part is string => !!part)}
          badges={
            <>
              {data.certification ? (
                <Badge testID="movie-certification" label={data.certification} variant="outline" />
              ) : null}
              {data.watch.played ? <Badge label={t('media.played')} variant="accent" /> : null}
            </>
          }
          overview={data.overview ?? undefined}
          actions={
            <TitleActions
              testIDPrefix="movie"
              workId={data.workId}
              title={title}
              watch={data.watch}
              onVersions={() => setVersionsOpen(true)}
            />
          }>
          <ResumeProgress testID="movie-progress" watch={data.watch} />
        </Hero>
      ) : (
        <HeroSkeleton />
      )}
      {data ? (
        <VersionSummary
          workId={data.workId}
          currentReleaseId={data.watch.lastReleaseId}
          onOpen={() => setVersionsOpen(true)}
        />
      ) : null}
      <VersionPicker
        open={versionsOpen}
        onClose={() => setVersionsOpen(false)}
        workId={data?.workId}
        title={title}
        currentReleaseId={data?.watch.lastReleaseId}
        onPlay={(version) => {
          setVersionsOpen(false);
          if (data?.workId)
            play({
              workId: data.workId,
              title,
              releaseId: version.releaseId,
              startSeconds: resumeSeconds(data.watch),
            });
        }}
      />
    </DetailScroll>
  );
}
