import { Check } from 'lucide-react-native';
import Animated, { interpolateColor, useAnimatedStyle } from 'react-native-reanimated';

import { Focusable, FocusLift, useFocusState, type FocusableProps } from '@/components/focus';
import { colors, useDesign } from '@/theme';

export type TagProps = Omit<FocusableProps, 'children'> & {
  label: string;
  selected?: boolean;
};

/** Selectable chip (filters, language, season picker). Selection = filled; focus = ring + lift. */
export function Tag({ label, selected = false, disabled, style, ...props }: TagProps) {
  const design = useDesign();
  const height = design.layout.controlHeight.sm;
  return (
    <Focusable
      role="button"
      accessibilityLabel={label}
      aria-selected={selected}
      disabled={disabled}
      style={style}
      {...props}>
      <FocusLift kind="button" radius={height / 2} style={{ opacity: disabled ? 0.4 : 1 }}>
        <TagSurface label={label} selected={selected} height={height} />
      </FocusLift>
    </Focusable>
  );
}

function TagSurface({
  label,
  selected,
  height,
}: {
  label: string;
  selected: boolean;
  height: number;
}) {
  const design = useDesign();
  const { focus, hover } = useFocusState();
  const rest = selected ? colors.primary.DEFAULT : colors.secondary.DEFAULT;
  const hovered = selected ? colors.focus.DEFAULT : colors.secondary.hover;
  const fg = selected ? colors.primary.foreground : colors.foreground.DEFAULT;
  // Like buttons: hover lightens, focus turns the chip white; the check marks selection.
  const surfaceStyle = useAnimatedStyle(() => {
    const base = interpolateColor(hover.get(), [0, 1], [rest, hovered]);
    return { backgroundColor: interpolateColor(focus.get(), [0, 1], [base, colors.focus.DEFAULT]) };
  }, [rest, hovered]);
  const labelStyle = useAnimatedStyle(
    () => ({ color: interpolateColor(focus.get(), [0, 1], [fg, colors.primary.foreground]) }),
    [fg]
  );
  const iconSize = design.px(14);
  return (
    <Animated.View
      style={[
        {
          height,
          paddingHorizontal: design.space.lg,
          borderRadius: height / 2,
          flexDirection: 'row',
          alignItems: 'center',
          gap: design.space.xs,
        },
        surfaceStyle,
      ]}>
      {selected ? (
        <Check size={iconSize} color={colors.primary.foreground} strokeWidth={2.75} />
      ) : null}
      <Animated.Text numberOfLines={1} style={[design.type.callout, labelStyle]}>
        {label}
      </Animated.Text>
    </Animated.View>
  );
}
