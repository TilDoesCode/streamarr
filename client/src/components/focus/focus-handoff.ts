import { useEffect, useRef, type RefObject } from 'react';
import type { View } from 'react-native';

import { useDesign } from '@/theme';

import { tvFocus } from './tv-focus';

/** A blur this close before the control vanished still counts as its focus (Android may blur before unmount). */
export const HANDOFF_WINDOW_MS = 300;

/** TV: a focused control that vanishes hands the focus to `fallback`, not to its neighbour (Delete). */
export function useFocusHandoff(present: boolean, fallback: RefObject<View | null>) {
  const { isTV } = useDesign();
  const focused = useRef(false);
  const leftAt = useRef(0);
  const before = useRef(present);
  useEffect(() => {
    const was = before.current;
    before.current = present;
    if (!isTV || !was || present) return;
    if (!focused.current && Date.now() - leftAt.current > HANDOFF_WINDOW_MS) return;
    focused.current = false;
    tvFocus(fallback.current);
  }, [present, isTV, fallback]);
  return {
    onFocus: () => {
      focused.current = true;
    },
    onBlur: () => {
      focused.current = false;
      leftAt.current = Date.now();
    },
  };
}
