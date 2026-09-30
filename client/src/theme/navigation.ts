import { DarkTheme, type Theme } from 'expo-router/react-navigation';

import { colors } from './tokens';

export const NAV_THEME: Theme = {
  ...DarkTheme,
  colors: {
    background: colors.background,
    border: colors.border,
    card: colors.surface.DEFAULT,
    notification: colors.destructive.DEFAULT,
    primary: colors.accent.DEFAULT,
    text: colors.foreground.DEFAULT,
  },
};

/** Inside the large-screen shell: scene containers stay clear so the ambient backdrop shows through. */
export const SHELL_NAV_THEME: Theme = {
  ...NAV_THEME,
  colors: { ...NAV_THEME.colors, background: colors.scrim.clear },
};
