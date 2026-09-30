import type { TFunction } from 'i18next';
import { useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { toAppError } from '@/api/errors';
import { EpisodeList } from '@/browse/episode-list';
import { useSeasonDetail, useSeriesDetail, type NextEpisode } from '@/browse/queries';
import { ResumeProgress, resumeSeconds, TitleActions, usePlay } from '@/browse/title-actions';
import { VersionPicker } from '@/browse/version-picker';
import { END_OF_ROW, FocusGuide, FocusSection } from '@/components/focus';
import { Hero } from '@/components/media/hero';
import { ErrorState } from '@/components/states/error-state';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Tag } from '@/components/ui/tag';
import { Text } from '@/components/ui/text';
import { useDesign } from '@/theme';

import { DetailError, DetailScroll, HeroSkeleton, routeNumber } from './detail-parts';

/** Series: hero with the next-episode call to action, season picker and the season's episodes. */
export function SeriesScreen() {
  const { t } = useTranslation();
  const design = useDesign();
  const play = usePlay();
  const params = useLocalSearchParams<{ id: string; season?: string }>();
  const tmdbId = routeNumber(params.id);
  const series = useSeriesDetail(tmdbId);
  const [picked, setPicked] = useState<number | undefined>(routeNumber(params.season));
  const [versionsOpen, setVersionsOpen] = useState(false);
  const data = series.data;
  const seasons = data?.seasons ?? [];
  const next = data?.watch.nextEpisode ?? null;
  const seasonNumber =
    picked ??
    next?.seasonNumber ??
    seasons.find((season) => season.seasonNumber > 0)?.seasonNumber ??
    seasons[0]?.seasonNumber;
  const season = useSeasonDetail(data ? tmdbId : undefined, seasonNumber);

  if (tmdbId === undefined || (series.error && !data))
    return <DetailError error={series.error} onRetry={() => void series.refetch()} />;

  const title = data?.title ?? '';
  const total = data?.watch.totalEpisodes ?? 0;
  const allPlayed = total > 0 && (data?.watch.playedEpisodes ?? 0) >= total;
  const nextTitle = next ? episodeLabel(t, title, next) : title;
  const columns = design.formFactor === 'desktop-web' && design.window.width >= 1280 ? 2 : 1;
  const seasonError = season.error && !season.data ? toAppError(season.error) : undefined;

  return (
    <DetailScroll testID={`series-screen-${tmdbId}`}>
      {data ? (
        <Hero
          eyebrow={t('detail.series')}
          title={title}
          backdropUri={data.backdropUrl}
          logoUri={data.logoUrl}
          meta={[
            data.year ? String(data.year) : null,
            data.seasonCount ? t('media.seasons', { count: data.seasonCount }) : null,
            data.genres?.slice(0, 3).join(', ') || null,
          ].filter((part): part is string => !!part)}
          badges={
            <>
              {data.certification ? (
                <Badge testID="series-certification" label={data.certification} variant="outline" />
              ) : null}
              {total ? (
                <Badge
                  testID="series-watched-count"
                  label={t('detail.watchedCount', {
                    played: data.watch.playedEpisodes ?? 0,
                    total,
                  })}
                  variant={allPlayed ? 'accent' : 'neutral'}
                />
              ) : null}
            </>
          }
          overview={data.overview ?? undefined}
          actions={
            <TitleActions
              testIDPrefix="series"
              workId={next?.workId ?? null}
              title={nextTitle}
              watch={
                next
                  ? {
                      positionTicks: next.positionTicks,
                      durationTicks: next.durationTicks,
                      played: false,
                    }
                  : null
              }
              playLabel={
                next
                  ? t(`detail.next.${nextReason(next)}`, {
                      code: t('media.episodeCode', {
                        season: next.seasonNumber,
                        episode: next.episodeNumber,
                      }),
                    })
                  : undefined
              }
              onVersions={next?.workId ? () => setVersionsOpen(true) : undefined}
              markWorkIds={data.workId ? [data.workId] : undefined}
              markPlayed={allPlayed}
            />
          }>
          {next ? (
            <View testID="series-next" style={{ gap: design.space.xs }}>
              <Text variant="callout" tone="default" numberOfLines={1}>
                {t('detail.upNextLine', {
                  code: t('media.episodeCode', {
                    season: next.seasonNumber,
                    episode: next.episodeNumber,
                  }),
                  title: next.title ?? '',
                })}
              </Text>
              <ResumeProgress
                testID="series-next-progress"
                watch={{
                  positionTicks: next.positionTicks,
                  durationTicks: next.durationTicks,
                  played: false,
                }}
              />
            </View>
          ) : total ? (
            <Text testID="series-all-watched" variant="callout" tone="muted">
              {t('detail.allWatched')}
            </Text>
          ) : null}
        </Hero>
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
              ? seasons.map((item) => (
                  <Tag
                    key={item.seasonNumber}
                    testID={`season-${item.seasonNumber}`}
                    label={t('detail.seasonTag', {
                      title: item.title ?? t('media.season', { season: item.seasonNumber }),
                      played: item.playedCount ?? 0,
                      total: item.episodeCount ?? 0,
                    })}
                    selected={item.seasonNumber === seasonNumber}
                    aria-selected={item.seasonNumber === seasonNumber}
                    onPress={() => setPicked(item.seasonNumber)}
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
      {data && seasonNumber !== undefined ? (
        <FocusSection testID={`series-episodes-${seasonNumber}`}>
          <View style={{ paddingHorizontal: design.layout.gutter, gap: design.space.sm }}>
            {seasonError ? (
              <ErrorState
                testID="season-error"
                code={seasonError.code}
                params={seasonError.params}
                actions={['retry']}
                onAction={() => void season.refetch()}
              />
            ) : (
              <EpisodeList
                episodes={
                  season.data?.seasonNumber === seasonNumber
                    ? (season.data.episodes ?? [])
                    : undefined
                }
                seriesTitle={title}
                seasonNumber={seasonNumber}
                focusWorkId={next?.workId}
                columns={columns}
              />
            )}
          </View>
        </FocusSection>
      ) : null}
      <VersionPicker
        open={versionsOpen}
        onClose={() => setVersionsOpen(false)}
        workId={next?.workId}
        title={nextTitle}
        onPlay={(version) => {
          setVersionsOpen(false);
          if (next?.workId)
            play({
              workId: next.workId,
              title: nextTitle,
              releaseId: version.releaseId,
              startSeconds: resumeSeconds({
                positionTicks: next.positionTicks,
                durationTicks: next.durationTicks,
                played: false,
              }),
            });
        }}
      />
    </DetailScroll>
  );
}

function nextReason(next: NextEpisode): 'start' | 'resume' | 'next' {
  return next.reason === 'resume' || next.reason === 'next' ? next.reason : 'start';
}

function episodeLabel(t: TFunction, series: string, next: NextEpisode) {
  return t('detail.episodeTitle', {
    series,
    code: t('media.episodeCode', { season: next.seasonNumber, episode: next.episodeNumber }),
    title: next.title ?? t('media.episodeNumber', { episode: next.episodeNumber }),
  });
}
