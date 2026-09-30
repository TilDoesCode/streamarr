import { useFonts } from 'expo-font';

import { FONT_ASSETS } from './font-assets';

export function useAppFonts(): boolean {
  const [loaded, error] = useFonts(FONT_ASSETS);
  return loaded || error != null;
}
