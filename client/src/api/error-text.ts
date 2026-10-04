import type { TFunction } from 'i18next';

import { categoryOf } from './error-categories';
import { isKnownErrorCode } from './error-codes';
import type { ErrorParams } from './errors';

/** `status` (HTTP, 0 = no answer) picks the category text of a code the client does not know. */
export type ErrorLike = { code: string; params?: ErrorParams; status?: number };

export type ErrorText = { title: string; message: string };

/** Wait states (a code-request cooldown) are information, not failures. */
export const errorTone = (error: ErrorLike): 'info' | 'danger' =>
  error.code === 'email_code_cooldown' ? 'info' : 'danger';

/** Localized title + message for any error code; unknown codes get their category's text (never the generic one). */
export function describeError(t: TFunction, error: ErrorLike): ErrorText {
  const { code } = error;
  if (!isKnownErrorCode(code)) {
    const category = categoryOf(code, error.status);
    return {
      title: t(`errors.categories.${category}.title`),
      message: t(`errors.categories.${category}.message`),
    };
  }
  const params = error.params ?? {};
  const title = t(`errors.codes.${code}.title`);
  if (code === 'age_restricted')
    return { title, message: t('errors.ageRestricted', { reason: params.reason ?? 'other' }) };
  if (code === 'too_many_streams' && params.device)
    return { title, message: t('errors.tooManyStreamsOn', { device: params.device }) };
  return { title, message: t(`errors.codes.${code}.message`) };
}
