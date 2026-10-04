import { useFocusEffect, useLocalSearchParams } from 'expo-router';
import { CalendarClock } from 'lucide-react-native';
import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, View } from 'react-native';

import { toAppError } from '@/api/errors';
import { EpisodeStrip } from '@/browse/episode-strip';
import {
  useSeasonWithVersions,
  useSeriesDetail,
  useSeriesFocus,
  useWatchRefreshOnFocus,
  type Episode,
  type SeriesDetail,
} from '@/browse/queries';
import { SeasonChips } from '@/browse/season-chips';
import { seasonName } from '@/browse/season-name';
import {
  initialSelection,
  orderedSeasons,
  selectedEpisode,
  useDebounced,
  type Selection,
} from '@/browse/series-selection';
import {
  ResumeProgress,
  resumeSeconds,
  TitleActions,
  usePlay,
  usePlayTarget,
  usePlayWork,
} from '@/browse/title-actions';
import { VersionChips } from '@/browse/version-chips';
import { useVersionSheet } from '@/browse/version-sheet';
import { useBackHandler } from '@/components/focus';
import { GlassButton } from '@/components/glass';
import { ErrorState } from '@/components/states/error-state';
import { ProgressBar } from '@/components/ui/progress-bar';
import { Text } from '@/components/ui/text';
import { useFormat } from '@/i18n/format';
import { META_SEPARATOR } from '@/lib/media-labels';
import { useScreenTitle } from '@/navigation/screen-title';
import { MIN_TEXT } from '@/shell/shell-metrics';
import { useShell } from '@/shell/use-shell';
import { colors, fonts } from '@/theme';

import { seriesFacts, useAboutSheet } from './about-sheet';
import { DetailError, routeNumber } from './detail-parts';
import { LargeDetail, StageInfo, useStageGutters } from './large-detail';
import { SERIES_INFO_MAX_CUT, seriesInfoPlan } from './stage-info-fit';

type Shown = { season: number; episode: Episode };

