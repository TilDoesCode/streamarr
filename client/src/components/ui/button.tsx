import type { LucideIcon } from 'lucide-react-native';
import { View } from 'react-native';
import Animated, { interpolateColor, useAnimatedStyle } from 'react-native-reanimated';

import { Focusable, FocusLift, useFocusState, type FocusableProps } from '@/components/focus';
import { Spinner } from '@/components/ui/spinner';
import { colors, useDesign } from '@/theme';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'destructive';
export type ButtonSize = 'sm' | 'md' | 'lg';

type Palette = { bg: [string, string, string]; fg: [string, string] };

// [rest, hover, focused] backgrounds and [rest, focused] foregrounds. Hover lightens; focus turns white (TV idiom).
export const BUTTON_PALETTES: Record<ButtonVariant, Palette> = {
  primary: {
    bg: [colors.primary.DEFAULT, colors.focus.DEFAULT, colors.focus.DEFAULT],
    fg: [colors.primary.foreground, colors.primary.foreground],
  },
  secondary: {
    bg: [colors.secondary.DEFAULT, colors.secondary.hover, colors.primary.DEFAULT],
    fg: [colors.secondary.foreground, colors.primary.foreground],
  },
  ghost: {
    bg: [colors.scrim.clear, colors.muted.DEFAULT, colors.primary.DEFAULT],
    fg: [colors.foreground.DEFAULT, colors.primary.foreground],
  },
  destructive: {
    bg: [colors.destructive.DEFAULT, colors.danger.DEFAULT, colors.danger.DEFAULT],
    fg: [colors.destructive.foreground, colors.destructive.foreground],
  },
};

export type ButtonProps = Omit<FocusableProps, 'children'> & {
  label: string;
  icon?: LucideIcon;
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
};

export function Button({
  label,
  icon,
  variant = 'primary',
  size = 'md',
  loading = false,
  disabled,
  onPress,
  style,
  accessibilityLabel,
  ...props
}: ButtonProps) {
  const design = useDesign();
  const radius = design.radius.md;
  return (
    <Focusable
      role="button"
      accessibilityLabel={accessibilityLabel ?? label}
      aria-busy={loading}
      disabled={disabled}
      onPress={loading ? undefined : onPress}
      style={style}
      {...props}>
      <FocusLift kind="button" radius={radius} style={{ opacity: disabled ? 0.4 : 1 }}>
        <ButtonSurface
          label={label}
          icon={icon}
          variant={variant}
          size={size}
          loading={loading}
          radius={radius}
        />
      </FocusLift>
    </Focusable>
  );
}

function ButtonSurface({
  label,
  icon: IconComponent,
  variant,
  size,
  loading,
  radius,
}: {
  label: string;
  icon?: LucideIcon;
  variant: ButtonVariant;
  size: ButtonSize;
  loading: boolean;
  radius: number;
}) {
  const design = useDesign();
  const { focus, hover } = useFocusState();
  const palette = BUTTON_PALETTES[variant];
  const height = design.layout.controlHeight[size];
  const iconSize = design.layout.iconSize[size];
  const type = size === 'sm' ? design.type.callout : design.type.label;
  const paddingHorizontal =
    size === 'sm' ? design.space.md : size === 'md' ? design.space.lg : design.space.xl;

  const surfaceStyle = useAnimatedStyle(() => {
    const rest = interpolateColor(hover.get(), [0, 1], [palette.bg[0], palette.bg[1]]);
    return { backgroundColor: interpolateColor(focus.get(), [0, 1], [rest, palette.bg[2]]) };
  }, [palette]);
  const labelStyle = useAnimatedStyle(
    () => ({
      color: interpolateColor(focus.get(), [0, 1], palette.fg),
    }),
    [palette]
  );
  const restIconStyle = useAnimatedStyle(() => ({ opacity: 1 - focus.get() }));
  const focusIconStyle = useAnimatedStyle(() => ({ opacity: focus.get() }));
  const iconSwaps = palette.fg[0] !== palette.fg[1];

  return (
    <Animated.View
      style={[
        {
          height,
          paddingHorizontal,
          borderRadius: radius,
          borderCurve: 'continuous',
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: design.space.sm,
        },
        surfaceStyle,
      ]}>
      {loading ? (
        <Spinner size="sm" color={palette.fg[0]} />
      ) : IconComponent ? (
        <View style={{ width: iconSize, height: iconSize }}>
          <Animated.View style={[{ position: 'absolute' }, iconSwaps && restIconStyle]}>
            <IconComponent size={iconSize} color={palette.fg[0]} strokeWidth={2.25} />
          </Animated.View>
          {iconSwaps ? (
            <Animated.View style={[{ position: 'absolute' }, focusIconStyle]}>
              <IconComponent size={iconSize} color={palette.fg[1]} strokeWidth={2.25} />
            </Animated.View>
          ) : null}
        </View>
      ) : null}
      <Animated.Text numberOfLines={1} style={[type, labelStyle]}>
        {label}
      </Animated.Text>
    </Animated.View>
  );
}
