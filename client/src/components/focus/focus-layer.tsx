import { createContext, use, useEffect, type ReactNode } from 'react';
import { makeMutable, type SharedValue } from 'react-native-reanimated';

// Android keeps the trigger focused (no blur) under a Modal, so overlays hide the focus visuals below them.
export const FocusLayerContext = createContext(0);

let topLayer: SharedValue<number> | undefined;

/** Layer number of the top-most open overlay (0 = the screen). */
export function focusTopLayer(): SharedValue<number> {
  topLayer ??= makeMutable(0);
  return topLayer;
}

/** Wraps an overlay's content (Dialog, Sheet); while open, focus visuals of the layers below are hidden. */
export function FocusLayer({ open, children }: { open: boolean; children: ReactNode }) {
  const layer = use(FocusLayerContext) + 1;
  useEffect(() => {
    if (!open) return;
    const top = focusTopLayer();
    top.set(layer);
    return () => top.set(layer - 1);
  }, [open, layer]);
  return <FocusLayerContext value={layer}>{children}</FocusLayerContext>;
}
