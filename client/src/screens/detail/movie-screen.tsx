import { useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform } from 'react-native';

import { useMovieDetail, useVersions, useWatchRefreshOnFocus } from '@/browse/queries';

import {
  ResumeProgress,
  resumeSeconds,
  TitleActions,
  usePlay,
  usePlayTarget,
  useWatchedToggle,
} from '@/browse/title-actions';
import { useOpenVersions, VersionPicker } from '@/browse/version-picker';
import { specNote, versionSpec } from '@/browse/version-format';
import { VersionChips } from '@/browse/version-chips';
import { entryIndex } from '@/browse/version-panel';
import { useVersionSheet } from '@/browse/version-sheet';
import { VersionSummary } from '@/browse/version-summary';
import { useFormat } from '@/i18n/format';
import { useReturnTarget } from '@/navigation/return-focus';
import { useScreenTitle } from '@/navigation/screen-title';

import { useShell } from '@/shell/use-shell';

import { DetailError, routeNumber } from './detail-parts';
import { useAboutSheet } from './about-sheet';
import { LargeDetail, peopleCredits } from './large-detail';
import { PhoneDetail, watchedAction } from './phone-detail';

/** Movie: hero with logo, play/resume, versions and the watched toggle. */
export function MovieScreen() {
  const { t } = useTranslation();
  const format = useFormat();
  const play = usePlay();
  const params = useLocalSearchParams<{ id: string }>();
  const tmdbId = routeNumber(params.id);
  const movie = useMovieDetail(tmdbId);
  const [versionsOpen, setVersionsOpen] = useState(false);
  // TV: Back from the player lands on the version card that started it.
  const reopenVersions = useReturnTarget(setVersionsOpen);
  const openVersions = useOpenVersions();
  const shell = useShell();
  const sheet = useVersionSheet();
  const about = useAboutSheet(
    tmdbId !== undefined ? { kind: 'movie', tmdbId, title: movie.data?.title ?? '' } : null
  );
  const versions = useVersions(movie.data?.workId, true);
  const watched = useWatchedToggle({
    ids: movie.data?.workId ? [movie.data.workId] : [],
    played: !!movie.data?.watch.played,
    title: movie.data?.title ?? '',
  });
  const list = versions.data?.versions ?? [];
  const target = usePlayTarget(movie.data?.workId, movie.data?.watch);
  useScreenTitle(movie.data?.title);
  useWatchRefreshOnFocus();

  if (tmdbId === undefined || (movie.error && !movie.data))
    return <DetailError error={movie.error} onRetry={() => void movie.refetch()} />;

  const data = movie.data;
  const title = data?.title ?? '';
  const facts = data
    ? [
        data.year ? String(data.year) : null,
        data.runtimeMinutes ? format.duration(data.runtimeMinutes * 60) : null,
        data.genres?.slice(0, 3).join(', ') || null,
      ].filter((part): part is string => !!part)
    : [];

  if (shell.large) {
    const openSheet = () =>
      data?.workId
        ? sheet.open({
            workId: data.workId,
            title,
            startSeconds: resumeSeconds(data.watch),
            currentReleaseId: data.watch.lastReleaseId,
          })
        : undefined;
    return (
      <>
        <LargeDetail
          testID={`movie-screen-${tmdbId}`}
          kindLabel={t('detail.movie')}
          title={title}
          logoUrl={data?.logoUrl}
          backdropUrl={data?.backdropUrl}
          tint={data?.tint}
          tint2={data?.tint2}
          highlight={data?.highlight}
          facts={facts}
          certification={data?.certification}
          overview={data?.overview}
          status={
            data ? (
              <ResumeProgress testID="movie-progress" watch={data.watch} barWidth={shell.s(200)} />
            ) : null
          }
          credits={peopleCredits(data?.people, t)}
          rating={data?.voteAverage}
          onInfo={data ? about.open : undefined}
          loading={!data}
          actions={
            data ? (
              <TitleActions
                shell
                tint={data.tint}
                testIDPrefix="movie"
                workId={data.workId}
                title={title}
                watch={data.watch}
                onVersions={openSheet}
              />
            ) : null
          }
          chips={
            data?.workId ? (
              <VersionChips
                target={target.target}
                versions={target.versions}
                onPress={Platform.isTV ? undefined : openSheet}
              />
            ) : null
          }
        />
        {sheet.drawer}
        {about.drawer}
      </>
    );
  }

  const played = !!data?.watch.played;
  return (
    <>
      <PhoneDetail
        about={{ kind: 'movie', tmdbId, title }}
        testID={`movie-screen-${tmdbId}`}
        kindLabel={t('detail.movie')}
        title={title}
        logoUrl={data?.logoUrl}
        backdropUrl={data?.backdropUrl}
        backdropSizes={data?.backdropSizes}
        tint={data?.tint}
        facts={facts.slice(0, 2)}
        certification={data?.certification}
        spec={versionSpec(list[entryIndex(list)])}
        specNote={specNote(list, t)}
        overview={data?.overview}
        loading={!data}
        status={data ? <ResumeProgress testID="movie-progress" watch={data.watch} /> : null}
        play={
          data ? (
            <TitleActions
              compact
              tint={data.tint}
              testIDPrefix="movie"
              workId={data.workId}
              title={title}
              watch={data.watch}
            />
          ) : null
        }
        version={
          data ? (
            <VersionSummary
              workId={data.workId}
              watch={data.watch}
              kind="movie"
              onOpen={() =>
                openVersions(
                  {
                    workId: data.workId,
                    title,
                    startSeconds: resumeSeconds(data.watch),
                    currentReleaseId: data.watch.lastReleaseId,
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
                  testID: 'movie-mark',
                  ...watchedAction(played, t),
                  disabled: watched.pending,
                  onPress: watched.toggle,
                },
              ]
            : []
        }
      />
      <VersionPicker
        open={versionsOpen}
        onClose={() => setVersionsOpen(false)}
        workId={data?.workId}
        title={title}
        currentReleaseId={data?.watch.lastReleaseId}
        onPlay={(version) => {
          setVersionsOpen(false);
          reopenVersions(true);
          if (data?.workId)
            play({
              workId: data.workId,
              title,
              releaseId: version.releaseId,
              startSeconds: resumeSeconds(data.watch),
            });
        }}
      />
    </>
  );
}
