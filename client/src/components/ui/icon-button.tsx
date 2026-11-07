import type { LucideIcon } from '@/components/icons';
import Animated, { interpolateColor, useAnimatedStyle } from 'react-native-reanimated';

import { Focusable, FocusLift, useFocusState, type FocusableProps } from '@/components/focus';
import { BUTTON_PALETTES, type ButtonSize, type ButtonVariant } from '@/components/ui/button';
import { useDesign } from '@/theme';

export type IconButtonProps = Omit<FocusableProps, 'children'> & {
  icon: LucideIcon;
  /** Required: icon-only controls have no visible label. */
  accessibilityLabel: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Why it cannot act now: dimmed, busy, read as this, ignores presses, keeps the focus (unlike `disabled`). */
  busyLabel?: string | null;
};

// A handler of its own, so a press on a busy button cannot reach the caller's.
const ignorePress = () => {};

export function IconButton({
  icon,
  accessibilityLabel,
  variant = 'secondary',
  size = 'md',
  disabled,
  busyLabel,
  style,
  ...props
}: IconButtonProps) {
  const design = useDesign();
  const dimension = design.layout.controlHeight[size];
  const busy = !!busyLabel;
  return (
    <Focusable
      role="button"
      accessibilityLabel={busyLabel || accessibilityLabel}
      disabled={disabled}
      hitSlop={design.isTV ? undefined : Math.max(0, (44 - dimension) / 2)}
      style={style}
      {...props}
      aria-busy={busy || props['aria-busy']}
      onPress={busy ? ignorePress : props.onPress}>
      <FocusLift
        kind="button"
        radius={dimension / 2}
        style={{ opacity: disabled || busy ? 0.4 : 1 }}>
        <IconButtonSurface icon={icon} variant={variant} dimension={dimension} size={size} />
      </FocusLift>
    </Focusable>
  );
}

function IconButtonSurface({
  icon: IconComponent,
  variant,
  dimension,
  size,
}: {
  icon: LucideIcon;
  variant: ButtonVariant;
  dimension: number;
  size: ButtonSize;
}) {
  const design = useDesign();
  const { focus, hover, pressed } = useFocusState();
  const palette = BUTTON_PALETTES[variant];
  const iconSize = design.layout.iconSize[size];
  const surfaceStyle = useAnimatedStyle(() => {
    const lit = Math.max(hover.get(), pressed.get());
    const rest = interpolateColor(lit, [0, 1], [palette.bg[0], palette.bg[1]]);
    return { backgroundColor: interpolateColor(focus.get(), [0, 1], [rest, palette.bg[2]]) };
  }, [palette]);
  const restStyle = useAnimatedStyle(() => ({ opacity: 1 - focus.get() }));
  const focusStyle = useAnimatedStyle(() => ({ opacity: focus.get() }));
  return (
    <Animated.View
      style={[
        {
          width: dimension,
          height: dimension,
          borderRadius: dimension / 2,
          alignItems: 'center',
          justifyContent: 'center',
        },
        surfaceStyle,
      ]}>
      <Animated.View style={[{ position: 'absolute' }, restStyle]}>
        <IconComponent size={iconSize} color={palette.fg[0]} strokeWidth={2.25} />
      </Animated.View>
      <Animated.View style={[{ position: 'absolute' }, focusStyle]}>
        <IconComponent size={iconSize} color={palette.fg[1]} strokeWidth={2.25} />
      </Animated.View>
    </Animated.View>
  );
}
