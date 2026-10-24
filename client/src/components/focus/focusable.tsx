import { createContext, use, useEffect, useRef, type ReactNode, type Ref } from 'react';
import {
  Platform,
  Pressable,
  type GestureResponderEvent,
  type PointerEvent,
  type PressableProps,
  type StyleProp,
  type View,
  type ViewStyle,
} from 'react-native';
import Animated, {
  Easing,
  useAnimatedReaction,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withSpring,
  withTiming,
  type DerivedValue,
  type SharedValue,
} from 'react-native-reanimated';

import { withAlpha } from '@/lib/color';
import { useMotionPolicy } from '@/performance';
import { colors, easing, motion, springs, theme, useDesign } from '@/theme';

import { FocusLayerContext, focusTopLayer } from './focus-layer';
import { FocusMemoryContext } from './focus-memory';
import { ItemSnapContext } from './focus-section';

export type FocusLiftKind = 'card' | 'button' | 'none';

type FocusState = {
  /** Remote/keyboard focus; 0 while an overlay above this Focusable is open. */
  focus: DerivedValue<number>;
  /** Whether it holds focus now (0 or 1, no animation); `focus` may still be fading towards it. */
  focused: DerivedValue<number>;
  pressed: SharedValue<number>;
  hover: SharedValue<number>;
};

const FocusStateContext = createContext<FocusState | null>(null);

const EASE_OUT = Easing.bezier(...easing.out);

// Web: our ring replaces the browser focus outline (RN's types lack 'none'; react-native-web accepts it).
const NO_OUTLINE = { outlineStyle: 'none' } as unknown as ViewStyle;

// Web hover shows the ring at reduced strength (Aurora: 2 px ring on hover, full ring on keyboard focus).
const HOVER_RING = 0.7;

// Web: react-native-web activates only buttons with Space; these roles expect it too (WAI-ARIA).
const SPACE_ROLES: ReadonlySet<string> = new Set(['radio', 'checkbox', 'switch']);

/** Shared values (0..1) of the nearest Focusable: focus (remote/keyboard), pressed, hover (web). */
export function useFocusState(): FocusState {
  const state = use(FocusStateContext);
  if (!state) throw new Error('useFocusState must be used inside <Focusable>');
  return state;
}

function isKeyboardFocus(event: unknown): boolean {
  // Touch phones/tablets: programmatic or tap focus never shows a ring (no D-pad there).
  if (Platform.OS !== 'web') return Platform.isTV;
  const target = (event as { currentTarget?: { matches?: (selector: string) => boolean } })
    ?.currentTarget;
  try {
    return target?.matches?.(':focus-visible') ?? true;
  } catch {
    return true;
  }
}

export type FocusableProps = Omit<PressableProps, 'style' | 'children'> & {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  /** Gallery/screenshots: render a static focused or pressed state (not focusable). */
  previewState?: 'focused' | 'pressed';
  ref?: Ref<View>;
};

