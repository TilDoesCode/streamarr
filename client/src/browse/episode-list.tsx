import { Check, EyeOff, Film, Tv } from 'lucide-react-native';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { useMarkPlayed, type Episode } from '@/browse/queries';
import { resumeSeconds, usePlay, usePlayWork, watchProgress } from '@/browse/title-actions';
import { useOpenVersions, VersionPicker } from '@/browse/version-picker';
import { END_OF_ROW, FocusGuide } from '@/components/focus';
import { EpisodeRow, EpisodeRowAction } from '@/components/media/episode-row';
import { EmptyState } from '@/components/states/empty-state';
import { Skeleton, SkeletonText } from '@/components/ui/skeleton';
import { useToast } from '@/components/ui/toast';
import { useReturnTarget } from '@/navigation/return-focus';
import { aspect, useDesign } from '@/theme';

export type EpisodeListProps = {
  episodes: readonly Episode[] | undefined;
  seriesTitle: string;
  seasonNumber: number;
  /** Episode that gets TV focus first (the next one to watch). */
  focusWorkId?: string | null;
  /** Take TV focus when the list appears (only when it is the page's main content). */
  takeFocus?: boolean;
  /** Grid columns (wide layouts). */
  columns?: number;
};

/** Episodes of one season: play/resume on press, versions and the watched toggle beside each row. */
export function EpisodeList({
  episodes,
  seriesTitle,
  seasonNumber,
  focusWorkId,
  takeFocus = false,
  columns = 1,
}: EpisodeListProps) {
  const { t } = useTranslation();
  const design = useDesign();
  const play = usePlay();
  const playWork = usePlayWork();
  const mark = useMarkPlayed();
  const toast = useToast();
  const [versionsFor, setVersionsFor] = useState<Episode | null>(null);
  // TV: Back from the player lands on the version card that started it.
  const reopenVersions = useReturnTarget<Episode>(setVersionsFor);
  const openVersions = useOpenVersions();

  if (!episodes)
    return (
      <View testID="episodes-loading" style={{ gap: design.space.sm }}>
        {[0, 1, 2].map((index) => (
          <EpisodeRowSkeleton key={index} />
        ))}
      </View>
    );
  if (!episodes.length)
    return (
      <EmptyState
        testID="episodes-empty"
        icon={Tv}
        title={t('detail.noEpisodesTitle')}
        message={t('detail.noEpisodesMessage')}
      />
    );

  const episodeTitle = (episode: Episode) =>
    t('detail.episodeTitle', {
      series: seriesTitle,
      code: t('media.episodeCode', { season: seasonNumber, episode: episode.episodeNumber }),
      title: episode.title ?? t('media.episodeNumber', { episode: episode.episodeNumber }),
    });
  const preferred = episodes.find((episode) => episode.workId === focusWorkId) ?? episodes[0];
  const width = columns > 1 ? `${(100 - 2) / columns}%` : '100%';

  return (
    <>
      <View
        style={{
          flexDirection: columns > 1 ? 'row' : 'column',
          flexWrap: 'wrap',
          columnGap: '2%',
          rowGap: design.space.sm,
        }}>
        {episodes.map((episode) => {
          const played = !!episode.watch.played;
          const title =
            episode.title ?? t('media.episodeNumber', { episode: episode.episodeNumber });
          const unavailable = episode.aired === false || !episode.workId;
          const noVersions = !unavailable && episode.versionCount === 0;
          return (
            <FocusGuide
              key={episode.episodeNumber}
              remember
              trap={END_OF_ROW}
              style={{
                width: width as `${number}%`,
                flexDirection: 'row',
                alignItems: 'center',
                gap: design.space.sm,
              }}>
              <EpisodeRow
                testID={`episode-${episode.episodeNumber}`}
                style={{ flex: 1 }}
                episodeNumber={episode.episodeNumber}
                title={title}
                overview={episode.overview ?? undefined}
                stillUri={episode.stillUrl}
                runtimeMinutes={episode.runtimeMinutes ?? undefined}
                airDate={episode.airDate ?? undefined}
                played={played}
                progress={watchProgress(episode.watch)}
                unavailable={unavailable}
                noVersions={noVersions}
                spec={episode.spec}
                hasTVPreferredFocus={takeFocus && episode === preferred}
                onPress={() =>
                  episode.workId &&
                  playWork({
                    workId: episode.workId,
                    title: episodeTitle(episode),
                    watch: episode.watch,
                  })
                }
                actions={
                  unavailable ? null : (
                    <>
                      {noVersions ? null : (
                        <EpisodeRowAction
                          testID={`episode-${episode.episodeNumber}-versions`}
                          icon={Film}
                          accessibilityLabel={t('detail.episodeVersions', { title })}
                          onPress={() =>
                            openVersions(
                              {
                                workId: episode.workId,
                                title: episodeTitle(episode),
                                startSeconds: resumeSeconds(episode.watch),
                                currentReleaseId: episode.watch.lastReleaseId,
                              },
                              () => setVersionsFor(episode)
                            )
                          }
                        />
                      )}
                      <EpisodeRowAction
                        testID={`episode-${episode.episodeNumber}-mark`}
                        icon={played ? EyeOff : Check}
                        accessibilityLabel={t(
                          played ? 'detail.markEpisodeUnplayed' : 'detail.markEpisodePlayed',
                          { title }
                        )}
                        onPress={() =>
                          !mark.isPending &&
                          mark.mutate(
                            { workIds: [episode.workId ?? ''], played: !played },
                            {
                              onSuccess: () =>
                                toast.show({
                                  message: t(
                                    played ? 'detail.markedUnplayed' : 'detail.markedPlayed',
                                    {
                                      title,
                                    }
                                  ),
                                  tone: 'success',
                                }),
                              onError: () =>
                                toast.show({ message: t('detail.markFailed'), tone: 'error' }),
                            }
                          )
                        }
                      />
                    </>
                  )
                }
              />
            </FocusGuide>
          );
        })}
      </View>
      <VersionPicker
        open={versionsFor !== null}
        onClose={() => setVersionsFor(null)}
        workId={versionsFor?.workId}
        title={versionsFor ? episodeTitle(versionsFor) : ''}
        currentReleaseId={versionsFor?.watch.lastReleaseId}
        onPlay={(version) => {
          const episode = versionsFor;
          setVersionsFor(null);
          if (episode) reopenVersions(episode);
          if (episode?.workId)
            play({
              workId: episode.workId,
              title: episodeTitle(episode),
              releaseId: version.releaseId,
              startSeconds: resumeSeconds(episode.watch),
            });
        }}
      />
    </>
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
