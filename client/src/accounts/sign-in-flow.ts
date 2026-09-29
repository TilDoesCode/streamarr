/** Secrets that must not go into route params (URLs are visible on web); kept in memory for one flow. */
type PendingSecondFactor = {
  serverUrl: string;
  login: string;
  mfaToken: string;
  expiresAt: number;
  /** Typed at the password step; reused if the admin requires a password change. */
  password?: string;
};

let secondFactor: PendingSecondFactor | null = null;
const knownPasswords = new Map<string, string>();

export const signInFlow = {
  startSecondFactor(pending: PendingSecondFactor): void {
    secondFactor = pending;
  },
  /** The pending challenge for this server, unless it expired. */
  secondFactor(serverUrl: string, now = Date.now()): PendingSecondFactor | null {
    if (!secondFactor || secondFactor.serverUrl !== serverUrl || secondFactor.expiresAt <= now)
      return null;
    return secondFactor;
  },
  clearSecondFactor(): void {
    secondFactor = null;
  },
  /** Remembers the sign-in password of an account that must change it (so it is not asked twice). */
  rememberPassword(accountId: string, password: string): void {
    knownPasswords.set(accountId, password);
  },
  takePassword(accountId: string): string | undefined {
    return knownPasswords.get(accountId);
  },
  forgetPassword(accountId: string): void {
    knownPasswords.delete(accountId);
  },
};
