import * as SecureStore from 'expo-secure-store';

import { AppError } from '@/api/errors';

import { parseTokens, type TokenVault } from './types';

const key = (accountId: string) => `streamarr.tokens.${accountId}`;
const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

/** Native: Keychain (iOS/tvOS) and Keystore-encrypted storage (Android). */
export const tokenVault: TokenVault = {
  async get(accountId) {
    let raw: string | null;
    try {
      raw = await SecureStore.getItemAsync(key(accountId), OPTIONS);
    } catch (error) {
      // A lost key (reinstall, restore) already comes back as null; a thrown error is a Keystore/Keychain hiccup.
      throw new AppError('token_storage_unavailable', { cause: error });
    }
    return parseTokens(raw);
  },
  set: (accountId, tokens) =>
    SecureStore.setItemAsync(key(accountId), JSON.stringify(tokens), OPTIONS),
  remove: (accountId) => SecureStore.deleteItemAsync(key(accountId), OPTIONS),
};
