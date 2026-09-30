import type { LucideIcon } from 'lucide-react-native';
import { View } from 'react-native';

import { Text, type TextTone } from '@/components/ui/text';
import { colors, fonts, useDesign } from '@/theme';

export type BadgeVariant =
  'neutral' | 'solid' | 'outline' | 'accent' | 'success' | 'warning' | 'danger' | 'info';

const VARIANTS: Record<
  BadgeVariant,
  { bg: string; border?: string; tone: TextTone; icon: string }
> = {
  neutral: { bg: colors.secondary.DEFAULT, tone: 'default', icon: colors.foreground.DEFAULT },
  solid: { bg: colors.primary.DEFAULT, tone: 'inverse', icon: colors.primary.foreground },
  outline: {
    bg: colors.scrim.clear,
    border: colors.foreground.subtle,
    tone: 'muted',
    icon: colors.foreground.muted,
  },
  accent: { bg: colors.accent.muted, tone: 'accent', icon: colors.accent.DEFAULT },
  success: { bg: colors.success.muted, tone: 'success', icon: colors.success.DEFAULT },
  warning: { bg: colors.warning.muted, tone: 'warning', icon: colors.warning.DEFAULT },
  danger: { bg: colors.danger.muted, tone: 'danger', icon: colors.danger.DEFAULT },
  info: { bg: colors.info.muted, tone: 'default', icon: colors.info.DEFAULT },
};

export type BadgeProps = {
  label: string;
  variant?: BadgeVariant;
  icon?: LucideIcon;
  /** Over artwork: adds a dark backing so the badge stays legible. */
  onMedia?: boolean;
  testID?: string;
};

/** Compact, non-interactive label: quality (4K, HDR10), status (Ready, New), age rating. */
export function Badge({
  label,
  variant = 'neutral',
  icon: IconComponent,
  onMedia,
  testID,
}: BadgeProps) {
  const design = useDesign();
  const style = VARIANTS[variant];
  const iconSize = design.px(12);
  return (
    <View
      testID={testID}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        alignSelf: 'flex-start',
        gap: design.space.xs,
        paddingHorizontal: design.px(7),
        paddingVertical: design.px(2),
        borderRadius: design.radius.sm,
        borderCurve: 'continuous',
        backgroundColor: onMedia && variant === 'neutral' ? colors.scrim.DEFAULT : style.bg,
        borderWidth: style.border ? 1 : 0,
        borderColor: style.border,
      }}>
      {IconComponent ? (
        <IconComponent size={iconSize} color={style.icon} strokeWidth={2.5} />
      ) : null}
      <Text
        variant="caption"
        tone={style.tone}
        style={{ fontFamily: fonts.bodyBold }}
        numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
}
