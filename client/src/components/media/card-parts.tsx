import { Check } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import Animated, {
  interpolateColor,
  useAnimatedStyle,
  useReducedMotion,
} from 'react-native-reanimated';

import { useFocusState } from '@/components/focus';
import { SpecLabels, type CatalogSpec } from '@/components/spec';
import { MIN_TEXT, SHELL } from '@/shell/shell-metrics';
import { useShell } from '@/shell/use-shell';
import { Text } from '@/components/ui/text';
import { colors, fonts, useDesign } from '@/theme';

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

/** Large shell: the focused card (scaled ring included) stays inside the row gap, clear of its neighbours. */
export function useCardScale(cardWidth: number): number {
  const design = useDesign();
  const { large, s } = useShell();
  const { cardScale, ringOffset, ringWidth } = design.focus;
  if (!large) return cardScale;
  const room = s(SHELL.row.gap) - design.px(2);
  const half = cardWidth / 2;
  return Math.max(1, Math.min(cardScale, (room + half) / (half + ringOffset + ringWidth)));
}

// Longer sublines ("S2, E3 · 2 min left") keep the whole line; the chips give way.
const SHORT_SUBLINE = 10;

/** Title + subtitle under a card; slides clear of the lifted artwork and brightens (or appears) on focus. */
export function CardCaption({
  title,
  subtitle,
  artworkHeight,
  revealOnFocus = false,
  spec,
  maxSpec = 3,
  scale,
}: {
  /** The card's focus scale (useCardScale); large shell captions sit below it and never move. */
  scale?: number;
  title: string;
  subtitle?: string;
  artworkHeight: number;
  /** Signal spec chips under the caption (large shell). */
  spec?: CatalogSpec | null;
  maxSpec?: number;
  /** Only the focused card shows its caption (TV poster rows). */
  revealOnFocus?: boolean;
}) {
  const design = useDesign();
  const { large, s, font } = useShell();
  const reduced = useReducedMotion();
  const { focus } = useFocusState();
  const ring = design.focus.ringOffset + design.focus.ringWidth;
  const lifted = scale ?? design.focus.cardScale;
  const clear = Math.ceil(((lifted - 1) * artworkHeight) / 2 + lifted * ring + design.px(2));
  const shift = large
    ? 0
    : reduced
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
    <Animated.View
      style={[
        {
          paddingTop: large ? Math.max(s(16), clear) : design.space.sm,
          gap: large ? s(4) : design.px(1),
        },
        moveStyle,
      ]}>
      <Animated.Text
        numberOfLines={1}
        style={[
          large
            ? {
                fontFamily: fonts.bodySemiBold,
                fontSize: font(SHELL.type.cardTitle, MIN_TEXT.caption),
                lineHeight: font(28, MIN_TEXT.caption + 5),
              }
            : design.type.callout,
          titleStyle,
        ]}>
        {title}
      </Animated.Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: s(10) }}>
        {subtitle ? (
          <Text
            variant="caption"
            tone="subtle"
            numberOfLines={1}
            style={[
              { flexShrink: 1 },
              large && {
                fontSize: font(SHELL.type.cardSubline, MIN_TEXT.subline),
                lineHeight: font(24, MIN_TEXT.subline + 5),
              },
            ]}>
            {subtitle}
          </Text>
        ) : null}
        {large && spec && (subtitle?.length ?? 0) <= SHORT_SUBLINE ? (
          <SpecLabels
            spec={spec}
            max={maxSpec}
            style={{ flexShrink: 0, flexWrap: 'nowrap', marginLeft: 'auto' }}
          />
        ) : null}
      </View>
    </Animated.View>
  );
}

/** Extra padding a row needs so lifted, ringed cards are not clipped by the scroll view. */
export function useFocusRoom(artworkHeight: number) {
  const design = useDesign();
  const ring = design.focus.ringOffset + design.focus.ringWidth;
  return Math.ceil(((design.focus.cardScale - 1) * artworkHeight) / 2 + ring + design.px(4));
}
