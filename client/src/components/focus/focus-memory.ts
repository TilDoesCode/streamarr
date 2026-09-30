import { createContext } from 'react';
import type { View } from 'react-native';

/** TV: the element focused last inside a screen, so the screen can give it focus again (tab switches). */
export type FocusMemory = {
  remember: (view: View) => void;
  forget: (view: View) => void;
  /** Forgets the remembered element (its content was replaced). */
  reset?: () => void;
};

export const FocusMemoryContext = createContext<FocusMemory | null>(null);
