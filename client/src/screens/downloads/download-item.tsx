import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { END_OF_ROW, FocusGuide } from '@/components/focus';
import { Pause, Play, RotateCw, Trash2 } from '@/components/icons';
import { Dialog } from '@/components/ui/dialog';
import { IconButton } from '@/components/ui/icon-button';
import { ProgressBar } from '@/components/ui/progress-bar';
import { Text } from '@/components/ui/text';
import {
  blockedBy,
  downloadErrorText,
  downloadProgress,
  downloadStateLabel,
  downloadTitle,
  isActiveDownload,
  isRemovingDownload,
  waitsForSignIn,
  type DownloadActions,
  type OfflineDownload,
} from '@/downloads';
import { useFormat } from '@/i18n/format';
import { META_SEPARATOR } from '@/lib/media-labels';
import { playHref } from '@/navigation/routes';
import { colors, useDesign, useFocusGap } from '@/theme';

import { failureActions } from './download-model';

/** "640 MB of 2.1 GB · 12 MB/s", the countdown or the error under a title that already names the state. */
export function useDownloadLine() {
  const { t, i18n } = useTranslation();
  const format = useFormat();
  return (download: OfflineDownload, bytesPerSecond = 0, now = Date.now()): string => {
    if (isRemovingDownload(download)) return t('downloads.state.removing');
    const total = download.sizeBytes ?? download.estimatedBytes;
    // Held back by the profile's rights: it continues, so the line keeps its progress.
    if (blockedBy(download))
      return total
        ? t('downloads.detail.bytesOf', {
            done: format.fileSize(download.bytesWritten),
            total: format.fileSize(total),
          })
        : t('downloads.detail.blocked.title');
    if (download.state === 'failed' && download.error)
      return downloadErrorText(t, download.error, i18n.language).title;
    if (download.state === 'downloading' && total)
      return [
        t('downloads.detail.bytesOf', {
          done: format.fileSize(download.bytesWritten),
          total: format.fileSize(total),
        }),
        bytesPerSecond > 0
          ? t('downloads.detail.speed', {
              speed:
                bytesPerSecond < 1_000_000
                  ? t('downloads.detail.kilobytes', {
                      value: Math.max(1, Math.round(bytesPerSecond / 1000)),
                    })
                  : format.fileSize(bytesPerSecond),
            })
          : null,
      ]
        .filter(Boolean)
        .join(META_SEPARATOR);
    if (download.state === 'done')
      return [downloadStateLabel(t, 'done'), total ? format.fileSize(total) : null]
        .filter(Boolean)
        .join(META_SEPARATOR);
    if (waitsForSignIn(download)) return t('downloads.detail.afterSignIn');
    const bytes = total
      ? t('downloads.detail.bytesOf', {
          done: format.fileSize(download.bytesWritten),
          total: format.fileSize(total),
        })
      : null;
    const wait = download.retryAt ? Math.ceil((download.retryAt - now) / 1000) : 0;
    if (wait > 0 && download.state !== 'paused')
      return [
        bytes,
        wait < 60
          ? t('downloads.detail.nextTrySeconds', { count: wait })
          : t('downloads.detail.nextTryMinutes', { count: Math.ceil(wait / 60) }),
      ]
        .filter(Boolean)
        .join(META_SEPARATOR);
    return bytes ?? '';
  };
}

/** The current time, ticking every second while `until` lies ahead (a retry countdown). */
function useNow(until: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!until || until <= Date.now()) return;
    const timer = setInterval(() => {
      const next = Date.now();
      setNow(next);
      if (next >= until) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [until]);
  return now;
}

export type ControlsPrimary = 'retry' | 'play' | 'resume' | 'pause' | null;

/** The one main control of a download: retry (failed), play (finished, where offered), resume or pause. */
export function controlsPrimary(download: OfflineDownload, withPlay: boolean): ControlsPrimary {
  if (isRemovingDownload(download)) return null;
  if (failureActions(download).retry) return 'retry';
  if (download.state === 'done') return withPlay ? 'play' : null;
  if (download.state === 'paused') return 'resume';
  // Checking the file: pause stays in place, unavailable, so the focus has no reason to move.
  return isActiveDownload(download) ? 'pause' : null;
}

type HandoffProps = { onFocus: () => void; onBlur: () => void };

