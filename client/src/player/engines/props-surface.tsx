import { memo, useSyncExternalStore, type ComponentType, type ReactNode } from 'react';

import type { PropsStore } from './base';
import type { SurfaceProps } from './types';

/** Surface of a prop-driven native player view: re-renders only when the engine's store changes. */
export function createPropsSurface<T>(
  store: PropsStore<T>,
  render: (props: T, style: SurfaceProps['style'], fit: SurfaceProps['fit']) => ReactNode
): ComponentType<SurfaceProps> {
  function PropsSurface({ style, fit }: SurfaceProps) {
    const props = useSyncExternalStore(store.subscribe, store.get);
    return render(props, style, fit);
  }
  return memo(PropsSurface);
}
