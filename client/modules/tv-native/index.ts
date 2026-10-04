import { requireNativeView, requireOptionalNativeModule } from 'expo';
import type { ComponentType } from 'react';
import { Platform, View, type ViewProps } from 'react-native';

/** `always`: Menu goes to JS; `tabBar`: only while the tab bar holds focus; `observe`: probe, UIKit unchanged. */
export type MenuMode = 'always' | 'tabBar' | 'observe';

type TVNativeModule = {
  setMenuMode(mode: MenuMode | null): void;
  focus(tag: number): Promise<boolean>;
  debugFocus(tag?: number | null): Promise<Record<string, unknown>>;
  popToScreen(identifier: string): Promise<boolean>;
};

// Apple TV only; phones, Android, web and older tvOS builds without the module keep React Native's behaviour.
const native =
  Platform.OS === 'ios' && Platform.isTV
    ? requireOptionalNativeModule<TVNativeModule>('TVNative')
    : null;

export const tvNativeAvailable = native !== null;

export function setMenuMode(mode: MenuMode | null): void {
  native?.setMenuMode(mode);
}

/** Resolves whether focus landed on the view (null without the module). */
export function focusView(tag: number): Promise<boolean> | null {
  return native ? native.focus(tag).catch(() => false) : null;
}

/** Pops the native stack to the page that holds `testID` (null without the module). */
export function popToScreen(testID: string): Promise<boolean> | null {
  return native ? native.popToScreen(testID).catch(() => false) : null;
}

export function debugFocus(tag?: number | null): Promise<Record<string, unknown>> | null {
  return native ? native.debugFocus(tag ?? null) : null;
}

/** Screen and sheet root on Apple TV: a pending focus target is handed to UIKit's next focus update inside it. */
export const TVFocusHost: ComponentType<ViewProps> = native
  ? requireNativeView<ViewProps>('TVNative')
  : View;

// Probe hooks for debugger-evaluate (Apple TV only).
if (native) {
  (globalThis as { __tvNative?: object }).__tvNative = { debugFocus, setMenuMode, focusView };
}
