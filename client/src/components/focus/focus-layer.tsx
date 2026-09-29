import { createContext, use, useEffect, type ReactNode } from 'react';
import { makeMutable, type SharedValue } from 'react-native-reanimated';

// Android keeps the trigger focused (no blur) under a Modal, so overlays hide the focus visuals below them.
export const FocusLayerContext = createContext(0);

let topLayer: SharedValue<number> | undefined;
// Layer of every open overlay; siblings share a layer, so this is a multiset.
const openLayers: number[] = [];

/** Layer number of the top-most open overlay (0 = the screen). */
export function focusTopLayer(): SharedValue<number> {
  topLayer ??= makeMutable(0);
  return topLayer;
}

function publish() {
  const top = openLayers.length ? Math.max(...openLayers) : 0;
  if (focusTopLayer().get() !== top) focusTopLayer().set(top);
}

/** Wraps an overlay's content (Dialog, Sheet); while open, focus visuals of the layers below are hidden. */
export function FocusLayer({ open, children }: { open: boolean; children: ReactNode }) {
  const layer = use(FocusLayerContext) + 1;
  useEffect(() => {
    if (!open) return;
    openLayers.push(layer);
    publish();
    return () => {
      openLayers.splice(openLayers.indexOf(layer), 1);
      publish();
    };
  }, [open, layer]);
  return <FocusLayerContext value={layer}>{children}</FocusLayerContext>;
}
