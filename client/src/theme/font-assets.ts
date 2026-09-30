import { fonts } from './tokens';

/** The bundled OFL faces, keyed by the family name the type ramp uses. */
export const FONT_ASSETS: Record<(typeof fonts)[keyof typeof fonts], number> = {
  [fonts.displayBold]: require('../../assets/fonts/Outfit-Bold.ttf'),
  [fonts.display]: require('../../assets/fonts/Outfit-SemiBold.ttf'),
  [fonts.body]: require('../../assets/fonts/Figtree-Regular.ttf'),
  [fonts.bodyMedium]: require('../../assets/fonts/Figtree-Medium.ttf'),
  [fonts.bodySemiBold]: require('../../assets/fonts/Figtree-SemiBold.ttf'),
  [fonts.bodyBold]: require('../../assets/fonts/Figtree-Bold.ttf'),
  [fonts.mono]: require('../../assets/fonts/JetBrainsMono-Medium.ttf'),
};
