import { useEffect } from 'react';
import { BackHandler, Platform } from 'react-native';

import { setMenuMode, type MenuMode } from '@modules/tv-native';

/** `native`: an RN Modal (own Menu recogniser) is open, so the gate stays off whatever else claims. */
export type MenuClaim = MenuMode | 'native';

const appleTV = () => Platform.OS === 'ios' && Platform.isTV;
const STRENGTH: Record<MenuClaim, number> = { observe: 0, tabBar: 1, always: 2, native: 3 };
const claims: { mode: MenuClaim }[] = [];
let suspended = false;

/** The strongest claim decides; null when nothing claims or a Menu reached no handler. */
export function currentMenuMode(): MenuMode | null {
  if (suspended || claims.length === 0) return null;
  const top = claims.reduce((best, claim) =>
    STRENGTH[claim.mode] > STRENGTH[best.mode] ? claim : best
  );
  return top.mode === 'native' ? null : top.mode;
}

function apply() {
  setMenuMode(currentMenuMode());
}

/** Hands Apple TV's Menu to the BackHandler chain until the returned release runs. */
export function claimMenu(mode: MenuClaim): () => void {
  const claim = { mode };
  claims.push(claim);
  suspended = false;
  apply();
  return () => {
    const index = claims.indexOf(claim);
    if (index >= 0) claims.splice(index, 1);
    suspended = false;
    apply();
  };
}

export function useMenuClaim(mode: MenuClaim | null): void {
  useEffect(() => {
    if (!appleTV() || !mode) return;
    return claimMenu(mode);
  }, [mode]);
}

// Lowest priority (registered first): a claimed Menu that nobody handled lets the next one go to tvOS.
if (appleTV()) {
  BackHandler.addEventListener('hardwareBackPress', () => {
    if (currentMenuMode() === null) return false;
    suspended = true;
    apply();
    return false;
  });
}
