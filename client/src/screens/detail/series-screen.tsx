import type { TFunction } from 'i18next';
import { useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { toAppError } from '@/api/errors';
import { EpisodeList } from '@/browse/episode-list';
import {
  useSeasonWithVersions,
  useSeriesDetail,
  useSeriesFocus,
  useVersions,
  useWatchRefreshOnFocus,
  type NextEpisode,
} from '@/browse/queries';
import { seasonName } from '@/browse/season-name';
import {
  ResumeProgress,
  resumeSeconds,
  TitleActions,
  usePlay,
  useWatchedToggle,
} from '@/browse/title-actions';
import { specNote, versionSpec } from '@/browse/version-format';
import { entryIndex } from '@/browse/version-panel';
import { useOpenVersions, VersionPicker } from '@/browse/version-picker';
import { VersionSummary } from '@/browse/version-summary';
import { GlassChip } from '@/components/glass';
import { END_OF_ROW, FocusGuide, FocusSection } from '@/components/focus';
import { ErrorState } from '@/components/states/error-state';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useReturnTarget } from '@/navigation/return-focus';
import { useScreenTitle } from '@/navigation/screen-title';
import { useShell } from '@/shell/use-shell';
import { gutterPadding, useDesign } from '@/theme';

import { DetailError, routeNumber } from './detail-parts';
import { PhoneDetail, watchedAction } from './phone-detail';
import { SeriesStage } from './series-stage';

/** Series: the Bühne on large screens, the phone detail with the season's episode list on phones. */
export function SeriesScreen() {
  const shell = useShell();
  return shell.large ? <SeriesStage /> : <SeriesPhone />;
}

