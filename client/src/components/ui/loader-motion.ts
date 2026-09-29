import { createContext } from 'react';

/** Lets a subtree pause infinite loader animations (Android UI automation needs an idle screen). */
export const LoaderMotionContext = createContext(true);
