import { useRouter } from 'expo-router';
import type { TFunction } from 'i18next';
import { useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import {
  ChevronDown,
  ChevronRight,
  Download,
  Pause,
  Play,
  ArrowRightLeft,
  RotateCcw,
  Trash2,
} from '@/components/icons';
import { EmptyState } from '@/components/states/empty-state';
import { Dialog } from '@/components/ui/dialog';
import { IconButton } from '@/components/ui/icon-button';
import { Text } from '@/components/ui/text';
import {
  useActiveDownloadAccountKey,
  useDownloadActions,
  useDownloads,
  useDownloadsSnapshot,
} from '@/downloads/hooks';
import { downloadErrorText, downloadStateLabel, downloadTitle } from '@/downloads/labels';
import { bytesOnDevice, downloadProgress } from '@/downloads/library';
import { useDownloadsContext } from '@/downloads/provider';
import type {
  LocalPosition,
  OfflineDownload,
  OfflineSeasonGroup,
  OfflineSeriesGroup,
} from '@/downloads/types';
import { useFormat } from '@/i18n/format';
import { playHref } from '@/navigation/routes';
import { colors, useDesign } from '@/theme';

import { DownloadRow } from './download-row';
import { StorageSummary } from './storage-summary';

export type DownloadsLibraryProps = {
  /** Plays a finished download (default: the player, which starts the local file). */
  onPlay?: (download: OfflineDownload) => void;
  /** Above the list (offline banner, page title). */
  header?: ReactNode;
  /** The server cannot be reached: the empty state explains downloads made while connected. */
  offline?: boolean;
  /** A failed download whose server offers `otherVersion`: opens the download sheet for that work. */
  onOtherVersion?: (download: OfflineDownload) => void;
  testID?: string;
};

type Format = ReturnType<typeof useFormat>;
type Confirm =
  | { kind: 'one'; download: OfflineDownload }
  | { kind: 'season'; series: OfflineSeriesGroup; season: OfflineSeasonGroup }
  | { kind: 'series'; series: OfflineSeriesGroup };

/** The player's title of a download ("Series · S1, E2 · Title" for episodes). */
export function playTitleOf(t: TFunction, download: OfflineDownload): string {
  if (download.kind === 'movie') return download.meta.title;
  const code = t('media.episodeCode', {
    season: download.seasonNumber ?? 0,
    episode: download.episodeNumber ?? 0,
  });
  return t('detail.episodeTitle', {
    series: download.meta.seriesTitle ?? '',
    code,
    title: download.meta.title || code,
  });
}

/** Continue the episode watched last, else the first unwatched one. */
export function nextToPlay(
  series: OfflineSeriesGroup,
  positions: Record<string, LocalPosition>
): { download: OfflineDownload; position: LocalPosition | null } | null {
  const done = series.seasons.flatMap((season) =>
    season.episodes.filter((episode) => episode.state === 'done')
  );
  const started = done
    .filter((episode) => (positions[episode.workId]?.seconds ?? 0) > 0)
    .sort((a, b) => positions[b.workId]!.at - positions[a.workId]!.at)[0];
  if (started) return { download: started, position: positions[started.workId]! };
  const fresh = done.find((episode) => !positions[episode.workId]?.played);
  return fresh ? { download: fresh, position: null } : null;
}

function transferLine(t: TFunction, format: Format, download: OfflineDownload, speed: number) {
  const total = download.sizeBytes ?? download.estimatedBytes;
  const state = downloadStateLabel(t, download.state);
  if (!total || download.state === 'queued' || download.state === 'preparing') return state;
  const values = {
    written: format.fileSize(download.bytesWritten),
    total: format.fileSize(total),
    speed: format.fileSize(speed),
  };
  const amount =
    download.state === 'downloading' && speed > 0
      ? t('downloads.library.progressSpeed', values)
      : t('downloads.library.progress', values);
  return `${state} · ${amount}`;
}

/** Grouped downloads of the active profile (Series → Season → Episode, Movies) with state, play and delete. */
export function DownloadsLibrary({
  onPlay,
  header,
  offline = false,
  onOtherVersion,
  testID,
}: DownloadsLibraryProps) {
  const { t } = useTranslation();
  const design = useDesign();
  const format = useFormat();
  const router = useRouter();
  const library = useDownloads();
  const actions = useDownloadActions();
  const { manager } = useDownloadsContext();
  const all = useDownloadsSnapshot();
  const accountKey = useActiveDownloadAccountKey();
  const positions = useMemo(
    () => (accountKey && all ? manager.store.positions(accountKey) : {}),
    [manager, accountKey, all]
  );
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [confirm, setConfirm] = useState<Confirm | null>(null);

  const play = (download: OfflineDownload) =>
    onPlay
      ? onPlay(download)
      : router.push(playHref({ workId: download.workId, title: playTitleOf(t, download) }));
  const toggle = (seriesId: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(seriesId)) next.delete(seriesId);
      else next.add(seriesId);
      return next;
    });

  const doneLine = (download: OfflineDownload) => {
    const position = positions[download.workId];
    const size = format.fileSize(bytesOnDevice(download));
    const parts = [download.kind === 'movie' ? t('downloads.library.movieLine', { size }) : size];
    if (position?.played) parts.push(t('downloads.library.watched'));
    else if (position && position.seconds > 0 && position.durationSeconds)
      parts.push(format.remaining(position.durationSeconds - position.seconds));
    return parts.join(' · ');
  };

  const activeRow = (download: OfflineDownload) => {
    const title = downloadTitle(t, download);
    const label = download.kind === 'episode' ? playTitleOf(t, download) : title;
    const speed = manager.store.liveOf(download.id)?.bytesPerSecond ?? 0;
    const problem =
      download.error && (download.state === 'failed' || download.state.startsWith('waiting_'))
        ? downloadErrorText(t, download.error, format.lang).message
        : undefined;
    const paused = download.state === 'paused';
    const failed = download.state === 'failed';
    // A failure offers what its server or the core suggests (`error.actions`); none listed = retry.
    const offered = failed ? download.error?.actions : undefined;
    const canRetry =
      download.state === 'waiting_server' ||
      (failed && (!offered?.length || offered.includes('retry')));
    const otherVersion = failed && !!onOtherVersion && !!offered?.includes('otherVersion');
    return (
      <DownloadRow
        key={download.id}
        testID={`download-${download.workId}`}
        download={download}
        title={download.kind === 'episode' ? label : title}
        detail={transferLine(t, format, download, speed)}
        problem={problem}
        progress={download.state === 'failed' ? null : downloadProgress(download)}
        actions={
          <>
            {otherVersion ? (
              <IconButton
                testID={`download-${download.workId}-other-version`}
                icon={ArrowRightLeft}
                size="sm"
                variant="ghost"
                accessibilityLabel={t('downloads.detail.otherVersionLabel', { title: label })}
                onPress={() => onOtherVersion?.(download)}
              />
            ) : null}
            {canRetry ? (
              <IconButton
                testID={`download-${download.workId}-retry`}
                icon={RotateCcw}
                size="sm"
                variant="ghost"
                accessibilityLabel={t('downloads.library.action.retry', { title: label })}
                onPress={() => void actions.retry(download.id)}
              />
            ) : !failed && download.state !== 'verifying' ? (
              <IconButton
                testID={`download-${download.workId}-${paused ? 'resume' : 'pause'}`}
                icon={paused ? Download : Pause}
                size="sm"
                variant="ghost"
                accessibilityLabel={t(
                  paused ? 'downloads.library.action.resume' : 'downloads.library.action.pause',
                  { title: label }
                )}
                onPress={() =>
                  void (paused ? actions.resume(download.id) : actions.pause(download.id))
                }
              />
            ) : null}
            <IconButton
              testID={`download-${download.workId}-delete`}
              icon={Trash2}
              size="sm"
              variant="ghost"
              accessibilityLabel={t('downloads.library.action.delete', { title: label })}
              onPress={() => setConfirm({ kind: 'one', download })}
            />
          </>
        }
      />
    );
  };

  const doneRow = (download: OfflineDownload, title: string) => (
    <DownloadRow
      key={download.id}
      testID={`download-${download.workId}`}
      download={download}
      title={title}
      detail={doneLine(download)}
      onPress={() => play(download)}
      accessibilityLabel={t('downloads.library.action.play', { title })}
      actions={
        <IconButton
          testID={`download-${download.workId}-delete`}
          icon={Trash2}
          size="sm"
          variant="ghost"
          accessibilityLabel={t('downloads.library.action.delete', { title })}
          onPress={() => setConfirm({ kind: 'one', download })}
        />
      }
    />
  );

  const seriesBlock = (series: OfflineSeriesGroup) => {
    const done = series.seasons.flatMap((season) =>
      season.episodes.filter((episode) => episode.state === 'done')
    );
    if (!done.length) return null;
    const open = expanded.has(series.seriesId);
    const next = nextToPlay(series, positions);
    const nextCode = next
      ? t('media.episodeCode', {
          season: next.download.seasonNumber ?? 0,
          episode: next.download.episodeNumber ?? 0,
        })
      : null;
    const nextLine =
      next && nextCode
        ? next.position?.durationSeconds
          ? t('downloads.library.continue', {
              code: nextCode,
              remaining: format.remaining(next.position.durationSeconds - next.position.seconds),
            })
          : t('downloads.library.next', { code: nextCode })
        : null;
    const size = format.fileSize(done.reduce((sum, item) => sum + bytesOnDevice(item), 0));
    return (
      <View key={series.seriesId} style={{ gap: design.space.xs }}>
        <DownloadRow
          testID={`download-series-${series.seriesId}`}
          download={series.artworkOf}
          artwork="poster"
          title={series.title}
          detail={[t('downloads.library.seriesLine', { count: done.length, size }), nextLine]
            .filter(Boolean)
            .join('\n')}
          onPress={() => toggle(series.seriesId)}
          accessibilityLabel={t(
            open ? 'downloads.library.action.collapse' : 'downloads.library.action.expand',
            { title: series.title }
          )}
          actions={
            <>
              {next ? (
                <IconButton
                  testID={`download-series-${series.seriesId}-play`}
                  icon={Play}
                  size="sm"
                  accessibilityLabel={t('downloads.library.action.play', {
                    title: playTitleOf(t, next.download),
                  })}
                  onPress={() => play(next.download)}
                />
              ) : null}
              <IconButton
                testID={`download-series-${series.seriesId}-delete`}
                icon={Trash2}
                size="sm"
                variant="ghost"
                accessibilityLabel={t('downloads.library.action.deleteSeries', {
                  title: series.title,
                })}
                onPress={() => setConfirm({ kind: 'series', series })}
              />
              {open ? (
                <ChevronDown size={design.layout.iconSize.sm} color={colors.foreground.muted} />
              ) : (
                <ChevronRight size={design.layout.iconSize.sm} color={colors.foreground.muted} />
              )}
            </>
          }
        />
        {open
          ? series.seasons.map((season) => {
              const episodes = season.episodes.filter((episode) => episode.state === 'done');
              if (!episodes.length) return null;
              return (
                <View
                  key={season.seasonId}
                  testID={`download-season-${season.seasonId}`}
                  style={{ gap: design.space.xxs, paddingLeft: design.space.lg }}>
                  <View
                    style={{ flexDirection: 'row', alignItems: 'center', gap: design.space.sm }}>
                    <Text variant="label" tone="muted" style={{ flex: 1 }}>
                      {t('downloads.library.seasonLine', {
                        season: season.seasonNumber,
                        count: episodes.length,
                        size: format.fileSize(
                          episodes.reduce((sum, item) => sum + bytesOnDevice(item), 0)
                        ),
                      })}
                    </Text>
                    <IconButton
                      testID={`download-season-${season.seasonId}-delete`}
                      icon={Trash2}
                      size="sm"
                      variant="ghost"
                      accessibilityLabel={t('downloads.library.action.deleteSeason', {
                        season: season.seasonNumber,
                        title: series.title,
                      })}
                      onPress={() => setConfirm({ kind: 'season', series, season })}
                    />
                  </View>
                  {episodes.map((episode) => doneRow(episode, downloadTitle(t, episode)))}
                </View>
              );
            })
          : null}
      </View>
    );
  };

  const movies = library.movies.filter((movie) => movie.state === 'done');
  const seriesBlocks = library.series.map(seriesBlock).filter(Boolean);
  const empty = !library.active.length && !movies.length && !seriesBlocks.length;

  const dialog = (() => {
    if (!confirm) return null;
    const remove = () => {
      const target = confirm;
      setConfirm(null);
      if (target.kind === 'one') void actions.remove(target.download.id);
      else if (target.kind === 'season') void actions.removeSeason(target.season.seasonId);
      else void actions.removeSeries(target.series.seriesId);
    };
    const group =
      confirm.kind === 'season'
        ? confirm.season.episodes
        : confirm.kind === 'series'
          ? confirm.series.seasons.flatMap((season) => season.episodes)
          : [];
    const groupMessage =
      confirm.kind === 'one'
        ? t('downloads.library.confirm.oneMessage', {
            title: playTitleOf(t, confirm.download),
          })
        : t('downloads.library.confirm.groupMessage', {
            count: group.length,
            title: confirm.series.title,
            size: format.fileSize(group.reduce((sum, item) => sum + bytesOnDevice(item), 0)),
          });
    return {
      title:
        confirm.kind === 'one'
          ? t('downloads.library.confirm.oneTitle')
          : confirm.kind === 'season'
            ? t('downloads.library.confirm.seasonTitle', { season: confirm.season.seasonNumber })
            : t('downloads.library.confirm.seriesTitle', { title: confirm.series.title }),
      message: groupMessage,
      remove,
    };
  })();

  return (
    <View testID={testID ?? 'downloads-library'} style={{ gap: design.layout.sectionGap }}>
      {header}
      <StorageSummary />
      {empty ? (
        <EmptyState
          testID="downloads-empty"
          icon={Download}
          title={t('downloads.library.empty.title')}
          message={t(
            offline ? 'downloads.library.empty.offline' : 'downloads.library.empty.message'
          )}
        />
      ) : null}
      {library.active.length ? (
        <View testID="downloads-active" style={{ gap: design.space.xs }}>
          <Text variant="subheading" role="heading">
            {t('downloads.library.inProgress', { count: library.active.length })}
          </Text>
          {library.active.map(activeRow)}
        </View>
      ) : null}
      {seriesBlocks.length ? (
        <View testID="downloads-series" style={{ gap: design.space.sm }}>
          <Text variant="subheading" role="heading">
            {t('downloads.library.series')}
          </Text>
          {seriesBlocks}
        </View>
      ) : null}
      {movies.length ? (
        <View testID="downloads-movies" style={{ gap: design.space.xs }}>
          <Text variant="subheading" role="heading">
            {t('downloads.library.movies')}
          </Text>
          {movies.map((movie) => doneRow(movie, movie.meta.title))}
        </View>
      ) : null}
      <Dialog
        testID="downloads-confirm"
        open={!!dialog}
        onClose={() => setConfirm(null)}
        title={dialog?.title ?? ''}
        message={dialog?.message}
        actions={[
          { label: t('common.cancel'), onPress: () => setConfirm(null), preferred: true },
          {
            label: t('downloads.library.confirm.delete'),
            variant: 'destructive',
            onPress: () => dialog?.remove(),
            testID: 'downloads-confirm-delete',
          },
        ]}
      />
    </View>
  );
}
