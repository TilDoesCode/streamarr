import { useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useMovieDetail, useVersions, useWatchRefreshOnFocus } from '@/browse/queries';
import { Check, EyeOff } from 'lucide-react-native';

import {
  ResumeProgress,
  resumeSeconds,
  TitleActions,
  usePlay,
  useWatchedToggle,
} from '@/browse/title-actions';
import { useOpenVersions, VersionPicker } from '@/browse/version-picker';
import { specNote, versionSpec } from '@/browse/version-format';
import { entryIndex, VersionPanel } from '@/browse/version-panel';
import { VersionSummary } from '@/browse/version-summary';
import { useFormat } from '@/i18n/format';
import { useReturnTarget } from '@/navigation/return-focus';
import { useScreenTitle } from '@/navigation/screen-title';

import { useShell } from '@/shell/use-shell';

import { DetailError, routeNumber } from './detail-parts';
import { LargeDetail, peopleCredits, usePanelEntry } from './large-detail';
import { PhoneDetail } from './phone-detail';

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
  const panel = usePanelEntry();
  const versions = useVersions(movie.data?.workId, true);
  const watched = useWatchedToggle({
    ids: movie.data?.workId ? [movie.data.workId] : [],
    played: !!movie.data?.watch.played,
    title: movie.data?.title ?? '',
  });
  const list = versions.data?.versions ?? [];
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
  const playVersion = (releaseId: string | null | undefined) => {
    if (data?.workId)
      play({ workId: data.workId, title, releaseId, startSeconds: resumeSeconds(data.watch) });
  };

  if (shell.large)
    return (
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
        spec={versionSpec(list[entryIndex(list)])}
        specNote={specNote(list, t)}
        overview={data?.overview}
        status={
          data ? (
            <ResumeProgress testID="movie-progress" watch={data.watch} barWidth={shell.s(220)} />
          ) : null
        }
        credits={peopleCredits(data?.people, t)}
        panelFocused={panel.inside}
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
              onVersions={() => panel.enter()}
            />
          ) : null
        }
        panel={
          <VersionPanel
            workId={data?.workId}
            currentReleaseId={data?.watch.lastReleaseId}
            tint={data?.tint}
            artHighlight={data?.highlight}
            entryRef={panel.entryRef}
            highlight={panel.highlight}
            onFocusInside={panel.setInside}
            onEntry={panel.onEntry}
            onPlay={(version) => playVersion(version.releaseId)}
          />
        }
      />
    );

  const played = !!data?.watch.played;
  return (
    <>
      <PhoneDetail
        testID={`movie-screen-${tmdbId}`}
        kindLabel={t('detail.movie')}
        title={title}
        logoUrl={data?.logoUrl}
        backdropUrl={data?.backdropUrl}
        tint={data?.tint}
        facts={facts.slice(0, 2)}
        certification={data?.certification}
        spec={versionSpec(list[entryIndex(list)])}
        specNote={specNote(list, t)}
        overview={data?.overview}
        credits={peopleCredits(data?.people, t)}
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
              currentReleaseId={data.watch.lastReleaseId}
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
                  icon: played ? EyeOff : Check,
                  label: t(played ? 'detail.unwatch' : 'detail.watched'),
                  accessibilityLabel: t(played ? 'detail.markUnplayed' : 'detail.markPlayed'),
                  selected: played,
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
