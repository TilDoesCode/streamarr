import { createContext, useContext } from 'react';
import type { View } from 'react-native';

/** Scrolls a focused element (with its ring) fully into the enclosing screen's title-safe area. */
export const ScrollRevealContext = createContext<(node: View | null) => void>(() => {});

export function useScrollReveal() {
  return useContext(ScrollRevealContext);
}
