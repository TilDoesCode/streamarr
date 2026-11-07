import { useRouter } from 'expo-router';
import type { TFunction } from 'i18next';
import { useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import {
  ChevronDown,
  ChevronRight,
  Download,
  Play,
  ArrowRightLeft,
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
import {
  blockedBy,
  bytesOnDevice,
  downloadProgress,
  isFinishedRow,
  lockOf,
  volumeMissing,
  waitsForSignIn,
} from '@/downloads/library';
import { isRemovingDownload } from '@/downloads/manager';
import { useDownloadsContext } from '@/downloads/provider';
import type {
  LocalPosition,
  OfflineDownload,
  OfflineSeasonGroup,
  OfflineSeriesGroup,
} from '@/downloads/types';
import { useFormat } from '@/i18n/format';
import { useDelayedFlag } from '@/lib/use-delayed-flag';
import { playHref } from '@/navigation/routes';
import { colors, useDesign } from '@/theme';

import { DOWNLOAD_ACTION, downloadBusyLabel } from './download-action';
import { DownloadRow, type DownloadRowProps } from './download-row';
import { lockLabel } from './lock-label';
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

/** "Removing…" shows only once a removal takes longer than this (most are gone before it could be read). */
export const REMOVING_LABEL_MS = 600;

/** A library row; `removing` dims it in place without press or actions ("Removing…" once it takes a moment). */
function LibraryRow({ removing, ...props }: DownloadRowProps & { removing: boolean }) {
  const { t } = useTranslation();
  // The same row before and while removing: on TV it keeps the focus instead of handing it to a neighbour.
  const late = useDelayedFlag(removing, REMOVING_LABEL_MS);
  if (!removing) return <DownloadRow {...props} />;
  return (
    <DownloadRow
      {...props}
      subdued
      progress={null}
      problem={undefined}
      detail={late ? t('downloads.state.removing') : props.detail}
    />
  );
}
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

/** Continue the episode watched last, else the first unwatched one; only episodes `playable` allows (locks, volumes). */
export function nextToPlay(
  series: OfflineSeriesGroup,
  positions: Record<string, LocalPosition>,
  playable: (download: OfflineDownload) => boolean = () => true
): { download: OfflineDownload; position: LocalPosition | null } | null {
  const done = series.seasons.flatMap((season) =>
    season.episodes.filter((episode) => episode.state === 'done' && playable(episode))
  );
  const started = done
    .filter((episode) => (positions[episode.workId]?.seconds ?? 0) > 0)
    .sort((a, b) => positions[b.workId]!.at - positions[a.workId]!.at)[0];
  if (started) return { download: started, position: positions[started.workId]! };
  const fresh = done.find((episode) => !positions[episode.workId]?.played);
  return fresh ? { download: fresh, position: null } : null;
}

function stateLine(t: TFunction, format: Format, download: OfflineDownload) {
  const state = blockedBy(download)
    ? t('downloads.detail.blocked.title')
    : downloadStateLabel(t, download.state);
  if (waitsForSignIn(download)) return `${state} · ${t('downloads.detail.afterSignIn')}`;
  if (download.state !== 'waiting_server' || !download.retryAt) return state;
  const time = new Intl.DateTimeFormat(format.lang, { hour: '2-digit', minute: '2-digit' }).format(
    download.retryAt
  );
  return `${state} · ${t('downloads.library.retryAt', { time })}`;
}

/** "Downloading · 3 MB of 12 MB · 38 KB/s" for a row in progress. */
export function transferLine(
  t: TFunction,
  format: Format,
  download: OfflineDownload,
  speed: number
) {
  const total = download.sizeBytes ?? download.estimatedBytes;
  const state = stateLine(t, format, download);
  if (!total || download.state === 'queued' || download.state === 'preparing') return state;
  const values = {
    written: format.fileSize(download.bytesWritten),
    total: format.fileSize(total),
    // Below 1 MB/s in kilobytes, so a slow line never reads "0.0 MB/s".
    speed:
      speed >= 1_000_000
        ? format.fileSize(speed)
        : t('format.size.kb', { value: Math.max(1, Math.round(speed / 1000)) }),
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

  const policy = library.accountKey ? manager.store.policy(library.accountKey) : null;
  const locked = (download: OfflineDownload) => !!lockOf(download, policy);
  // Locked by age rules, or its storage is not connected: listed, not playable here.
  const unplayable = (download: OfflineDownload) => locked(download) || volumeMissing(download);
  const play = (download: OfflineDownload) => {
    if (locked(download)) return;
    if (onPlay) onPlay(download);
    else router.push(playHref({ workId: download.workId, title: playTitleOf(t, download) }));
  };
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
    const removing = isRemovingDownload(download);
    const speed = manager.store.liveOf(download.id)?.bytesPerSecond ?? 0;
    const signIn = waitsForSignIn(download);
    const blocked = blockedBy(download);
    const problem = blocked
      ? t(`downloads.detail.blockedShort.${blocked}`)
      : download.error &&
          !signIn &&
          (download.state === 'failed' || download.state.startsWith('waiting_'))
        ? downloadErrorText(t, download.error, format.lang).message
        : undefined;
    const paused = download.state === 'paused';
    const failed = download.state === 'failed';
    // A failure offers what its server or the core suggests (`error.actions`); none listed = retry.
    const offered = failed ? download.error?.actions : undefined;
    const canRetry =
      (download.state === 'waiting_server' && !signIn) ||
      (failed && !blocked && (!offered?.length || offered.includes('retry')));
    const otherVersion =
      failed && !blocked && !!onOtherVersion && !!offered?.includes('otherVersion');
    const retryAction = {
      testID: `download-${download.workId}-retry`,
      icon: DOWNLOAD_ACTION.retry.icon,
      label: t(DOWNLOAD_ACTION.retry.labelKey, { title: label }),
      onPress: () => void actions.retry(download.id),
    };
    // One control for resume / pause / retry; while the file is checked it stays, unavailable.
    const primary = canRetry
      ? retryAction
      : !failed
        ? {
            testID: `download-${download.workId}-${paused ? 'resume' : 'pause'}`,
            icon: DOWNLOAD_ACTION[paused ? 'resume' : 'pause'].icon,
            label: t(DOWNLOAD_ACTION[paused ? 'resume' : 'pause'].labelKey, { title: label }),
            busyLabel:
              download.state === 'verifying'
                ? downloadBusyLabel(t, label, t('downloads.state.verifying'))
                : null,
            onPress: () => void (paused ? actions.resume(download.id) : actions.pause(download.id)),
          }
        : null;
    return (
      <LibraryRow
        key={download.id}
        removing={removing}
        testID={`download-${download.workId}`}
        download={download}
        title={download.kind === 'episode' ? label : title}
        detail={
          removing
            ? download.bytesWritten
              ? format.fileSize(download.bytesWritten)
              : undefined
            : transferLine(t, format, download, speed)
        }
        problem={problem}
        progress={download.state === 'failed' && !blocked ? null : downloadProgress(download)}
        primary={primary}
        actions={
          otherVersion ? (
            <IconButton
              testID={`download-${download.workId}-other-version`}
              icon={ArrowRightLeft}
              size="sm"
              variant="ghost"
              accessibilityLabel={t('downloads.detail.otherVersionLabel', { title: label })}
              onPress={() => onOtherVersion?.(download)}
            />
          ) : null
        }
        remove={{
          testID: `download-${download.workId}-delete`,
          icon: Trash2,
          label: t('downloads.library.action.delete', { title: label }),
          onPress: () => setConfirm({ kind: 'one', download }),
        }}
      />
    );
  };

  const doneRow = (download: OfflineDownload, title: string) => {
    const removing = isRemovingDownload(download);
    return (
      <LibraryRow
        key={download.id}
        removing={removing}
        testID={`download-${download.workId}`}
        download={download}
        title={title}
        detail={
          removing
            ? download.bytesWritten
              ? format.fileSize(download.bytesWritten)
              : undefined
            : doneLine(download)
        }
        problem={
          locked(download)
            ? lockLabel(t, lockOf(download, policy), 'downloads.library.locked')
            : volumeMissing(download)
              ? t('downloads.detail.volumeMissingDone')
              : undefined
        }
        onPress={unplayable(download) ? undefined : () => play(download)}
        accessibilityLabel={
          unplayable(download) ? undefined : t('downloads.library.action.play', { title })
        }
        primary={
          download.kind === 'movie' && !unplayable(download)
            ? {
                testID: `download-${download.workId}-play`,
                icon: Play,
                label: t('downloads.library.action.play', { title }),
                variant: 'secondary',
                onPress: () => play(download),
              }
            : null
        }
        remove={{
          testID: `download-${download.workId}-delete`,
          icon: Trash2,
          label: t('downloads.library.action.delete', { title }),
          onPress: () => setConfirm({ kind: 'one', download }),
        }}
      />
    );
  };

  const seriesBlock = (series: OfflineSeriesGroup) => {
    const rows = series.seasons.flatMap((season) => season.episodes.filter(isFinishedRow));
    if (!rows.length) return null;
    const done = rows.filter((episode) => episode.state === 'done');
    // Every episode is being removed: the row stays (same element, so TV focus stays), dimmed.
    const removing = !done.length;
    const open = !removing && expanded.has(series.seriesId);
    // No eligible episode: no series Play (a press would do nothing); expand and delete stay.
    const next = nextToPlay(series, positions, (episode) => !unplayable(episode));
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
        <LibraryRow
          removing={removing}
          testID={`download-series-${series.seriesId}`}
          download={series.artworkOf}
          artwork="poster"
          title={series.title}
          detail={
            removing
              ? undefined
              : [t('downloads.library.seriesLine', { count: done.length, size }), nextLine]
                  .filter(Boolean)
                  .join('\n')
          }
          onPress={() => toggle(series.seriesId)}
          accessibilityLabel={t(
            open ? 'downloads.library.action.collapse' : 'downloads.library.action.expand',
            { title: series.title }
          )}
          primary={
            next
              ? {
                  testID: `download-series-${series.seriesId}-play`,
                  icon: Play,
                  label: t('downloads.library.action.play', {
                    title: playTitleOf(t, next.download),
                  }),
                  variant: 'secondary',
                  onPress: () => play(next.download),
                }
              : null
          }
          remove={{
            testID: `download-series-${series.seriesId}-delete`,
            icon: Trash2,
            label: t('downloads.library.action.deleteSeries', { title: series.title }),
            onPress: () => setConfirm({ kind: 'series', series }),
          }}
          trailing={
            open ? (
              <ChevronDown size={design.layout.iconSize.sm} color={colors.foreground.muted} />
            ) : (
              <ChevronRight size={design.layout.iconSize.sm} color={colors.foreground.muted} />
            )
          }
        />
        {open
          ? series.seasons.map((season) => {
              const episodes = season.episodes.filter(isFinishedRow);
              const kept = episodes.filter((episode) => episode.state === 'done');
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
                        count: kept.length,
                        size: format.fileSize(
                          kept.reduce((sum, item) => sum + bytesOnDevice(item), 0)
                        ),
                      })}
                    </Text>
                    {kept.length ? (
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
                    ) : null}
                  </View>
                  {episodes.map((episode) => doneRow(episode, downloadTitle(t, episode)))}
                </View>
              );
            })
          : null}
      </View>
    );
  };

  const movies = library.movies.filter(isFinishedRow);
  const activeCount = library.active.filter((download) => !isRemovingDownload(download)).length;
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
    const kept = group.filter((download) => !isRemovingDownload(download));
    const groupMessage =
      confirm.kind === 'one'
        ? t('downloads.library.confirm.oneMessage', {
            title: playTitleOf(t, confirm.download),
          })
        : t('downloads.library.confirm.groupMessage', {
            count: kept.length,
            title: confirm.series.title,
            size: format.fileSize(kept.reduce((sum, item) => sum + bytesOnDevice(item), 0)),
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
            {activeCount
              ? t('downloads.library.inProgress', { count: activeCount })
              : t('downloads.library.inProgressTitle')}
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
