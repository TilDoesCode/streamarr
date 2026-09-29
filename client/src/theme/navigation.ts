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
