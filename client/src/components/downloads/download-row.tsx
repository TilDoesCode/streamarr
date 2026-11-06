import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { END_OF_ROW, FocusGuide, Focusable, FocusLift } from '@/components/focus';
import { Artwork } from '@/components/media/artwork';
import { ProgressBar } from '@/components/ui/progress-bar';
import { Text } from '@/components/ui/text';
import { useArtworkUri } from '@/downloads/hooks';
import type { OfflineDownload } from '@/downloads/types';
import { colors, useDesign } from '@/theme';

export type DownloadRowProps = {
  download: OfflineDownload;
  title: string;
  /** Second line: state, size or what plays next. */
  detail?: string;
  /** Third line in a warning tone (why it waits or failed). */
  problem?: string;
  /** `still` (16:9, episodes and movies) or `poster` (2:3, series). */
  artwork?: 'still' | 'poster';
  /** 0–1 while transferring. */
  progress?: number | null;
  /** The row's own press (play, expand); actions sit beside it, focusable on their own. */
  onPress?: () => void;
  accessibilityLabel?: string;
  actions?: ReactNode;
  testID?: string;
};

/** One line of the downloads library: artwork, title, state and the row's actions (TV: left/right between them). */
export function DownloadRow({
  download,
  title,
  detail,
  problem,
  artwork = 'still',
  progress,
  onPress,
  accessibilityLabel,
  actions,
  testID,
}: DownloadRowProps) {
  const { t } = useTranslation();
  const design = useDesign();
  const still = useArtworkUri(download, 'still');
  const backdrop = useArtworkUri(download, 'backdrop');
  const poster = useArtworkUri(download, 'poster');
  const uri = artwork === 'poster' ? (poster ?? still) : (still ?? backdrop ?? poster);
  const width = design.px(artwork === 'poster' ? 52 : 112);
  const height = artwork === 'poster' ? (width * 3) / 2 : (width * 9) / 16;
  const body = (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: design.space.md }}>
      <View
        style={{
          width,
          height,
          borderRadius: design.radius.sm,
          overflow: 'hidden',
          backgroundColor: colors.surface.raised,
        }}>
        <Artwork uri={uri} title={title} radius={design.radius.sm} />
      </View>
      <View style={{ flex: 1, gap: design.space.xxs }}>
        <Text variant="body" numberOfLines={2}>
          {title}
        </Text>
        {detail ? (
          <Text variant="caption" tone="muted" numberOfLines={2}>
            {detail}
          </Text>
        ) : null}
        {problem ? (
          <Text variant="caption" tone="warning" numberOfLines={3}>
            {problem}
          </Text>
        ) : null}
        {progress !== undefined && progress !== null ? (
          <ProgressBar
            value={progress}
            accessibilityLabel={t('downloads.library.progressA11y', {
              percent: Math.round(progress * 100),
            })}
            style={{ marginTop: design.space.xxs }}
          />
        ) : null}
      </View>
    </View>
  );
  return (
    <FocusGuide
      testID={testID}
      remember={false}
      trap={END_OF_ROW}
      style={{ flexDirection: 'row', alignItems: 'center', gap: design.space.sm }}>
      {onPress ? (
        <Focusable
          testID={testID ? `${testID}-open` : undefined}
          role="button"
          accessibilityLabel={accessibilityLabel ?? [title, detail].filter(Boolean).join(', ')}
          onPress={onPress}
          style={{ flex: 1 }}>
          <FocusLift kind="none" radius={design.radius.md}>
            <View style={{ padding: design.space.sm }}>{body}</View>
          </FocusLift>
        </Focusable>
      ) : (
        <View style={{ flex: 1, padding: design.space.sm }}>{body}</View>
      )}
      {actions ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: design.space.xs }}>
          {actions}
        </View>
      ) : null}
    </FocusGuide>
  );
}
