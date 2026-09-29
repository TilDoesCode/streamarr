import type { TFunction } from 'i18next';

import { isKnownErrorCode } from './error-codes';
import type { ErrorParams } from './errors';

export type ErrorLike = { code: string; params?: ErrorParams };

export type ErrorText = { title: string; message: string };

/** Localized title + message for any error code; unknown codes fall back to the generic text. */
export function describeError(t: TFunction, error: ErrorLike): ErrorText {
  const code = isKnownErrorCode(error.code) ? error.code : 'unknown';
  const params = error.params ?? {};
  const title = t(`errors.codes.${code}.title`);
  if (code === 'age_restricted')
    return { title, message: t('errors.ageRestricted', { reason: params.reason ?? 'other' }) };
  if (code === 'too_many_streams' && params.device)
    return { title, message: t('errors.tooManyStreamsOn', { device: params.device }) };
  return { title, message: t(`errors.codes.${code}.message`) };
}
