import { useEffect, useEffectEvent } from 'react';
import { BackHandler } from 'react-native';

/** Android/Google TV back and tvOS menu. Return true when handled; false lets navigation go back. */
export function useBackHandler(handler: () => boolean, enabled = true): void {
  const onBack = useEffectEvent(handler);
  useEffect(() => {
    if (!enabled) return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => onBack());
    return () => subscription.remove();
  }, [enabled]);
}
