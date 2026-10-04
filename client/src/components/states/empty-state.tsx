import type { LucideIcon } from '@/components/icons';
import type { ReactNode } from 'react';
import { View } from 'react-native';

import { CENTRED_ROW, FocusGuide } from '@/components/focus';
import { Text } from '@/components/ui/text';
import { colors, gutterPadding, useDesign, useFocusGap } from '@/theme';

export type EmptyStateProps = {
  icon: LucideIcon;
  title: string;
  message?: string;
  /** Buttons (first one is the primary action). */
  actions?: ReactNode;
  /** Error code or other detail, shown small and selectable. */
  detail?: string;
  iconColor?: string;
  /** Inside a card that already has padding. */
  compact?: boolean;
  testID?: string;
};

/** Centered explanation for "nothing here" and failure states. */
export function EmptyState({
  icon: IconComponent,
  title,
  message,
  actions,
  detail,
  iconColor = colors.foreground.muted,
  compact = false,
  testID,
}: EmptyStateProps) {
  const design = useDesign();
  const actionGap = useFocusGap(design.space.md);
  const disc = design.px(64);
  const textWidth = design.px(440);
  return (
    <View
      testID={testID}
      style={{
        alignItems: 'center',
        alignSelf: 'stretch',
        gap: design.space.md,
        paddingVertical: compact ? 0 : design.space['3xl'],
        ...(compact ? null : gutterPadding(design)),
      }}>
      <View
        style={{
          width: disc,
          height: disc,
          borderRadius: disc / 2,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: colors.surface.raised,
        }}>
        <IconComponent size={disc * 0.45} color={iconColor} strokeWidth={1.75} />
      </View>
      <Text variant="heading" style={{ textAlign: 'center', maxWidth: textWidth }}>
        {title}
      </Text>
      {message ? (
        <Text
          variant="body"
          tone="muted"
          style={{ textAlign: 'center', maxWidth: textWidth }}
          selectable>
          {message}
        </Text>
      ) : null}
      {detail ? (
        <Text variant="caption" tone="subtle" selectable>
          {detail}
        </Text>
      ) : null}
      {actions ? (
        <FocusGuide
          remember
          trap={CENTRED_ROW}
          style={{
            flexDirection: 'row',
            flexWrap: 'wrap',
            justifyContent: 'center',
            gap: actionGap,
            marginTop: design.space.sm,
            maxWidth: design.px(720),
          }}>
          {actions}
        </FocusGuide>
      ) : null}
    </View>
  );
}
