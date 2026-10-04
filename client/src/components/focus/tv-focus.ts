import { useCallback, useRef, type Ref } from 'react';
import { findNodeHandle, Platform } from 'react-native';

import { focusView, tvNativeAvailable } from '@modules/tv-native';

type TVFocusTarget = { requestTVFocus?: () => void } | null | undefined;

const appleTV = () => Platform.OS === 'ios' && Platform.isTV;

/** TV focus request; on Apple TV through the focus system, so views in presented sheets and after transitions get it. */
export function tvFocus(target: TVFocusTarget): void {
  if (!target) return;
  if (appleTV() && tvNativeAvailable) {
    const tag = findNodeHandle(target as Parameters<typeof findNodeHandle>[0]);
    const landed = tag == null ? null : focusView(tag);
    if (landed) {
      void landed.then((ok) => ok || target.requestTVFocus?.());
      return;
    }
  }
  target.requestTVFocus?.();
}

function assignRef<T>(ref: Ref<T> | undefined, node: T | null) {
  if (typeof ref === 'function') ref(node);
  else if (ref) ref.current = node;
}

/** Apple TV: focuses each main node as it attaches (hasTVPreferredFocus misses it after a transition); forwards `ref`. */
export function useTvPreferredFocus<T extends NonNullable<TVFocusTarget>>(
  enabled: boolean,
  ref?: Ref<T>
): (node: T | null) => void {
  const last = useRef<T | null>(null);
  return useCallback(
    (node: T | null) => {
      assignRef(ref, node);
      if (!appleTV() || !enabled || !node || node === last.current) return;
      last.current = node;
      requestAnimationFrame(() => tvFocus(node));
    },
    [enabled, ref]
  );
}
