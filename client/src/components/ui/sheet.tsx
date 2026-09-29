import { Check } from 'lucide-react-native';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Modal, StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, {
  Easing,
  interpolate,
  interpolateColor,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { scheduleOnRN } from 'react-native-worklets';

import {
  FocusGuide,
  Focusable,
  FocusLayer,
  FocusLift,
  useFocusState,
  useInitialWebFocus,
} from '@/components/focus';
import { OverlayScrim } from '@/components/ui/overlay-scrim';
import { Text } from '@/components/ui/text';
import { colors, easing, motion, useDesign } from '@/theme';

const EASE_SHEET = Easing.bezier(...easing.sheet);
const EASE_OUT = Easing.bezier(...easing.out);

// Where a flick would come to rest (exponential decay), so velocity can dismiss.
function project(velocity: number, decelerationRate = 0.998) {
  'worklet';
  return ((velocity / 1000) * decelerationRate) / (1 - decelerationRate);
}

export type SheetProps = {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  testID?: string;
};

/** Phone: bottom sheet (drag down to dismiss). Tablet, desktop, TV: side panel from the right. */
export function Sheet({ open, onClose, title, children, testID }: SheetProps) {
  const design = useDesign();
  const insets = useSafeAreaInsets();
  const reduced = useReducedMotion();
  const side = design.formFactor !== 'phone';
  const [visible, setVisible] = useState(open);
  const [extent, setExtent] = useState(side ? design.px(400) : design.window.height * 0.6);
  const progress = useSharedValue(0);
  const drag = useSharedValue(0);

  if (open && !visible) setVisible(true);

  useEffect(() => {
    if (open) {
      drag.set(0);
      progress.set(withTiming(1, { duration: reduced ? motion.state : 300, easing: EASE_SHEET }));
    } else {
      progress.set(
        withTiming(0, { duration: motion.exit, easing: EASE_OUT }, (finished) => {
          if (finished) scheduleOnRN(setVisible, false);
        })
      );
    }
  }, [open, reduced, progress, drag]);

  const pan = useMemo(
    () =>
      Gesture.Pan()
        .enabled(!side)
        .activeOffsetY([-10, 10])
        .onUpdate((event) => {
          drag.set(event.translationY > 0 ? event.translationY : event.translationY * 0.15);
        })
        .onEnd((event) => {
          if (drag.get() + project(event.velocityY) > extent * 0.35) {
            scheduleOnRN(onClose);
          } else {
            drag.set(
              withSpring(0, { duration: 300, dampingRatio: 0.8, velocity: event.velocityY })
            );
          }
        }),
    [side, extent, onClose, drag]
  );

  const panelStyle = useAnimatedStyle(() => {
    const offset = (1 - progress.get()) * extent;
    if (reduced) return { opacity: progress.get() };
    return side
      ? { transform: [{ translateX: offset }] }
      : { transform: [{ translateY: offset + drag.get() }] };
  }, [reduced, side, extent]);
  const backdropStyle = useAnimatedStyle(
    () => ({
      opacity: side
        ? progress.get()
        : progress.get() * interpolate(drag.get(), [0, extent], [1, 0], 'clamp'),
    }),
    [side, extent]
  );

  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      onRequestClose={onClose}
      statusBarTranslucent
      navigationBarTranslucent
      supportedOrientations={['portrait', 'landscape']}>
      <FocusLayer open={open}>
        <GestureHandlerRootView style={{ flex: 1 }}>
          <Animated.View style={[StyleSheet.absoluteFill, backdropStyle]}>
            <OverlayScrim onPress={onClose} />
          </Animated.View>
          <GestureDetector gesture={pan}>
            <Animated.View
              testID={testID}
              role="dialog"
              aria-modal
              aria-label={title}
              onLayout={(event) => {
                const size = side
                  ? event.nativeEvent.layout.width
                  : event.nativeEvent.layout.height;
                if (Math.abs(size - extent) > 1) setExtent(size);
              }}
              style={[
                {
                  position: 'absolute',
                  backgroundColor: colors.surface.raised,
                  boxShadow: design.shadow.overlay,
                  borderCurve: 'continuous',
                  gap: design.space.md,
                },
                side
                  ? {
                      top: 0,
                      bottom: 0,
                      right: 0,
                      width: Math.min(design.px(400), design.window.width * 0.9),
                      paddingTop: Math.max(insets.top, design.layout.edgeVertical),
                      paddingBottom: Math.max(insets.bottom, design.layout.edgeVertical),
                      paddingLeft: design.space['2xl'],
                      // TV: the focused option's ring stays inside the overscan-safe gutter.
                      paddingRight: design.isTV ? design.layout.gutter : design.space['2xl'],
                      borderTopLeftRadius: design.radius.xl,
                      borderBottomLeftRadius: design.radius.xl,
                    }
                  : {
                      left: 0,
                      right: 0,
                      bottom: 0,
                      maxHeight: '85%',
                      paddingTop: design.space.sm,
                      paddingBottom: Math.max(insets.bottom, design.space.lg),
                      paddingHorizontal: design.layout.gutter,
                      borderTopLeftRadius: design.radius.xl,
                      borderTopRightRadius: design.radius.xl,
                    },
                panelStyle,
              ]}>
              {side ? null : (
                // Grabber: platform-standard 36 × 5 pt handle.
                <View
                  style={{
                    alignSelf: 'center',
                    width: 36,
                    height: 5,
                    borderRadius: 3,
                    backgroundColor: colors.foreground.subtle,
                  }}
                />
              )}
              <Text variant="heading">{title}</Text>
              <FocusGuide
                remember
                trap={['up', 'down', 'left', 'right']}
                style={{ gap: design.space.xs }}>
                {children}
              </FocusGuide>
            </Animated.View>
          </GestureDetector>
        </GestureHandlerRootView>
      </FocusLayer>
    </Modal>
  );
}