/** Series Bühne (D2): stage, seasons and strip; selecting an episode or season never navigates (D2b). */
export function SeriesStage() {
  const { t } = useTranslation();
  const format = useFormat();
  const shell = useShell();
  const play = usePlay();
  const playWork = usePlayWork();
  const sheet = useVersionSheet();
  // Android TV Back: strip or season chips -> the main button (strip back at the marked episode) -> leave.
  const mainButton = useRef<View & { requestTVFocus?: () => void }>(null);
  const inLower = useRef({ chips: false, strip: false });
  const [backSteps, setBackSteps] = useState(0);
  const screenFocused = useRef(false);
  useFocusEffect(
    useCallback(() => {
      screenFocused.current = true;
      return () => void (screenFocused.current = false);
    }, [])
  );
  useBackHandler(
    () => {
      if (!screenFocused.current) return false;
      if (!inLower.current.chips && !inLower.current.strip) return false;
      inLower.current = { chips: false, strip: false };
      setBackSteps((count) => count + 1);
      requestAnimationFrame(() => mainButton.current?.requestTVFocus?.());
      return true;
    },
    Platform.OS === 'android' && Platform.isTV
  );
  const gutters = useStageGutters();
  const params = useLocalSearchParams<{
    id: string;
    season?: string;
    n?: string;
    episode?: string;
  }>();
  const tmdbId = routeNumber(params.id);
  const series = useSeriesDetail(tmdbId);
  const about = useAboutSheet(
    tmdbId !== undefined ? { kind: 'series', tmdbId, title: series.data?.title ?? '' } : null
  );
  const data = series.data;
  const [picked, setPicked] = useState<Selection | null>(null);
  const { focus: next, settled } = useSeriesFocus(data);
  const deepLink = {
    season: routeNumber(params.season ?? params.n),
    episode: routeNumber(params.episode),
  };
  const selection =
    picked ??
    (data && (settled || deepLink.season !== undefined)
      ? initialSelection(data, deepLink, next)
      : undefined);
  const season = useSeasonWithVersions(data ? tmdbId : undefined, selection?.season);
  const episodes =
    selection && season.data?.seasonNumber === selection.season
      ? (season.data.episodes ?? [])
      : undefined;
  const resolved =
    episodes && selection ? selectedEpisode(episodes, selection, next?.workId) : undefined;
  // While another season loads the stage keeps the last episode: nothing jumps, focus stays put.
  const [last, setLast] = useState<Shown>();
  if (resolved && selection && (resolved !== last?.episode || selection.season !== last.season))
    setLast({ season: selection.season, episode: resolved });
  const shown = resolved && selection ? { season: selection.season, episode: resolved } : last;
  const episode = shown?.episode;
  const target = usePlayTarget(episode?.workId, episode?.watch);
  const preview = useDebounced();
  const pick = (next: Selection) =>
    setPicked((now) => (now?.season === next.season && now.episode === next.episode ? now : next));
  useScreenTitle(data?.title);
  useWatchRefreshOnFocus();

  if (tmdbId === undefined || (series.error && !data))
    return <DetailError error={series.error} onRetry={() => void series.refetch()} />;

  const title = data?.title ?? '';
  const episodeTitle = (item: Episode, seasonNumber: number) =>
    t('detail.episodeTitle', {
      series: title,
      code: t('media.episodeCode', { season: seasonNumber, episode: item.episodeNumber }),
      title: item.title ?? t('media.episodeNumber', { episode: item.episodeNumber }),
    });
  const playable = (item: Episode) =>
    !!item.workId && item.aired !== false && item.versionCount !== 0;
  const select = (item: Episode) => {
    preview.cancel();
    if (selection) setPicked({ season: selection.season, episode: item.episodeNumber });
  };
  const playEpisode = (item: Episode, fromStart = false) => {
    if (!selection || !item.workId || !playable(item)) return;
    select(item);
    const title = episodeTitle(item, selection.season);
    // The stage's target when it is this episode; another card resolves the same rule on press.
    const own = item.workId === episode?.workId && target.target.state === 'ready';
    if (!own && !fromStart) return playWork({ workId: item.workId, title, watch: item.watch });
    play({
      workId: item.workId,
      title,
      releaseId: own && target.target.state === 'ready' ? target.target.releaseId : undefined,
      startSeconds: fromStart ? 0 : resumeSeconds(item.watch),
    });
  };
  const openVersions = (item: Episode, seasonNumber: number) =>
    item.workId &&
    sheet.open({
      workId: item.workId,
      title: episodeTitle(item, seasonNumber),
      startSeconds: resumeSeconds(item.watch),
      currentReleaseId: item.watch.lastReleaseId,
    });

  const seasons = orderedSeasons(data?.seasons);
  const regular = seasons.filter((item) => item.seasonNumber > 0);
  // The season the strip shows (the previous one while the selected season loads).
  const stripSeason = episodes
    ? selection?.season
    : (season.data?.seasonNumber ?? selection?.season);
  const following =
    stripSeason !== undefined && stripSeason > 0
      ? regular.find((item) => item.seasonNumber > stripSeason)
      : undefined;
  // A season without episodes: the stage shows the series itself, the strip says why it is empty.
  const empty = !!episodes && !episodes.length && !last;
  const seasonError = season.error && !season.data ? toAppError(season.error) : undefined;
  const notAired = !!episode && (episode.aired === false || !episode.workId);
  const isNext = !!episode && !!next && episode.workId === next.workId;
  const position =
    episodes && episode && shown?.season === selection?.season
      ? t('detail.episodePosition', {
          episode: episodes.indexOf(episode) + 1,
          total: episodes.length,
        })
      : undefined;
  const pill = shown
    ? t(
        shown.season === 0
          ? 'detail.stagePillSpecial'
          : isNext
            ? 'detail.stagePillNext'
            : 'detail.stagePill',
        { season: shown.season, episode: shown.episode.episodeNumber }
      )
    : '';
  const sheetFor = episode && shown ? () => openVersions(episode, shown.season) : undefined;

  return (
    <>
      <LargeDetail
        testID={`series-screen-${tmdbId}`}
        kindLabel={pill}
        title={title}
        heading={
          episode
            ? (episode.title ?? t('media.episodeNumber', { episode: episode.episodeNumber }))
            : title
        }
        logoUrl={data?.logoUrl}
        backdropUrl={data?.backdropUrl}
        tint={data?.tint}
        tint2={data?.tint2}
        highlight={data?.highlight}
        facts={
          episode
            ? [
                episode.runtimeMinutes ? format.duration(episode.runtimeMinutes * 60) : null,
                episode.airDate ? format.date(episode.airDate) : null,
              ].filter((part): part is string => !!part)
            : []
        }
        overview={episode ? episode.overview : data?.overview}
        status={
          episode ? (
            <ResumeProgress
              testID="series-progress"
              watch={episode.watch}
              barWidth={shell.s(200)}
            />
          ) : null
        }
        loading={!data || (!shown && !empty)}
        info={data ? <SeriesInfo series={data} onPress={about.open} /> : null}
        copyKey={shown ? `${shown.season}-${shown.episode}` : undefined}
        onInfo={data ? about.open : undefined}
        infoLabel={t('detail.moreAboutSeries')}
        actions={
          data && episode && shown ? (
            notAired ? (
              <GlassButton
                testID="series-not-aired"
                icon={CalendarClock}
                label={
                  episode.airDate
                    ? t('detail.airsOn', { date: format.date(episode.airDate) })
                    : t('detail.notAired')
                }
                // TV: an inert, focusable note (like "No versions yet").
                disabled={!Platform.isTV}
              />
            ) : (
              <TitleActions
                shell
                tint={data.tint}
                testIDPrefix="series"
                workId={episode.workId}
                title={episodeTitle(episode, shown.season)}
                watch={episode.watch}
                onVersions={sheetFor}
                markTitle={episode.title ?? undefined}
                // Only the first appearance takes TV focus; later selections never move it.
                preferFocus={!picked}
                mainRef={mainButton}
              />
            )
          ) : null
        }
        chips={
          episode && !notAired ? (
            <VersionChips
              target={target.target}
              versions={target.versions}
              kind="episode"
              onPress={Platform.isTV ? undefined : sheetFor}
            />
          ) : null
        }>
        {data && selection ? (
          <>
            <View style={{ paddingLeft: gutters.start, paddingRight: gutters.end }}>
              <SeasonChips
                onFocusInside={(inside) => (inLower.current.chips = inside)}
                seasons={data.seasons}
                season={selection.season}
                tint={data.tint}
                position={position}
                onSeason={(seasonNumber) => {
                  preview.cancel();
                  setPicked({ season: seasonNumber, episode: null });
                }}
              />
            </View>
            {seasonError ? (
              <View style={{ paddingLeft: gutters.start, paddingRight: gutters.end }}>
                <ErrorState
                  testID="season-error"
                  code={seasonError.code}
                  params={seasonError.params}
                  actions={['retry']}
                  onAction={() => void season.refetch()}
                />
              </View>
            ) : (
              <EpisodeStrip
                // While the next season loads the strip keeps the cards it has: the focused one must not vanish.
                episodes={episodes ?? season.data?.episodes ?? undefined}
                selected={shown?.season === selection.season ? episode?.episodeNumber : undefined}
                nextWorkId={next?.workId}
                backdropUrl={data.backdropUrl}
                tint={data.tint}
                scrollKey={`${selection.season}-${backSteps}`}
                onFocusInside={(inside) => (inLower.current.strip = inside)}
                gutterStart={gutters.start}
                gutterEnd={gutters.end}
                continueLabel={
                  following ? seasonName(t, following.title, following.seasonNumber) : undefined
                }
                onContinue={
                  following
                    ? () => {
                        preview.cancel();
                        setPicked({ season: following.seasonNumber, episode: null });
                      }
                    : undefined
                }
                onPreview={(item) =>
                  preview.schedule(() =>
                    pick({ season: selection.season, episode: item.episodeNumber })
                  )
                }
                onSelect={select}
                onPlay={playEpisode}
                onVersions={(item) => openVersions(item, selection.season)}
              />
            )}
          </>
        ) : null}
      </LargeDetail>
      {sheet.drawer}
      {about.drawer}
    </>
  );
}

