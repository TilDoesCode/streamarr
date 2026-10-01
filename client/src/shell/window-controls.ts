import { Dimensions, Platform, useWindowDimensions } from 'react-native';

type Size = { width: number; height: number };

/** iPadOS draws its window controls over the top-leading corner of a resized window; the safe area ignores them. */
export function windowControlsInset(ipad: boolean, window: Size, screen: Size): number {
  if (!ipad) return 0;
  const windowed = window.width < screen.width - 1 || window.height < screen.height - 1;
  return windowed ? 30 : 0;
}

export function useWindowControlsInset(): number {
  const window = useWindowDimensions();
  const ipad = Platform.OS === 'ios' && Platform.isPad && !Platform.isTV;
  return windowControlsInset(ipad, window, Dimensions.get('screen'));
}