/** Pressable whose remote/keyboard focus, press and hover states animate on the UI thread; place a FocusLift inside. */
export function Focusable({
  children,
  style,
  previewState,
  disabled,
  focusable,
  hasTVPreferredFocus,
  onFocus,
  onBlur,
  onPressIn,
  onPressOut,
  onHoverIn,
  onHoverOut,
  ref,
  ...props
}: FocusableProps) {
  const rawFocus = useSharedValue(previewState === 'focused' ? 1 : 0);
  const rawFocused = useSharedValue(previewState === 'focused' ? 1 : 0);
  const pressed = useSharedValue(previewState === 'pressed' ? 1 : 0);
  const hover = useSharedValue(0);
  const layer = use(FocusLayerContext);
  const topLayer = focusTopLayer();
  const focus = useDerivedValue(
    () => (topLayer.get() > layer ? 0 : rawFocus.get()),
    [layer, topLayer]
  );
  const focused = useDerivedValue(
    () => (topLayer.get() > layer ? 0 : rawFocused.get()),
    [layer, topLayer]
  );
  const snapAlign = use(ItemSnapContext);
  const memory = use(FocusMemoryContext);
  const remembered = useRef<View | null>(null);
  const animate = (value: SharedValue<number>, to: number, duration: number) =>
    value.set(withTiming(to, { duration, easing: EASE_OUT }));

  useEffect(() => {
    if (!previewState) return;
    rawFocus.set(previewState === 'focused' ? 1 : 0);
    rawFocused.set(previewState === 'focused' ? 1 : 0);
    pressed.set(previewState === 'pressed' ? 1 : 0);
  }, [previewState, rawFocus, rawFocused, pressed]);

  useEffect(() => {
    const slot = remembered;
    return () => {
      if (slot.current) memory?.forget(slot.current);
    };
  }, [memory]);

  const isDisabled = !!disabled;
  const canFocus = !isDisabled && !previewState && focusable !== false;
  const spaceActivates =
    Platform.OS === 'web' && !!props.onPress && SPACE_ROLES.has(String(props.role));
  const webKeys = spaceActivates
    ? {
        onKeyDown: (event: { key: string; preventDefault: () => void }) => {
          if (event.key !== ' ' || isDisabled) return;
          event.preventDefault();
          props.onPress?.(event as unknown as GestureResponderEvent);
        },
      }
    : undefined;

  const hoverIn: PressableProps['onHoverIn'] = (event) => {
    animate(hover, 1, motion.focus);
    onHoverIn?.(event);
  };
  const hoverOut: PressableProps['onHoverOut'] = (event) => {
    animate(hover, 0, motion.focus);
    onHoverOut?.(event);
  };
  // iPad pointer: Pressable's hover is web-only on iOS; pointer events (modules/pointer-events) carry it.
  const pointerHover =
    Platform.OS === 'ios' && !Platform.isTV
      ? {
          onPointerEnter: (event: PointerEvent) => {
            if (event.nativeEvent.pointerType === 'mouse') hoverIn(event as never);
          },
          onPointerLeave: (event: PointerEvent) => {
            if (event.nativeEvent.pointerType === 'mouse') hoverOut(event as never);
          },
        }
      : undefined;

  return (
    <FocusStateContext value={{ focus, focused, pressed, hover }}>
      <Pressable
        ref={ref}
        disabled={isDisabled || !!previewState}
        focusable={canFocus}
        // Web: react-native-web's Pressable ignores `focusable` and makes every enabled press target a Tab stop.
        tabIndex={Platform.OS === 'web' ? (canFocus ? 0 : -1) : undefined}
        hasTVPreferredFocus={Platform.isTV && canFocus ? hasTVPreferredFocus : undefined}
        scrollSnapAlign={snapAlign}
        aria-disabled={isDisabled}
        style={[Platform.OS === 'web' && NO_OUTLINE, style]}
        onFocus={(event) => {
          if (isKeyboardFocus(event)) {
            rawFocused.set(1);
            animate(rawFocus, 1, motion.focus);
          }
          if (memory) {
            remembered.current = event.currentTarget as unknown as View;
            memory.remember(remembered.current);
          }
          onFocus?.(event);
        }}
        onBlur={(event) => {
          rawFocused.set(0);
          animate(rawFocus, 0, motion.focus);
          onBlur?.(event);
        }}
        onPressIn={(event) => {
          animate(pressed, 1, motion.press);
          onPressIn?.(event);
        }}
        onPressOut={(event) => {
          animate(pressed, 0, motion.press);
          onPressOut?.(event);
        }}
        onHoverIn={hoverIn}
        onHoverOut={hoverOut}
        {...pointerHover}
        {...webKeys}
        {...props}>
        {children}
      </Pressable>
    </FocusStateContext>
  );
}

export type FocusLiftProps = {
  kind?: FocusLiftKind;
  radius?: number;
  /** Title tint for the focus glow (Aurora); defaults to the neutral accent glow. */
  tint?: string | null;
  /** Overrides the kind's focus scale (large-shell cards that must stay clear of their neighbours). */
  scale?: number;
  /** Receives the ring strength (0..1) instead of drawing the ring, for a parent box that wraps more than this Focusable. */
  ringTo?: SharedValue<number>;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
};

const GLOW_BLUR = 24;

/** Room a scroll container needs around a focused FocusLift so its ring and glow are never clipped. */
export function useFocusGlowRoom(): number {
  const design = useDesign();
  return design.focus.ringOffset + design.focus.ringWidth + design.px(GLOW_BLUR * 0.75);
}