export type SheetItemProps = {
  label: string;
  description?: string;
  selected?: boolean;
  onPress: () => void;
  /** Initial focus for remote and keyboard when the sheet opens (usually the selected option). */
  preferred?: boolean;
};

/** Selectable option row inside a Sheet (audio track, subtitle, version). */
export function SheetItem({
  label,
  description,
  selected = false,
  onPress,
  preferred = false,
}: SheetItemProps) {
  const design = useDesign();
  const radius = design.radius.md;
  const ref = useRef<View>(null);
  useInitialWebFocus(ref, preferred);
  return (
    <Focusable
      ref={ref}
      role="radio"
      aria-checked={selected}
      accessibilityLabel={description ? `${label}, ${description}` : label}
      hasTVPreferredFocus={preferred}
      onPress={onPress}>
      <FocusLift kind="none" radius={radius}>
        <SheetItemSurface
          label={label}
          description={description}
          selected={selected}
          radius={radius}
        />
      </FocusLift>
    </Focusable>
  );
}

function SheetItemSurface({
  label,
  description,
  selected,
  radius,
}: {
  label: string;
  description?: string;
  selected: boolean;
  radius: number;
}) {
  const design = useDesign();
  const { focus, hover, pressed } = useFocusState();
  const surfaceStyle = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(
      Math.max(focus.get(), hover.get() * 0.6, pressed.get()),
      [0, 1],
      [colors.scrim.clear, colors.surface.overlay]
    ),
  }));
  const iconSize = design.layout.iconSize.md;
  return (
    <Animated.View
      style={[
        {
          flexDirection: 'row',
          alignItems: 'center',
          gap: design.space.md,
          minHeight: design.layout.controlHeight.lg,
          paddingHorizontal: design.space.md,
          paddingVertical: design.space.sm,
          borderRadius: radius,
          borderCurve: 'continuous',
        },
        surfaceStyle,
      ]}>
      <View style={{ width: iconSize }}>
        {selected ? (
          <Check size={iconSize} color={colors.accent.DEFAULT} strokeWidth={2.75} />
        ) : null}
      </View>
      <View style={{ flex: 1, gap: design.px(2) }}>
        <Text variant="body" style={{ fontWeight: selected ? '600' : '400' }}>
          {label}
        </Text>
        {description ? (
          <Text variant="caption" tone="subtle">
            {description}
          </Text>
        ) : null}
      </View>
    </Animated.View>
  );
}
