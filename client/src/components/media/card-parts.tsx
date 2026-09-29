import { Check } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import Animated, {
  interpolateColor,
  useAnimatedStyle,
  useReducedMotion,
} from 'react-native-reanimated';

import { useFocusState } from '@/components/focus';
import { Text } from '@/components/ui/text';
import { colors, useDesign } from '@/theme';

/** Accent disc with a check: the item is fully watched. */
export function PlayedMark() {
  const { t } = useTranslation();
  const design = useDesign();
  const size = design.px(20);
  return (
    <View
      accessibilityLabel={t('a11y.played')}
      style={{
        position: 'absolute',
        top: design.space.sm,
        right: design.space.sm,
        width: size,
        height: size,
        borderRadius: size / 2,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: colors.accent.DEFAULT,
      }}>
      <Check size={size * 0.62} color={colors.accent.foreground} strokeWidth={3} />
    </View>
  );
}

/** Title + subtitle under a card; slides clear of the lifted artwork and brightens (or appears) on focus. */
export function CardCaption({
  title,
  subtitle,
  artworkHeight,
  revealOnFocus = false,
}: {
  title: string;
  subtitle?: string;
  artworkHeight: number;
  /** Only the focused card shows its caption (TV poster rows). */
  revealOnFocus?: boolean;
}) {
  const design = useDesign();
  const reduced = useReducedMotion();
  const { focus } = useFocusState();
  const shift = reduced
    ? design.focus.ringOffset + design.focus.ringWidth
    : ((design.focus.cardScale - 1) * artworkHeight) / 2 +
      design.focus.ringOffset +
      design.focus.ringWidth;
  const moveStyle = useAnimatedStyle(
    () => ({
      opacity: revealOnFocus ? focus.get() : 1,
      transform: [{ translateY: focus.get() * shift }],
    }),
    [shift, revealOnFocus]
  );
  const titleStyle = useAnimatedStyle(() => ({
    color: interpolateColor(
      focus.get(),
      [0, 1],
      [colors.foreground.muted, colors.foreground.DEFAULT]
    ),
  }));
  return (
    <Animated.View style={[{ paddingTop: design.space.sm, gap: design.px(1) }, moveStyle]}>
      <Animated.Text numberOfLines={1} style={[design.type.callout, titleStyle]}>
        {title}
      </Animated.Text>
      {subtitle ? (
        <Text variant="caption" tone="subtle" numberOfLines={1}>
          {subtitle}
        </Text>
      ) : null}
    </Animated.View>
  );
}

/** Extra padding a row needs so lifted, ringed cards are not clipped by the scroll view. */
export function useFocusRoom(artworkHeight: number) {
  const design = useDesign();
  const ring = design.focus.ringOffset + design.focus.ringWidth;
  return Math.ceil(((design.focus.cardScale - 1) * artworkHeight) / 2 + ring + design.px(4));
}
