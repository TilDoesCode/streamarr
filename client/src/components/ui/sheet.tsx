import { Check } from 'lucide-react-native';
import {
  Children,
  createContext,
  isValidElement,
  use,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Modal, Platform, ScrollView, StyleSheet, View } from 'react-native';
import {
  Gesture,
  GestureDetector,
  GestureHandlerRootView,
  type PanGesture,
} from 'react-native-gesture-handler';
import Animated, {
  Easing,
  FadeIn,
  FadeOut,
  interpolate,
  interpolateColor,
  Keyframe,
  ReduceMotion,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  type SharedValue,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { scheduleOnRN } from 'react-native-worklets';

import {
  FocusGuide,
  Focusable,
  FocusLayer,
  FocusLift,
  ItemSnapContext,
  useFocusState,
  useInitialFocus,
} from '@/components/focus';
import { OverlayScrim } from '@/components/ui/overlay-scrim';
import { Text } from '@/components/ui/text';
import { colors, easing, fonts, motion, useDesign } from '@/theme';

const ENTER_MS = 300;
const EASE_SHEET = Easing.bezier(...easing.sheet);
const EASE_OUT = Easing.bezier(...easing.out);
const BACKDROP_IN = FadeIn.duration(ENTER_MS);
const BACKDROP_OUT = FadeOut.duration(motion.exit);
const REDUCED_IN = FadeIn.duration(motion.state).reduceMotion(ReduceMotion.Never);
const REDUCED_OUT = FadeOut.duration(motion.exit).reduceMotion(ReduceMotion.Never);

// Mount-driven slide: the panel's resting state is its plain style, never a JS-started animation.
function slide(distance: number, side: boolean) {
  const at = (offset: number) => (side ? [{ translateX: offset }] : [{ translateY: offset }]);
  return {
    enter: new Keyframe({
      0: { transform: at(distance) },
      100: { transform: at(0), easing: EASE_SHEET },
    }).duration(ENTER_MS),
    exit: new Keyframe({
      0: { transform: at(0) },
      100: { transform: at(distance), easing: EASE_OUT },
    }).duration(motion.exit),
  };
}

// Where a flick would come to rest (exponential decay), so velocity can dismiss.
function project(velocity: number, decelerationRate = 0.998) {
  'worklet';
  return ((velocity / 1000) * decelerationRate) / (1 - decelerationRate);
}

function dismissPan(
  enabled: boolean,
  drag: SharedValue<number>,
  extent: number,
  onClose: () => void
): PanGesture {
  return Gesture.Pan()
    .enabled(enabled)
    .activeOffsetY([-10, 10])
    .onUpdate((event) => {
      drag.set(event.translationY > 0 ? event.translationY : event.translationY * 0.15);
    })
    .onEnd((event) => {
      if (drag.get() + project(event.velocityY) > extent * 0.35) {
        scheduleOnRN(onClose);
      } else {
        drag.set(withSpring(0, { duration: 300, dampingRatio: 0.8, velocity: event.velocityY }));
      }
    });
}

type Roving = { tabStop: boolean; onFocus: () => void };

// Web: the options form one radio group with a single Tab stop and arrow-key movement.
const RovingContext = createContext<Roving | null>(null);

function moveWebFocus(event: { key: string; currentTarget: unknown; preventDefault: () => void }) {
  const keys: Record<string, number> = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 };
  if (!(event.key in keys) && event.key !== 'Home' && event.key !== 'End') return;
  const radios = Array.from(
    (event.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('[role="radio"]')
  );
  const current = radios.findIndex((radio) => radio === document.activeElement);
  if (current < 0 || radios.length === 0) return;
  const last = radios.length - 1;
  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? last
        : (current + (keys[event.key] ?? 0) + radios.length) % radios.length;
  event.preventDefault();
  radios[next]?.focus();
}

export type SheetProps = {
  open: boolean;
  onClose: () => void;
  title: string;
  /** SheetItems (one radio group); the list scrolls when it is taller than the panel. */
  children: ReactNode;
  /** Wider side panel for rich options (version cards). */
  wide?: boolean;
  /** Non-focusable line under the title (counts, hints). */
  subtitle?: string;
  testID?: string;
};

/** Phone: bottom sheet (drag down to dismiss). Tablet, desktop, TV: side panel from the right. */
export function Sheet({
  open,
  onClose,
  title,
  children,
  wide = false,
  subtitle,
  testID,
}: SheetProps) {
  const design = useDesign();
  const insets = useSafeAreaInsets();
  const reduced = useReducedMotion();
  const side = design.formFactor !== 'phone';
  const panelWidth = Math.min(design.px(wide ? 600 : 400), design.window.width * 0.9);
  const [mounted, setMounted] = useState(open);
  const [extent, setExtent] = useState(design.window.height * 0.6);
  const [viewport, setViewport] = useState(0);
  const [content, setContent] = useState(0);
  const [active, setActive] = useState<number | null>(null);
  const drag = useSharedValue(0);

  if (open && !mounted) setMounted(true);

  // Keeps the Modal up while the panel's exit animation plays.
  useEffect(() => {
    if (open || !mounted) return;
    const timer = setTimeout(() => {
      drag.set(0);
      setActive(null);
      setMounted(false);
    }, motion.exit + 60);
    return () => clearTimeout(timer);
  }, [open, mounted, drag]);

  const transitions = useMemo(
    () =>
      reduced
        ? { enter: REDUCED_IN, exit: REDUCED_OUT }
        : slide(side ? panelWidth : design.window.height, side),
    [reduced, side, panelWidth, design.window.height]
  );

  // Phone: drag anywhere while the options fit; drag the header once they scroll.
  const scrolls = content > viewport + 1;
  const surfacePan = useMemo(
    () => dismissPan(!side && !scrolls, drag, extent, onClose),
    [side, scrolls, drag, extent, onClose]
  );
  const headerPan = useMemo(
    () => dismissPan(!side && scrolls, drag, extent, onClose),
    [side, scrolls, drag, extent, onClose]
  );
  const dragStyle = useAnimatedStyle(() => ({ transform: [{ translateY: drag.get() }] }));
  const backdropStyle = useAnimatedStyle(
    () => ({ opacity: interpolate(drag.get(), [0, extent], [1, 0], 'clamp') }),
    [extent]
  );

  const items = Children.toArray(children);
  const preferredIndex = items.findIndex(
    (child) => isValidElement<{ preferred?: boolean }>(child) && child.props.preferred
  );
  const tabStop = active ?? Math.max(0, preferredIndex);
  const ringRoom = design.focus.ringOffset + design.focus.ringWidth + design.space.xxs;
  const bottomEdge = Math.max(insets.bottom, side ? design.layout.edgeVertical : design.space.lg);
  const inset = side
    ? {
        paddingLeft: design.space['2xl'],
        // TV: the focused option's ring stays inside the overscan-safe gutter.
        paddingRight: design.isTV ? design.layout.gutter : design.space['2xl'],
      }
    : { paddingHorizontal: design.layout.gutter };

  return (
    <Modal
      visible={mounted}
      transparent
      animationType="none"
      onRequestClose={onClose}
      statusBarTranslucent
      navigationBarTranslucent
      supportedOrientations={['portrait', 'landscape']}>
      <FocusLayer open={open}>
        <GestureHandlerRootView style={{ flex: 1 }}>
          {open ? (
            <>
              <Animated.View
                entering={BACKDROP_IN}
                exiting={BACKDROP_OUT}
                style={StyleSheet.absoluteFill}>
                <Animated.View style={[StyleSheet.absoluteFill, !side && backdropStyle]}>
                  <OverlayScrim onPress={onClose} />
                </Animated.View>
              </Animated.View>
              <Animated.View
                testID={testID}
                role="dialog"
                aria-modal
                aria-label={title}
                entering={transitions.enter}
                exiting={transitions.exit}
                style={
                  side
                    ? { position: 'absolute', top: 0, bottom: 0, right: 0, width: panelWidth }
                    : { position: 'absolute', left: 0, right: 0, bottom: 0, maxHeight: '85%' }
                }>
                <GestureDetector gesture={surfacePan}>
                  <Animated.View
                    onLayout={(event) => {
                      if (!side) setExtent(event.nativeEvent.layout.height);
                    }}
                    style={[
                      {
                        flexShrink: 1,
                        flexGrow: side ? 1 : 0,
                        backgroundColor: colors.surface.raised,
                        boxShadow: design.shadow.overlay,
                        borderCurve: 'continuous',
                        gap: design.space.md,
                      },
                      side
                        ? {
                            paddingTop: Math.max(insets.top, design.layout.edgeVertical),
                            borderTopLeftRadius: design.radius.xl,
                            borderBottomLeftRadius: design.radius.xl,
                          }
                        : {
                            paddingTop: design.space.sm,
                            borderTopLeftRadius: design.radius.xl,
                            borderTopRightRadius: design.radius.xl,
                          },
                      !side && dragStyle,
                    ]}>
                    <GestureDetector gesture={headerPan}>
                      <View style={[inset, { gap: design.space.md }]}>
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
                        {subtitle ? (
                          <Text variant="caption" tone="muted">
                            {subtitle}
                          </Text>
                        ) : null}
                      </View>
                    </GestureDetector>
                    <ScrollView
                      testID={testID ? `${testID}-options` : undefined}
                      style={{
                        flexGrow: side ? 1 : 0,
                        flexShrink: 1,
                        // Options scroll under the fixed title: a divider instead of a hard cut.
                        borderTopWidth: scrolls ? design.px(1) : 0,
                        borderTopColor: colors.border,
                      }}
                      contentContainerStyle={[
                        inset,
                        { paddingTop: ringRoom, paddingBottom: bottomEdge + ringRoom },
                      ]}
                      scrollEnabled={scrolls}
                      bounces={scrolls}
                      showsVerticalScrollIndicator={scrolls && !design.isTV}
                      snapToAlignment={design.isTV ? 'item' : undefined}
                      onLayout={(event) => setViewport(event.nativeEvent.layout.height)}
                      onContentSizeChange={(_, height) => setContent(height)}>
                      <FocusGuide
                        remember
                        trap={['up', 'down', 'left', 'right']}
                        role="radiogroup"
                        aria-label={title}
                        {...(Platform.OS === 'web' ? { onKeyDown: moveWebFocus } : null)}
                        style={{ gap: design.space.xs }}>
                        {/* TV: the focused option is centred as the list scrolls (clamped at the ends). */}
                        <ItemSnapContext value={design.isTV ? 'center' : undefined}>
                          {items.map((child, index) => (
                            <RovingContext
                              key={isValidElement(child) && child.key != null ? child.key : index}
                              value={{
                                tabStop: index === tabStop,
                                onFocus: () => setActive(index),
                              }}>
                              {child}
                            </RovingContext>
                          ))}
                        </ItemSnapContext>
                      </FocusGuide>
                    </ScrollView>
                  </Animated.View>
                </GestureDetector>
              </Animated.View>
            </>
          ) : null}
        </GestureHandlerRootView>
      </FocusLayer>
    </Modal>
  );
}

/** Web keyboard roving for custom Sheet options: pass the result to the option's Focusable. */
export function useSheetRoving(): { focusable?: boolean; onFocus?: () => void } {
  const roving = use(RovingContext);
  return Platform.OS === 'web' && roving
    ? { focusable: roving.tabStop, onFocus: roving.onFocus }
    : {};
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
  const roving = use(RovingContext);
  const radius = design.radius.md;
  const ref = useRef<View>(null);
  // Not hasTVPreferredFocus: set before the row is attached, it leaves rows below the viewport half-focused.
  useInitialFocus(ref, preferred);
  const web = Platform.OS === 'web' && roving;
  return (
    <Focusable
      ref={ref}
      role="radio"
      aria-checked={selected}
      accessibilityLabel={description ? `${label}, ${description}` : label}
      focusable={web ? roving.tabStop : undefined}
      onFocus={web ? roving.onFocus : undefined}
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
        <Text variant="body" style={{ fontFamily: selected ? fonts.bodySemiBold : fonts.body }}>
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
