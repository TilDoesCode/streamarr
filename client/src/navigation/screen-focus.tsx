import { useNavigation } from 'expo-router';
import { createContext, use, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { Platform, type View } from 'react-native';

import { FocusGuide, FocusMemoryContext, tvFocus, type FocusMemory } from '@/components/focus';
import { TVFocusHost, tvNativeAvailable } from '@modules/tv-native';

// A request can land before the screen's views are attached (first visit of a lazily mounted tab): retry until one reports focus.
export const RESTORE_ATTEMPTS = 10;
export const RESTORE_INTERVAL_MS = 120;
// tvOS keeps focus in the top tab bar while tabs switch and UIKit restores it on Back; a JS restore would pull it away.
const appleTV = () => Platform.OS === 'ios' && Platform.isTV;

// The screen a closed player returns to shows within this; a later screen focus must not take it.
export const RETURN_FOCUS_MS = 1500;
let returnFocusUntil = 0;

/** Apple TV: the screen a JS close returns to takes its focus back (UIKit restores only after native pops). */
export function requestReturnFocus(): void {
  if (appleTV()) returnFocusUntil = Date.now() + RETURN_FOCUS_MS;
}

/** The requester is gone (player unmounted): an unused request expires shortly instead of lingering. */
export function expireReturnFocus(withinMs = 300): void {
  returnFocusUntil = Math.min(returnFocusUntil, Date.now() + withinMs);
}

function takeReturnFocus(): boolean {
  const active = Date.now() <= returnFocusUntil;
  returnFocusUntil = 0;
  return active;
}

type ScreenFocusHost = {
  /** Registers the visible screen's restore; returns its unregister. */
  show: (restore: () => void) => () => void;
  /** True once after the shell asked the next visible screen to take focus. */
  takeFocusRequest: () => boolean;
  /** Moves focus to the rail's active tab (a screen's Back chain ends there). */
  focusRail: () => void;
};

const ScreenFocusHostContext = createContext<ScreenFocusHost | null>(null);

/** Provided by the TV shell around the tab content so the rail can hand focus to the visible screen. */
export const ScreenFocusProvider = ScreenFocusHostContext;

/** TV shell: the host for `ScreenFocusProvider` and the two ways the shell hands focus to the tab content. */
export function useScreenFocusHost() {
  const active = useRef<(() => void) | null>(null);
  const requested = useRef(false);
  const railActive = useRef<View | null>(null);
  const railByBack = useRef(false);
  const host = useMemo<ScreenFocusHost>(
    () => ({
      show: (restore) => {
        active.current = restore;
        return () => {
          if (active.current === restore) active.current = null;
        };
      },
      takeFocusRequest: () => {
        const value = requested.current;
        requested.current = false;
        return value;
      },
      focusRail: () => {
        railByBack.current = true;
        railActive.current?.requestTVFocus?.();
      },
    }),
    []
  );
  return useMemo(
    () => ({
      host,
      /** The rail's active tab node, set by the rail. */
      railActive,
      /** True while the rail holds the focus a screen's Back chain handed to it. */
      isRailByBack: () => railByBack.current,
      /** The rail lost focus: its next entry is no longer a screen's Back step. */
      railLeft: () => {
        railByBack.current = false;
      },
      /** Moves focus back into the visible screen (its last focused element, else its first). */
      focusActive: (): boolean => {
        const restore = active.current;
        restore?.();
        return !!restore;
      },
      /** The next screen that comes into view takes focus (after a tab switch from the rail). */
      focusNext: () => {
        requested.current = true;
      },
    }),
    [host]
  );
}

/** TV: focuses the shell rail's active tab; no-op outside the TV shell. */
export function useFocusRail(): () => void {
  const host = use(ScreenFocusHostContext);
  return () => host?.focusRail();
}

/** TV: each stack screen remembers its focused element and gets it back on return (Back lands on the opener). */
export function ScreenFocusScope({ children }: { children: ReactNode }) {
  const host = use(ScreenFocusHostContext);
  const ref = useRef<View>(null);
  const last = useRef<View | null>(null);
  // Counts focus reports from this screen's Focusables; a restore stops once it moves.
  const reports = useRef(0);
  const navigation = useNavigation();
  // JS memory: the native guide forgets its last child when a tab screen is detached and re-attached.
  const memory = useMemo<FocusMemory>(
    () => ({
      remember: (view) => {
        last.current = view;
        reports.current += 1;
      },
      forget: (view) => {
        if (last.current === view) last.current = null;
      },
      reset: () => {
        last.current = null;
      },
    }),
    []
  );

  useEffect(() => {
    const guide = ref.current;
    if (!Platform.isTV || !guide) return;
    // A screen mounted behind another one (deep link) has never been shown: treat it as hidden.
    let hidden = !navigation.isFocused();
    let frame: number | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cancel = () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
    const restore = () => {
      cancel();
      if (appleTV()) return;
      const seen = reports.current;
      let attempts = 0;
      const attempt = () => {
        if (reports.current !== seen) return;
        (last.current ?? guide).requestTVFocus?.();
        if (++attempts < RESTORE_ATTEMPTS) timer = setTimeout(attempt, RESTORE_INTERVAL_MS);
      };
      // A popped screen is re-attached during the transition; focus lands once it is in the window.
      frame = requestAnimationFrame(attempt);
    };
    let unregister: (() => void) | undefined;
    const enter = () => {
      unregister?.();
      unregister = host?.show(restore);
      if (appleTV() && takeReturnFocus()) {
        hidden = false;
        tvFocus(last.current ?? guide);
        return;
      }
      const requested = host?.takeFocusRequest() ?? false;
      if (!hidden && !requested) return;
      hidden = false;
      restore();
    };
    if (navigation.isFocused()) enter();
    const offFocus = navigation.addListener('focus', enter);
    const offBlur = navigation.addListener('blur', () => {
      hidden = true;
      cancel();
    });
    return () => {
      offFocus();
      offBlur();
      cancel();
      unregister?.();
    };
  }, [navigation, host]);

  if (!Platform.isTV) return children;
  const guide = (
    <FocusGuide ref={ref} remember collapsable={false} style={{ flex: 1 }}>
      {children}
    </FocusGuide>
  );
  return (
    <FocusMemoryContext value={memory}>
      {/* Apple TV: focus requests for this screen resolve inside its own host (after transitions too). */}
      {tvNativeAvailable ? <TVFocusHost style={{ flex: 1 }}>{guide}</TVFocusHost> : guide}
    </FocusMemoryContext>
  );
}
