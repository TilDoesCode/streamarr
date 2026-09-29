/** Every account-scoped query key starts with ['account', id]: switching accounts can never mix data. */
export const accountKey = (accountId: string, ...rest: readonly unknown[]) =>
  ['account', accountId, ...rest] as const;

export const queryKeys = {
  me: (accountId: string) => accountKey(accountId, 'me'),
  discover: (accountId: string) => accountKey(accountId, 'catalog', 'discover'),
  serverOptions: (baseUrl: string) => ['server', baseUrl, 'options'] as const,
};