/** Ring strength for one frame; with `instantOut` it drops the moment focus leaves, so no fading ring trails a quick move. */
export function ringStrength(
  focus: number,
  focused: number,
  hover: number,
  instantOut: boolean
): number {
  'worklet';
  if (instantOut && focused === 0 && hover === 0) return 0;
  return Math.max(focus, hover);
}

/** Timed lift (lite): the scale follows the eased focus value, so it can never overshoot or lag behind a newer move. */
export function timedLift(focus: number, hover: number, lift: number): number {
  'worklet';
  return 1 + (lift - 1) * Math.min(1, Math.max(0, focus, hover));
}

/** Lift + white ring + tinted glow for the nearest Focusable (TV focus, web hover and keyboard focus, press); useMotionPolicy picks spring, timing or none. */
export function FocusLift({
  kind = 'card',
  radius = 0,
  tint,
  scale,
  ringTo,
  style,
  children,
}: FocusLiftProps) {
  const { focus, focused, pressed, hover } = useFocusState();
  const design = useDesign();
  const policy = useMotionPolicy();
  const mode = policy.focusLift;
  const instantOut = policy.ringInstantOut;
  const pressFeedback = policy.pressFeedback;
  const liftScale = Math.min(
    policy.maxLift,
    scale ??
      (kind === 'card' ? design.focus.cardScale : kind === 'button' ? design.focus.buttonScale : 1)
  );
  const pressedScale = design.focus.pressedScale;
  // Buttons wider than the focus token's extent lift less, so their growth never eats the row's clearance.
  const growthCap = kind === 'button' && scale == null ? design.focus.buttonGrowth : null;
  const liftWidth = useSharedValue(0);
  const hoverWeight = Platform.OS === 'web' ? 1 : 0;

  const liftStyle = useAnimatedStyle(() => {
    const w = liftWidth.get();
    const lift =
      growthCap != null && w > 0 ? Math.min(liftScale, 1 + (2 * growthCap) / w) : liftScale;
    const press = pressFeedback ? 1 - (1 - pressedScale) * pressed.get() : 1;
    if (mode === 'timing')
      return {
        transform: [{ scale: timedLift(focus.get(), hover.get() * hoverWeight, lift) * press }],
      };
    const raised = Math.max(focus.get() > 0.5 ? 1 : 0, hover.get() > 0.5 ? hoverWeight : 0);
    const target = mode === 'spring' ? 1 + (lift - 1) * raised : 1;
    return { transform: [{ scale: withSpring(target, springs.focus) }, { scale: press }] };
  }, [mode, pressFeedback, liftScale, pressedScale, hoverWeight, growthCap]);
  const ringStyle = useAnimatedStyle(
    () => ({
      opacity: ringStrength(
        focus.get(),
        focused.get(),
        hover.get() * hoverWeight * HOVER_RING,
        instantOut
      ),
    }),
    [hoverWeight, instantOut]
  );
  useAnimatedReaction(
    () =>
      ringStrength(focus.get(), focused.get(), hover.get() * hoverWeight * HOVER_RING, instantOut),
    (value) => ringTo?.set(value),
    [ringTo, hoverWeight, instantOut]
  );

  const offset = design.focus.ringOffset;
  // Lite rings are at least 2 px: without the glow the ring alone marks focus.
  const width = policy.focusGlow
    ? design.focus.ringWidth
    : Math.max(design.focus.ringWidth, design.px(2));
  const glow = !policy.focusGlow
    ? undefined
    : tint && theme !== 'streamybox'
      ? `0 0 ${design.px(kind === 'button' ? 18 : GLOW_BLUR)}px ${withAlpha(tint, 0.55)}`
      : design.shadow.glow;
  return (
    <Animated.View
      style={[style, liftStyle]}
      onLayout={
        growthCap == null ? undefined : (event) => liftWidth.set(event.nativeEvent.layout.width)
      }>
      {children}
      {ringTo ? null : (
        <Animated.View
          style={[
            {
              pointerEvents: 'none',
              position: 'absolute',
              top: -offset - width,
              left: -offset - width,
              right: -offset - width,
              bottom: -offset - width,
              borderRadius: radius > 0 ? radius + offset + width : 0,
              borderWidth: width,
              borderColor: colors.focus.DEFAULT,
              borderCurve: 'continuous',
              boxShadow: glow,
            },
            ringStyle,
          ]}
        />
      )}
    </Animated.View>
  );
}
