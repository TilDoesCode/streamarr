import { requireNativeView, requireOptionalNativeModule } from 'expo';
import type { ComponentType } from 'react';
import { Platform, View, type ViewProps } from 'react-native';

/** `always`: Menu goes to JS; `tabBar`: only while the tab bar holds focus; `observe`: dev probe, UIKit unchanged. */
export type MenuMode = 'always' | 'tabBar' | 'observe';

/** `cancelled`: a newer request or the user's own move replaced it, so nobody may fall back to the old target. */
export type FocusResult = 'focused' | 'missed' | 'cancelled';

type TVNativeModule = {
  setMenuMode(mode: MenuMode | null): void;
  resetMenu(): void;
  lastMenuInTabBar(): boolean;
  focus(tag: number): Promise<FocusResult | boolean>;
  popToScreen(identifier: string, count: number): Promise<boolean>;
  debugFocus?(tag?: number | null): Promise<Record<string, unknown>>;
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

/** Switches the native Menu gate off (app start: a reloaded bundle has no claims). */
export function resetMenu(): void {
  native?.resetMenu?.();
}

/** Whether focus was in the tab bar when the Menu press now being handled arrived. */
export function lastMenuInTabBar(): boolean {
  return native?.lastMenuInTabBar?.() ?? false;
}

/** Resolves where the focus request ended (null without the module). */
export function focusView(tag: number): Promise<FocusResult> | null {
  if (!native) return null;
  return native.focus(tag).then(
    (result) => (result === true ? 'focused' : result === false ? 'missed' : result),
    () => 'missed' as const
  );
}

/** Pops the native stack to the page that holds `testID` with `count` pages above it (null without the module). */
export function popToScreen(testID: string, count: number): Promise<boolean> | null {
  return native ? native.popToScreen(testID, count).catch(() => false) : null;
}

/** Dev builds only: focus chain, controller tree and Menu recognisers (null in release). */
export function debugFocus(tag?: number | null): Promise<Record<string, unknown>> | null {
  return native?.debugFocus ? native.debugFocus(tag ?? null) : null;
}

/** Screen and sheet root on Apple TV: a pending focus target is handed to UIKit's next focus update inside it. */
export const TVFocusHost: ComponentType<ViewProps> = native
  ? requireNativeView<ViewProps>('TVNative')
  : View;

if (__DEV__ && native) {
  (globalThis as { __tvNative?: object }).__tvNative = { debugFocus, setMenuMode, focusView };
}
