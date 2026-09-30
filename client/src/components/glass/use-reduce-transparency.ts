import { useEffect, useState } from 'react';
import { AccessibilityInfo, Platform } from 'react-native';

/** iOS Reduce Transparency (other native platforms have no such setting). */
export function useReduceTransparency(): boolean {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    let active = true;
    AccessibilityInfo.isReduceTransparencyEnabled().then((value) => {
      if (active) setEnabled(value);
    });
    const subscription = AccessibilityInfo.addEventListener(
      'reduceTransparencyChanged',
      setEnabled
    );
    return () => {
      active = false;
      subscription.remove();
    };
  }, []);
  return enabled;
}
