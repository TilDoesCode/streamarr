import { createMMKV } from 'react-native-mmkv';

import { parseTokens, WEB_VAULT_STORAGE_ID, type TokenVault } from './types';

// Web: localStorage (MMKV's web backend). Cookie mode would allow only one session per server and browser.
const storage = createMMKV({ id: WEB_VAULT_STORAGE_ID });

export const tokenVault: TokenVault = {
  get: async (accountId) => parseTokens(storage.getString(accountId)),
  set: async (accountId, tokens) => storage.set(accountId, JSON.stringify(tokens)),
  remove: async (accountId) => void storage.remove(accountId),
};
