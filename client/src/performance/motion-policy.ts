import { useReducedMotion } from 'react-native-reanimated';

import { deviceWeakReason, useLiteMode } from './performance-mode';

/** Which effects run. Lite (weak TV hardware) keeps cheap UI-thread motion and drops the expensive effects. */
export type MotionPolicy = {
  /** Cards and buttons grow on focus: the spring (full UI), a short timing without overshoot (lite) or not at all. */
  focusLift: 'spring' | 'timing' | 'none';
  /** Largest focus scale of cards and buttons (lite keeps it small so rows need little room). */
  maxLift: number;
  /** Tinted shadow around the focus ring (blurred shadows are expensive on Mali GPUs). */
  focusGlow: boolean;
  /** The ring leaves a card at once instead of fading (only the focused card ever shows one). */
  ringInstantOut: boolean;
  /** Pressed cards and buttons shrink a little. */
  pressFeedback: boolean;
  /** Blurred artwork room behind screens (else the plain room colour). */
  ambientBackdrop: boolean;
  /** Skeletons pulse while loading (else they stay still). */
  skeletonPulse: boolean;
  /** Card artwork fades in when it loads. */
  imageFadeIn: boolean;
  /** Home's hero follows the focused card after it rested this long (ms). */
  heroRestMs: number;
  /** Crossfade of the lite hero's backdrop when its title changes (ms, 0 = cut). */
  heroCrossfadeMs: number;
  /** Rows scroll smoothly to the focused card or row (else they jump). */
  rowScroll: boolean;
  /** Every Reanimated animation jumps to its end (the system's animations are off). */
  reduceAll: boolean;
};

/** Full UI's focus scale bound; lite keeps cards at most this much larger. */
export const LITE_CARD_SCALE = 1.06;
/** Lite Home: the hero waits for focus to rest this long before it changes. */
export const LITE_HERO_REST_MS = 400;
// Full Home's hero settles after this pause (FeaturedStore's default).
const HERO_REST_MS = 150;

/** The effects for lite mode and the system's reduced-motion setting (animations off wins over everything). */
export function motionPolicy(lite: boolean, systemReduced: boolean): MotionPolicy {
  return {
    focusLift: systemReduced ? 'none' : lite ? 'timing' : 'spring',
    maxLift: lite ? LITE_CARD_SCALE : Infinity,
    focusGlow: !lite,
    ringInstantOut: lite,
    pressFeedback: !systemReduced,
    ambientBackdrop: !lite,
    skeletonPulse: !lite && !systemReduced,
    imageFadeIn: !lite && !systemReduced,
    heroRestMs: lite ? LITE_HERO_REST_MS : HERO_REST_MS,
    heroCrossfadeMs: systemReduced ? 0 : lite ? 250 : 0,
    rowScroll: !systemReduced,
    reduceAll: systemReduced,
  };
}

const POLICIES = [
  [motionPolicy(false, false), motionPolicy(false, true)],
  [motionPolicy(true, false), motionPolicy(true, true)],
] as const;

/** Removed system animations (developer options / accessibility) count as reduced motion everywhere. */
export const systemAnimationsOff = deviceWeakReason === 'animationsOff';

/** This device's motion policy; follows the performance setting and the system's reduced motion live. */
export function useMotionPolicy(): MotionPolicy {
  const lite = useLiteMode();
  const reduced = useReducedMotion() || systemAnimationsOff;
  return POLICIES[lite ? 1 : 0][reduced ? 1 : 0];
}
