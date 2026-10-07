import { Pause, Play, type LucideIcon } from '@/components/icons';
import { View } from 'react-native';

import { Focusable, FocusLift, type FocusableProps } from '@/components/focus';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { SHELL } from '@/shell/shell-metrics';
import { useShell } from '@/shell/use-shell';
import { colors, fonts, useDesign } from '@/theme';

import { Glass } from './glass';

export type GlassButtonProps = Omit<FocusableProps, 'children'> & {
  label: string;
  icon?: LucideIcon;
  /** `solid` = the white primary pill (Play); `glass` = a glass pill. */
  /** `plain`: no surface at rest (player bar chips); focus ring and hover lift only. */
  tone?: 'solid' | 'glass' | 'plain';
  tint?: string | null;
  /** Round icon-only control; `label` stays the accessible name. */
  iconOnly?: boolean;
  /** Round control size (phone player cluster); defaults to the shell's button height. */
  size?: number;
  /** Its action runs (a close that takes seconds): a spinner in place of the icon at once. */
  busy?: boolean;
};

/** Pill control (Aurora): glass or solid white, spring focus/hover/press via FocusLift. */
export function GlassButton({
  label,
  icon: Icon,
  tone = 'glass',
  tint,
  disabled,
  accessibilityLabel,
  iconOnly = false,
  size,
  busy = false,
  ...props
}: GlassButtonProps) {
  const design = useDesign();
  const { large, s } = useShell();
  // Large shell: the mockup's 64 pt pill with 22 pt text on TV, web and tablet alike.
  const height = size ?? (large ? s(SHELL.button) : design.layout.controlHeight.lg);
  const fg = tone === 'solid' ? colors.primary.foreground : colors.foreground.DEFAULT;
  const content = (
    <View
      style={{
        height,
        width: iconOnly ? height : undefined,
        justifyContent: 'center',
        paddingHorizontal: iconOnly ? 0 : large ? s(30) : design.space.xl,
        flexDirection: 'row',
        alignItems: 'center',
        gap: large ? s(12) : design.space.sm,
      }}>
      {busy ? (
        <Spinner size="sm" />
      ) : Icon ? (
        <Icon
          size={size ? Math.round(size * 0.42) : large ? s(26) : design.layout.iconSize.lg}
          color={fg}
          fill={Icon === Play || Icon === Pause ? fg : 'none'}
          strokeWidth={2.25}
        />
      ) : null}
      {iconOnly ? null : (
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
      )}
    </View>
  );
  return (
    <Focusable
      role="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={busy ? { busy: true } : undefined}
      disabled={disabled}
      {...props}>
      <FocusLift
        kind="button"
        radius={height / 2}
        tint={tint}
        style={{ opacity: disabled ? 0.4 : 1 }}>
        {tone === 'solid' ? (
          // Keyed per tone: Android drops the radius when a background appears on an existing view.
          <View
            key="solid"
            style={{ borderRadius: height / 2, backgroundColor: colors.primary.DEFAULT }}>
            {content}
          </View>
        ) : tone === 'plain' ? (
          <View key="plain" style={{ borderRadius: height / 2 }}>
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

/** Small glass capsule (filters, season picker); selected = solid white pill, focus = ring + lift. */
export function GlassChip({ label, selected = false, tint, ...props }: GlassChipProps) {
  const design = useDesign();
  const height = design.layout.controlHeight.sm;
  return (
    <Focusable role="button" aria-selected={selected} accessibilityLabel={label} {...props}>
      <FocusLift kind="button" radius={height / 2} tint={tint}>
        {selected ? (
          <View
            key="selected"
            style={{
              height,
              borderRadius: height / 2,
              paddingHorizontal: design.space.lg,
              justifyContent: 'center',
              backgroundColor: colors.primary.DEFAULT,
            }}>
            <Text variant="callout" numberOfLines={1} style={{ color: colors.primary.foreground }}>
              {label}
            </Text>
          </View>
        ) : (
          <Glass
            key="rest"
            interactive
            radius={height / 2}
            intensity="subtle"
            style={{ height, paddingHorizontal: design.space.lg, justifyContent: 'center' }}>
            <Text variant="callout" numberOfLines={1}>
              {label}
            </Text>
          </Glass>
        )}
      </FocusLift>
    </Focusable>
  );
}
