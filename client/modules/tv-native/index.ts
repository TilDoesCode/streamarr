import { requireNativeView, requireOptionalNativeModule } from 'expo';
import type { ComponentType } from 'react';
import { Platform, View, type ViewProps } from 'react-native';

/** `always`: Menu goes to JS; `tabBar`: only while the tab bar holds focus; `observe`: probe, UIKit unchanged. */
export type MenuMode = 'always' | 'tabBar' | 'observe';

type TVNativeModule = {
  setMenuMode(mode: MenuMode | null): void;
  focus(tag: number): Promise<boolean>;
  attachTabBarScroll(tag: number): Promise<boolean>;
  detachTabBarScroll(tag: number): Promise<void>;
  debugFocus(tag?: number | null): Promise<Record<string, unknown>>;
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

export function attachTabBarScroll(tag: number): void {
  native?.attachTabBarScroll(tag).catch(() => undefined);
}

export function detachTabBarScroll(tag: number): void {
  native?.detachTabBarScroll(tag).catch(() => undefined);
}

export function debugFocus(tag?: number | null): Promise<Record<string, unknown>> | null {
  return native ? native.debugFocus(tag ?? null) : null;
}

/** Screen and sheet root on Apple TV: a pending focus target is handed to UIKit's next focus update inside it. */
export const TVFocusHost: ComponentType<ViewProps> = native
  ? requireNativeView<ViewProps>('TVNative')
  : View;

// Probe hooks for debugger-evaluate (I4 S2).
if (__DEV__ && native) {
  (globalThis as { __tvNative?: object }).__tvNative = { debugFocus, setMenuMode, focusView };
}
