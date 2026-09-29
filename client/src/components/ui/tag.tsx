import { Check } from 'lucide-react-native';
import { View } from 'react-native';
import Animated, { interpolateColor, useAnimatedStyle } from 'react-native-reanimated';

import { Focusable, FocusLift, useFocusState, type FocusableProps } from '@/components/focus';
import { colors, useDesign } from '@/theme';

export type TagProps = Omit<FocusableProps, 'children'> & {
  label: string;
  selected?: boolean;
};

/** Selectable chip (filters, language, season picker). Selection = accent tint + check; focus = white + ring + lift. */
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
  const { focus, hover, pressed } = useFocusState();
  const rest = selected ? colors.accent.muted : colors.secondary.DEFAULT;
  const hovered = selected ? colors.accent.hover : colors.secondary.hover;
  // Hover and press lighten, focus turns the chip white (like buttons); selection is an accent tint + check.
  const surfaceStyle = useAnimatedStyle(() => {
    const base = interpolateColor(Math.max(hover.get(), pressed.get()), [0, 1], [rest, hovered]);
    return { backgroundColor: interpolateColor(focus.get(), [0, 1], [base, colors.focus.DEFAULT]) };
  }, [rest, hovered]);
  const labelStyle = useAnimatedStyle(() => ({
    color: interpolateColor(
      focus.get(),
      [0, 1],
      [colors.foreground.DEFAULT, colors.primary.foreground]
    ),
  }));
  const restCheckStyle = useAnimatedStyle(() => ({ opacity: 1 - focus.get() }));
  const focusCheckStyle = useAnimatedStyle(() => ({ opacity: focus.get() }));
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
        <View style={{ width: iconSize, height: iconSize }}>
          <Animated.View style={[{ position: 'absolute' }, restCheckStyle]}>
            <Check size={iconSize} color={colors.accent.DEFAULT} strokeWidth={2.75} />
          </Animated.View>
          <Animated.View style={[{ position: 'absolute' }, focusCheckStyle]}>
            <Check size={iconSize} color={colors.primary.foreground} strokeWidth={2.75} />
          </Animated.View>
        </View>
      ) : null}
      <Animated.Text numberOfLines={1} style={[design.type.callout, labelStyle]}>
        {label}
      </Animated.Text>
    </Animated.View>
  );
}
