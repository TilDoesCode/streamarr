import type { LucideIcon } from 'lucide-react-native';
import { View } from 'react-native';

import { Focusable, FocusLift, type FocusableProps } from '@/components/focus';
import { Text } from '@/components/ui/text';
import { SHELL } from '@/shell/shell-metrics';
import { useShell } from '@/shell/use-shell';
import { colors, fonts, useDesign } from '@/theme';

import { Glass } from './glass';

export type GlassButtonProps = Omit<FocusableProps, 'children'> & {
  label: string;
  icon?: LucideIcon;
  /** `solid` = the white primary pill (Play); `glass` = a glass pill. */
  tone?: 'solid' | 'glass';
  tint?: string | null;
};

/** Pill control (Aurora): glass or solid white, spring focus/hover/press via FocusLift. */
export function GlassButton({
  label,
  icon: Icon,
  tone = 'glass',
  tint,
  disabled,
  accessibilityLabel,
  ...props
}: GlassButtonProps) {
  const design = useDesign();
  const { large, s } = useShell();
  // Large shell: the mockup's 64 pt pill with 22 pt text on TV, web and tablet alike.
  const height = large ? s(SHELL.button) : design.layout.controlHeight.lg;
  const fg = tone === 'solid' ? colors.primary.foreground : colors.foreground.DEFAULT;
  const content = (
    <View
      style={{
        height,
        paddingHorizontal: large ? s(30) : design.space.xl,
        flexDirection: 'row',
        alignItems: 'center',
        gap: large ? s(12) : design.space.sm,
      }}>
      {Icon ? (
        <Icon size={large ? s(26) : design.layout.iconSize.lg} color={fg} strokeWidth={2.25} />
      ) : null}
      <Text
        variant="label"
        numberOfLines={1}
        style={[
          { color: fg },
          large && {
            fontFamily: fonts.bodySemiBold,
            fontSize: s(SHELL.type.button),
            lineHeight: s(28),
          },
        ]}>
        {label}
      </Text>
    </View>
  );
  return (
    <Focusable
      role="button"
      accessibilityLabel={accessibilityLabel ?? label}
      disabled={disabled}
      {...props}>
      <FocusLift
        kind="button"
        radius={height / 2}
        tint={tint}
        style={{ opacity: disabled ? 0.4 : 1 }}>
        {tone === 'solid' ? (
          <View style={{ borderRadius: height / 2, backgroundColor: colors.primary.DEFAULT }}>
            {content}
          </View>
        ) : (
          <Glass interactive radius={height / 2} tint={tint} intensity="strong">
            {content}
          </Glass>
        )}
      </FocusLift>
    </Focusable>
  );
}

export type GlassChipProps = Omit<FocusableProps, 'children'> & {
  label: string;
  selected?: boolean;
  tint?: string | null;
};

/** Small glass capsule (filters, season picker); selection = tint wash. */
export function GlassChip({ label, selected = false, tint, ...props }: GlassChipProps) {
  const design = useDesign();
  const height = design.layout.controlHeight.sm;
  return (
    <Focusable role="button" aria-selected={selected} accessibilityLabel={label} {...props}>
      <FocusLift kind="button" radius={height / 2} tint={tint}>
        <Glass
          interactive
          radius={height / 2}
          intensity={selected ? 'strong' : 'subtle'}
          tint={selected ? (tint ?? colors.accent.DEFAULT) : null}
          style={{ height, paddingHorizontal: design.space.lg, justifyContent: 'center' }}>
          <Text variant="callout" numberOfLines={1}>
            {label}
          </Text>
        </Glass>
      </FocusLift>
    </Focusable>
  );
}