/** "About the series": overview, years · seasons · episodes, genres, rating, progress. */
function SeriesInfo({ series, onPress }: { series: SeriesDetail; onPress: () => void }) {
  const { t } = useTranslation();
  const format = useFormat();
  const { s, font } = useShell();
  const total = series.watch.totalEpisodes ?? 0;
  const played = series.watch.playedEpisodes ?? 0;
  const body = (size: number, color: string = colors.foreground.DEFAULT) => ({
    fontSize: font(size, MIN_TEXT.caption),
    lineHeight: s(size * 1.45),
    color,
  });
  const facts = seriesFacts(series, t);
  return (
    <StageInfo
      title={t('detail.aboutSeries')}
      more={t('detail.moreAboutSeries')}
      onPress={onPress}
      maxCut={SERIES_INFO_MAX_CUT}>
      {(cut) => {
        const plan = seriesInfoPlan(cut);
        return (
          <>
            {series.overview ? (
              <Text
                testID="series-info-overview"
                numberOfLines={plan.overviewLines}
                style={body(20)}>
                {series.overview}
              </Text>
            ) : null}
            {facts.length && plan.facts ? (
              <Text numberOfLines={1} style={body(18, colors.foreground.muted)}>
                {facts.join(META_SEPARATOR)}
              </Text>
            ) : null}
            {series.genres?.length && plan.genres ? (
              <Text numberOfLines={1} style={body(18, colors.foreground.muted)}>
                {series.genres.slice(0, 3).join(', ')}
              </Text>
            ) : null}
            {(series.voteAverage || series.certification) && plan.rating ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: s(12) }}>
                {series.voteAverage ? (
                  <Text
                    style={[
                      body(18),
                      { fontFamily: fonts.bodySemiBold, color: colors.warning.DEFAULT },
                    ]}>
                    {`★ ${format.decimal(series.voteAverage)}`}
                  </Text>
                ) : null}
                {series.certification ? (
                  <View
                    style={{
                      borderWidth: s(1.5),
                      borderColor: colors.foreground.muted,
                      borderRadius: s(6),
                      paddingHorizontal: s(7),
                    }}>
                    <Text
                      style={[
                        body(16, colors.foreground.muted),
                        { fontFamily: fonts.bodySemiBold },
                      ]}>
                      {series.certification}
                    </Text>
                  </View>
                ) : null}
              </View>
            ) : null}
            {total ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: s(14) }}>
                <ProgressBar value={played / total} size="md" style={{ width: s(150) }} />
                <Text testID="series-info-progress" style={body(18, colors.foreground.muted)}>
                  {t('detail.watchedCount', { played, total })}
                </Text>
              </View>
            ) : null}
          </>
        );
      }}
    </StageInfo>
  );
}
