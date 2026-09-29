/** Mirrors the server's viewer password rules so problems are explained before submitting. */
export type PasswordProblem =
  | { kind: 'tooShort'; min: number }
  | { kind: 'tooLong'; max: number }
  | { kind: 'sameAsUsername' }
  | { kind: 'repetitive' }
  | { kind: 'mismatch' };

export const PASSWORD_MAX_LENGTH = 256;

export function passwordProblem(
  password: string,
  confirmation: string,
  { minLength, username }: { minLength: number; username?: string }
): PasswordProblem | null {
  if (password.length < minLength) return { kind: 'tooShort', min: minLength };
  if (password.length > PASSWORD_MAX_LENGTH) return { kind: 'tooLong', max: PASSWORD_MAX_LENGTH };
  if (username && password.toLowerCase() === username.toLowerCase())
    return { kind: 'sameAsUsername' };
  if (new Set(password).size < 3) return { kind: 'repetitive' };
  if (password !== confirmation) return { kind: 'mismatch' };
  return null;
}
