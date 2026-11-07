import { useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { END_OF_ROW, FocusGuide, Focusable, FocusLift, useFocusHandoff } from '@/components/focus';
import type { LucideIcon } from '@/components/icons';
import { Artwork } from '@/components/media/artwork';
import type { ButtonVariant } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { ProgressBar } from '@/components/ui/progress-bar';
import { Text } from '@/components/ui/text';
import { useArtworkUri } from '@/downloads/hooks';
import type { OfflineDownload } from '@/downloads/types';
import { colors, useDesign } from '@/theme';

/** A row button: icon, label (screen readers, TV) and press. */
export type RowAction = {
  testID: string;
  icon: LucideIcon;
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  /** Shown but unavailable for now (e.g. while the file is checked): keeps its place and the focus. */
  inert?: boolean;
};

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
  /** Resume, pause, retry or play: one control whose icon and label change, so the focus stays on it (TV). */
  primary?: RowAction | null;
  /** Extra actions between the main one and Delete (e.g. "Other version"). */
  actions?: ReactNode;
  /** Delete, always last; focus never moves onto it when the row changes state. */
  remove?: RowAction | null;
  /** Not focusable, after Delete (e.g. the series row's chevron). */
  trailing?: ReactNode;
  /** Being removed: dimmed, without press or actions. */
  subdued?: boolean;
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
  primary,
  actions,
  remove,
  trailing,
  subdued = false,
  testID,
}: DownloadRowProps) {
  const { t } = useTranslation();
  const design = useDesign();
  // TV: the row itself holds the focus when the control under it goes away (state change, being removed).
  const anchor = useRef<View>(null);
  const [anchorHeld, setAnchorHeld] = useState(false);
  const hasPrimary = !!primary && !subdued;
  const hasRemove = !!remove && !subdued;
  const primaryHandoff = useFocusHandoff(hasPrimary, anchor);
  const removeHandoff = useFocusHandoff(hasRemove, anchor);
  const still = useArtworkUri(download, 'still');
  const backdrop = useArtworkUri(download, 'backdrop');
  const poster = useArtworkUri(download, 'poster');
  const uri = artwork === 'poster' ? (poster ?? still) : (still ?? backdrop ?? poster);
  const width = design.px(artwork === 'poster' ? 52 : 112);
  const height = artwork === 'poster' ? (width * 3) / 2 : (width * 9) / 16;
  const body = (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: design.space.md,
        opacity: subdued ? 0.4 : 1,
      }}>
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
      {(onPress && !subdued) || design.isTV ? (
        // One element for both, so a row that stops being pressable keeps the focus it holds.
        <Focusable
          ref={anchor}
          testID={testID ? `${testID}-${onPress && !subdued ? 'open' : 'row'}` : undefined}
          role={onPress && !subdued ? 'button' : undefined}
          accessibilityLabel={
            accessibilityLabel ?? [title, detail, problem].filter(Boolean).join(', ')
          }
          onPress={onPress && !subdued ? onPress : undefined}
          // Without a press only a stop while the row has no main action, or while it still holds the focus.
          focusable={(onPress && !subdued) || !hasPrimary || anchorHeld}
          onFocus={() => setAnchorHeld(true)}
          onBlur={() => setAnchorHeld(false)}
          style={{ flex: 1 }}>
          <FocusLift kind="none" radius={design.radius.md}>
            <View style={{ padding: design.space.sm }}>{body}</View>
          </FocusLift>
        </Focusable>
      ) : (
        <View style={{ flex: 1, padding: design.space.sm }}>{body}</View>
      )}
      {!subdued && (primary || actions || remove || trailing) ? (
        // Not flattened (Android): the buttons keep their native parent when the row's text changes around them.
        <View
          collapsable={false}
          style={{ flexDirection: 'row', alignItems: 'center', gap: design.space.xs }}>
          {primary ? (
            <IconButton
              key="primary"
              testID={primary.testID}
              icon={primary.icon}
              size="sm"
              variant={primary.variant ?? 'ghost'}
              inert={primary.inert}
              accessibilityLabel={primary.label}
              onPress={primary.onPress}
              {...primaryHandoff}
            />
          ) : null}
          {actions}
          {remove ? (
            <IconButton
              key="remove"
              testID={remove.testID}
              icon={remove.icon}
              size="sm"
              variant={remove.variant ?? 'ghost'}
              accessibilityLabel={remove.label}
              onPress={remove.onPress}
              {...removeHandoff}
            />
          ) : null}
          {trailing}
        </View>
      ) : null}
    </FocusGuide>
  );
}
