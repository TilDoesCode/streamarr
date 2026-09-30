import { createContext, use, useEffect, useRef, type ReactNode, type Ref } from 'react';
import {
  Platform,
  Pressable,
  type GestureResponderEvent,
  type PressableProps,
  type StyleProp,
  type View,
  type ViewStyle,
} from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useDerivedValue,
  useReducedMotion,
  useSharedValue,
  withTiming,
  type DerivedValue,
  type SharedValue,
} from 'react-native-reanimated';

import { colors, easing, motion, useDesign } from '@/theme';

import { FocusLayerContext, focusTopLayer } from './focus-layer';
import { FocusMemoryContext } from './focus-memory';
import { ItemSnapContext } from './focus-section';

export type FocusLiftKind = 'card' | 'button' | 'none';

type FocusState = {
  /** Remote/keyboard focus; 0 while an overlay above this Focusable is open. */
  focus: DerivedValue<number>;
  pressed: SharedValue<number>;
  hover: SharedValue<number>;
};

const FocusStateContext = createContext<FocusState | null>(null);

const EASE_OUT = Easing.bezier(...easing.out);

// Web: our ring replaces the browser focus outline (RN's types lack 'none'; react-native-web accepts it).
const NO_OUTLINE = { outlineStyle: 'none' } as unknown as ViewStyle;

// Web: react-native-web activates only buttons with Space; these roles expect it too (WAI-ARIA).
const SPACE_ROLES: ReadonlySet<string> = new Set(['radio', 'checkbox', 'switch']);

/** Shared values (0..1) of the nearest Focusable: focus (remote/keyboard), pressed, hover (web). */
export function useFocusState(): FocusState {
  const state = use(FocusStateContext);
  if (!state) throw new Error('useFocusState must be used inside <Focusable>');
  return state;
}

function isKeyboardFocus(event: unknown): boolean {
  if (Platform.OS !== 'web') return true;
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
  const pressed = useSharedValue(previewState === 'pressed' ? 1 : 0);
  const hover = useSharedValue(0);
  const layer = use(FocusLayerContext);
  const topLayer = focusTopLayer();
  const focus = useDerivedValue(
    () => (topLayer.get() > layer ? 0 : rawFocus.get()),
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
    pressed.set(previewState === 'pressed' ? 1 : 0);
  }, [previewState, rawFocus, pressed]);

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

  return (
    <FocusStateContext value={{ focus, pressed, hover }}>
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
          if (isKeyboardFocus(event)) animate(rawFocus, 1, motion.focus);
          if (memory) {
            remembered.current = event.currentTarget as unknown as View;
            memory.remember(remembered.current);
          }
          onFocus?.(event);
        }}
        onBlur={(event) => {
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
        onHoverIn={(event) => {
          animate(hover, 1, motion.focus);
          onHoverIn?.(event);
        }}
        onHoverOut={(event) => {
          animate(hover, 0, motion.focus);
          onHoverOut?.(event);
        }}
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
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
};

/** Scale + focus ring for the nearest Focusable. Put it around the part that should lift. */
export function FocusLift({ kind = 'card', radius = 0, style, children }: FocusLiftProps) {
  const { focus, pressed, hover } = useFocusState();
  const design = useDesign();
  const reduced = useReducedMotion();
  const liftScale =
    kind === 'card' ? design.focus.cardScale : kind === 'button' ? design.focus.buttonScale : 1;
  const pressedScale = design.focus.pressedScale;
  const hoverWeight = Platform.OS === 'web' ? 0.6 : 0;

  const liftStyle = useAnimatedStyle(() => {
    const raised = Math.max(focus.get(), hover.get() * hoverWeight);
    const scale = reduced ? 1 : 1 + (liftScale - 1) * raised;
    const press = reduced ? 1 : 1 - (1 - pressedScale) * pressed.get();
    return { transform: [{ scale: scale * press }] };
  }, [reduced, liftScale, pressedScale, hoverWeight]);
  const ringStyle = useAnimatedStyle(() => ({ opacity: focus.get() }));

  const offset = design.focus.ringOffset;
  const width = design.focus.ringWidth;
  return (
    <Animated.View style={[style, liftStyle]}>
      {children}
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
            boxShadow: design.shadow.glow,
          },
          ringStyle,
        ]}
      />
    </Animated.View>
  );
}
