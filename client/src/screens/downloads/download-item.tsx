import { useRouter } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { END_OF_ROW, FocusGuide } from '@/components/focus';
import { Pause, Play, RotateCw, Trash2 } from '@/components/icons';
import { Dialog } from '@/components/ui/dialog';
import { IconButton } from '@/components/ui/icon-button';
import { ProgressBar } from '@/components/ui/progress-bar';
import { Text } from '@/components/ui/text';
import {
  downloadErrorText,
  downloadProgress,
  downloadStateLabel,
  downloadTitle,
  isActiveDownload,
  type DownloadActions,
  type OfflineDownload,
} from '@/downloads';
import { useFormat } from '@/i18n/format';
import { META_SEPARATOR } from '@/lib/media-labels';
import { playHref } from '@/navigation/routes';
import { colors, useDesign, useFocusGap } from '@/theme';

/** "640 MB of 2.1 GB · 12 MB/s" while it transfers, else the state ("Paused", "Waiting for Wi-Fi", the error). */
export function useDownloadLine() {
  const { t, i18n } = useTranslation();
  const format = useFormat();
  return (download: OfflineDownload, bytesPerSecond = 0): string => {
    if (download.state === 'failed' && download.error)
      return downloadErrorText(t, download.error, i18n.language).title;
    const total = download.sizeBytes ?? download.estimatedBytes;
    if (download.state === 'downloading' && total)
      return [
        t('downloads.detail.bytesOf', {
          done: format.fileSize(download.bytesWritten),
          total: format.fileSize(total),
        }),
        bytesPerSecond > 0
          ? t('downloads.detail.speed', { speed: format.fileSize(bytesPerSecond) })
          : null,
      ]
        .filter(Boolean)
        .join(META_SEPARATOR);
    if (download.state === 'done')
      return [downloadStateLabel(t, 'done'), total ? format.fileSize(total) : null]
        .filter(Boolean)
        .join(META_SEPARATOR);
    return downloadStateLabel(t, download.state);
  };
}

/** Play (finished), pause/resume, retry (failed) and remove (with a confirmation) for one download. */
export function DownloadControls({
  download,
  actions,
  playTitle,
  testID,
}: {
  download: OfflineDownload;
  actions: DownloadActions;
  /** Title for the player (finished downloads get a play button). */
  playTitle?: string;
  testID: string;
}) {
  const { t } = useTranslation();
  const router = useRouter();
  const design = useDesign();
  const gap = useFocusGap(design.space.xs);
  const [confirm, setConfirm] = useState(false);
  const title = downloadTitle(t, download);
  const paused = download.state === 'paused';
  const active = isActiveDownload(download) && download.state !== 'verifying';
  return (
    <FocusGuide
      remember
      trap={END_OF_ROW}
      style={{ flexDirection: 'row', alignItems: 'center', gap }}>
      {download.state === 'done' && playTitle !== undefined ? (
        <IconButton
          testID={`${testID}-play`}
          icon={Play}
          size="sm"
          accessibilityLabel={t('downloads.detail.play', { title })}
          onPress={() =>
            router.push(playHref({ workId: download.workId, title: playTitle || title }))
          }
        />
      ) : null}
      {active || paused ? (
        <IconButton
          testID={`${testID}-${paused ? 'resume' : 'pause'}`}
          icon={paused ? Play : Pause}
          size="sm"
          accessibilityLabel={t(paused ? 'downloads.detail.resume' : 'downloads.detail.pause', {
            title,
          })}
          onPress={() => void (paused ? actions.resume(download.id) : actions.pause(download.id))}
        />
      ) : null}
      {download.state === 'failed' ? (
        <IconButton
          testID={`${testID}-retry`}
          icon={RotateCw}
          size="sm"
          accessibilityLabel={t('downloads.detail.retry', { title })}
          onPress={() => void actions.retry(download.id)}
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
  const design = useDesign();
  const line = useDownloadLine();
  const progress = downloadProgress(download);
  const failed = download.state === 'failed';
  return (
    <View style={{ gap: design.space.xs }}>
      {progress !== null && download.state !== 'done' ? (
        <View testID={`${testID}-bar`}>
          <ProgressBar value={progress} size="sm" />
        </View>
      ) : null}
      <Text
        testID={`${testID}-line`}
        variant="caption"
        numberOfLines={1}
        style={{ color: failed ? colors.danger.DEFAULT : colors.foreground.muted }}>
        {line(download, bytesPerSecond)}
      </Text>
    </View>
  );
}
