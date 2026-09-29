import * as SecureStore from 'expo-secure-store';

import { parseTokens, type TokenVault } from './types';

const key = (accountId: string) => `streamarr.tokens.${accountId}`;
const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

/** Native: Keychain (iOS/tvOS) and Keystore-encrypted storage (Android). */
export const tokenVault: TokenVault = {
  async get(accountId) {
    try {
      return parseTokens(await SecureStore.getItemAsync(key(accountId), OPTIONS));
    } catch {
      // Undecryptable after a restore to another device: treat as signed out.
      return null;
    }
  },
  set: (accountId, tokens) =>
    SecureStore.setItemAsync(key(accountId), JSON.stringify(tokens), OPTIONS),
  remove: (accountId) => SecureStore.deleteItemAsync(key(accountId), OPTIONS),
};