/** Play (finished), pause/resume, retry (failed) and remove (with a confirmation) for one download. */
export function DownloadControls({
  download,
  actions,
  playTitle,
  testID,
  focus,
}: {
  download: OfflineDownload;
  actions: DownloadActions;
  /** Title for the player (finished downloads get a play button). */
  playTitle?: string;
  testID: string;
  /** TV: hands the focus to the card when a control vanishes under it (see `useFocusHandoff`). */
  focus?: { primary: HandoffProps; remove: HandoffProps };
}) {
  const { t } = useTranslation();
  const router = useRouter();
  const design = useDesign();
  const gap = useFocusGap(design.space.xs);
  const [confirm, setConfirm] = useState(false);
  const title = downloadTitle(t, download);
  const primary = controlsPrimary(download, playTitle !== undefined);
  // The engine takes seconds to pause or resume: the button waits for the new state instead of inviting a second press.
  const [pendingFrom, setPendingFrom] = useState<string | null>(null);
  const pending = pendingFrom === download.state;
  // Being removed: nothing left to pause, retry or delete.
  if (isRemovingDownload(download)) return null;
  return (
    <FocusGuide
      remember
      trap={END_OF_ROW}
      style={{ flexDirection: 'row', alignItems: 'center', gap }}>
      {primary ? (
        // One control whose icon and label follow the state: pressing it never moves the focus elsewhere.
        <IconButton
          key="primary"
          testID={`${testID}-${primary}`}
          icon={primary === 'retry' ? RotateCw : primary === 'pause' ? Pause : Play}
          size="sm"
          accessibilityLabel={t(`downloads.detail.${primary}`, { title })}
          // While the engine pauses or resumes, and while the file is checked: unavailable, still focused.
          inert={pending || download.state === 'verifying'}
          aria-busy={pending}
          onPress={() => {
            if (primary === 'play') {
              router.push(playHref({ workId: download.workId, title: playTitle || title }));
              return;
            }
            if (primary === 'retry') {
              void actions.retry(download.id);
              return;
            }
            setPendingFrom(download.state);
            void (
              primary === 'resume' ? actions.resume(download.id) : actions.pause(download.id)
            ).finally(() => setPendingFrom(null));
          }}
          {...focus?.primary}
        />
      ) : null}
      <IconButton
        testID={`${testID}-remove`}
        icon={Trash2}
        size="sm"
        variant="ghost"
        accessibilityLabel={t(
          download.state === 'done' ? 'downloads.detail.remove' : 'downloads.detail.cancel',
          { title }
        )}
        onPress={() => setConfirm(true)}
        {...focus?.remove}
      />
      <Dialog
        testID={`${testID}-remove-dialog`}
        open={confirm}
        onClose={() => setConfirm(false)}
        title={t(
          download.state === 'done'
            ? 'downloads.detail.removeTitle'
            : 'downloads.detail.cancelTitle',
          { title }
        )}
        actions={[
          {
            label: t('common.cancel'),
            variant: 'secondary',
            preferred: true,
            onPress: () => setConfirm(false),
          },
          {
            testID: `${testID}-remove-confirm`,
            label: t(
              download.state === 'done'
                ? 'downloads.detail.removeConfirm'
                : 'downloads.detail.cancelConfirm'
            ),
            variant: 'destructive',
            onPress: () => {
              setConfirm(false);
              void actions.remove(download.id);
            },
          },
        ]}
      />
    </FocusGuide>
  );
}

/** A running/paused/failed download's progress line (detail pages, the Downloads list). */
export function DownloadProgressLine({
  download,
  bytesPerSecond = 0,
  testID,
}: {
  download: OfflineDownload;
  bytesPerSecond?: number;
  testID: string;
}) {
  const { t } = useTranslation();
  const design = useDesign();
  const line = useDownloadLine();
  const now = useNow(download.retryAt);
  const progress = downloadProgress(download);
  const failed = download.state === 'failed' && !blockedBy(download);
  const text = line(download, bytesPerSecond, now);
  return (
    <View style={{ gap: design.space.xs }}>
      {progress !== null && download.state !== 'done' && !isRemovingDownload(download) ? (
        <View testID={`${testID}-bar`}>
          <ProgressBar
            value={progress}
            size="sm"
            accessibilityLabel={t('downloads.detail.progressLabel', {
              percent: Math.floor(progress * 100),
            })}
          />
        </View>
      ) : null}
      {text ? (
        <Text
          testID={`${testID}-line`}
          variant="caption"
          numberOfLines={1}
          style={{ color: failed ? colors.danger.DEFAULT : colors.foreground.muted }}>
          {text}
        </Text>
      ) : null}
    </View>
  );
}