/** Phone: hero with the next-episode call to action, season picker and the season's episodes. */
function SeriesPhone() {
  const { t } = useTranslation();
  const design = useDesign();
  const play = usePlay();
  const params = useLocalSearchParams<{ id: string; season?: string }>();
  const tmdbId = routeNumber(params.id);
  const series = useSeriesDetail(tmdbId);
  const [picked, setPicked] = useState<number | undefined>(routeNumber(params.season));
  const [versionsOpen, setVersionsOpen] = useState(false);
  // TV: Back from the player lands on the version card that started it.
  const reopenVersions = useReturnTarget(setVersionsOpen);
  const openVersions = useOpenVersions();
  useScreenTitle(series.data?.title);
  useWatchRefreshOnFocus();
  const data = series.data;
  const seasons = data?.seasons ?? [];
  const next = useSeriesFocus(data);
  const seasonNumber =
    picked ??
    next?.seasonNumber ??
    seasons.find((season) => season.seasonNumber > 0)?.seasonNumber ??
    seasons[0]?.seasonNumber;
  const season = useSeasonWithVersions(data ? tmdbId : undefined, seasonNumber);

  const title = data?.title ?? '';
  const total = data?.watch.totalEpisodes ?? 0;
  const allPlayed = total > 0 && (data?.watch.playedEpisodes ?? 0) >= total;
  const firstSeason = seasons.find((item) => item.seasonNumber > 0)?.seasonNumber ?? 1;
  // Fully watched: "Watch again" starts the first episode.
  const again =
    !next && allPlayed && tmdbId !== undefined
      ? {
          workId: `tmdb-tv-${tmdbId}-s${String(firstSeason).padStart(2, '0')}e01`,
          seasonNumber: firstSeason,
          episodeNumber: 1,
        }
      : null;
  const playTarget = next ?? again;
  const phoneList = useVersions(playTarget?.workId).data?.versions ?? [];
  const watched = useWatchedToggle({
    ids: data?.workId ? [data.workId] : [],
    played: allPlayed,
    title,
  });

  if (tmdbId === undefined || (series.error && !data))
    return <DetailError error={series.error} onRetry={() => void series.refetch()} />;

  const nextTitle = next
    ? episodeLabel(t, title, next)
    : again
      ? episodeLabel(t, title, again)
      : title;
  const columns = design.formFactor === 'desktop-web' && design.window.width >= 1280 ? 2 : 1;
  const seasonError = season.error && !season.data ? toAppError(season.error) : undefined;
  const nextWatch = next
    ? {
        positionTicks: next.positionTicks,
        durationTicks: next.durationTicks,
        played: false,
        lastReleaseId: next.lastReleaseId,
      }
    : again
      ? { positionTicks: 0, durationTicks: 0, played: true }
      : null;
  const nextPlayLabel = next
    ? t(`detail.next.${nextReason(next)}`, {
        code: t('media.episodeCode', { season: next.seasonNumber, episode: next.episodeNumber }),
      })
    : undefined;

  return (
    <PhoneDetail
      about={{ kind: 'series', tmdbId, title }}
      testID={`series-screen-${tmdbId}`}
      kindLabel={t('detail.series')}
      title={title}
      logoUrl={data?.logoUrl}
      backdropUrl={data?.backdropUrl}
      tint={data?.tint}
      facts={[
        data?.year ? String(data.year) : null,
        data?.seasonCount ? t('media.seasons', { count: data.seasonCount }) : null,
      ].filter((part): part is string => !!part)}
      certification={data?.certification}
      spec={versionSpec(phoneList[entryIndex(phoneList)])}
      specNote={specNote(phoneList, t)}
      overview={data?.overview}
      loading={!data}
      status={
        next ? (
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
            <ResumeProgress testID="series-next-progress" watch={nextWatch} />
            {next.available === false ? (
              <Text testID="series-next-unavailable" variant="caption" tone="warning">
                {t('media.notAvailableYet')}
              </Text>
            ) : null}
          </View>
        ) : total ? (
          <Text testID="series-all-watched" variant="callout" tone="muted">
            {t('detail.allWatched')}
          </Text>
        ) : null
      }
      play={
        data ? (
          <TitleActions
            compact
            tint={data.tint}
            testIDPrefix="series"
            workId={playTarget?.workId ?? null}
            title={nextTitle}
            watch={nextWatch}
            playLabel={nextPlayLabel}
          />
        ) : null
      }
      version={
        playTarget?.workId ? (
          <VersionSummary
            workId={playTarget.workId}
            watch={nextWatch}
            kind="episode"
            onOpen={() =>
              openVersions(
                {
                  workId: playTarget.workId,
                  title: nextTitle,
                  startSeconds: resumeSeconds(nextWatch),
                },
                () => setVersionsOpen(true)
              )
            }
          />
        ) : null
      }
      actions={
        data?.workId
          ? [
              {
                testID: 'series-mark',
                ...watchedAction(allPlayed, t),
                disabled: watched.pending,
                onPress: watched.toggle,
              },
            ]
          : []
      }>
      <FocusSection testID="series-seasons">
        <View
          style={{
            gap: design.space.md,
            ...gutterPadding(design),
            paddingTop: design.space.xl,
          }}>
          <Text variant="heading">{t('detail.seasons')}</Text>
          <FocusGuide
            remember
            trap={END_OF_ROW}
            style={{ flexDirection: 'row', flexWrap: 'wrap', gap: design.space.sm }}>
            {data
              ? seasons.map((item) => (
                  <GlassChip
                    key={item.seasonNumber}
                    tint={data.tint}
                    testID={`season-${item.seasonNumber}`}
                    label={t('detail.seasonTag', {
                      title: seasonName(t, item.title, item.seasonNumber),
                      played: item.playedCount ?? 0,
                      total: item.episodeCount ?? 0,
                    })}
                    selected={item.seasonNumber === seasonNumber}
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
          <View
            style={{
              ...gutterPadding(design),
              paddingTop: design.space.lg,
              gap: design.space.sm,
            }}>
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
        workId={playTarget?.workId}
        title={nextTitle}
        onPlay={(version) => {
          setVersionsOpen(false);
          reopenVersions(true);
          if (playTarget?.workId)
            play({
              workId: playTarget.workId,
              title: nextTitle,
              releaseId: version.releaseId,
              startSeconds: resumeSeconds(nextWatch),
            });
        }}
      />
    </PhoneDetail>
  );
}

function nextReason(next: NextEpisode): 'start' | 'resume' | 'next' {
  return next.reason === 'resume' || next.reason === 'next' ? next.reason : 'start';
}

function episodeLabel(
  t: TFunction,
  series: string,
  next: Pick<NextEpisode, 'seasonNumber' | 'episodeNumber'> & { title?: string | null }
) {
  return t('detail.episodeTitle', {
    series,
    code: t('media.episodeCode', { season: next.seasonNumber, episode: next.episodeNumber }),
    title: next.title ?? t('media.episodeNumber', { episode: next.episodeNumber }),
  });
}
