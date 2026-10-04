import type { TFunction } from 'i18next';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { toAppError } from '@/api/errors';
import { Button, type ButtonProps } from '@/components/ui/button';

const secondsUntil = (until: number) => Math.max(0, Math.ceil((until - Date.now()) / 1000));

/** End (epoch ms) of an `email_code_cooldown` answer's wait; 0 for any other error. */
function cooldownUntil(error: unknown, now = Date.now()): number {
  const appError = toAppError(error);
  if (appError.code !== 'email_code_cooldown') return 0;
  return now + Math.max(1, appError.retryAfter ?? 30) * 1000;
}

/** A code-request cooldown: `start(error)` from the mutation's onError; `active` until the wait ends. */
export function useCooldown() {
  const [until, setUntil] = useState(0);
  useEffect(() => {
    if (!until) return;
    const timer = setTimeout(() => setUntil(0), Math.max(0, until - Date.now()));
    return () => clearTimeout(timer);
  }, [until]);
  return {
    until,
    active: until > 0,
    start: (error: unknown) => setUntil(cooldownUntil(error)),
  };
}

/** Button label while a code request waits: "Wait 27 s", minutes once the wait is longer. */
function cooldownLabel(t: TFunction, seconds: number): string {
  return seconds > 90
    ? t('onboarding.emailCode.waitMinutes', { minutes: Math.ceil(seconds / 60) })
    : t('onboarding.emailCode.wait', { seconds });
}

/** The error to show: a cooldown that has run out is hidden (the button works again). */
export function activeError(error: unknown, cooldownActive: boolean): unknown {
  if (!error || cooldownActive) return error;
  return toAppError(error).code === 'email_code_cooldown' ? null : error;
}

/** Disabled with a live "Wait N s" label until `until`; only this button re-renders every second. */
export function CooldownButton({
  until,
  label,
  disabled,
  ...props
}: ButtonProps & { until: number }) {
  const { t } = useTranslation();
  const [seconds, setSeconds] = useState(() => secondsUntil(until));
  useEffect(() => {
    const tick = () => {
      const left = secondsUntil(until);
      setSeconds(left);
      if (left === 0) clearInterval(timer);
    };
    const timer = setInterval(tick, 1000);
    tick();
    return () => clearInterval(timer);
  }, [until]);
  return (
    <Button
      {...props}
      label={seconds > 0 ? cooldownLabel(t, seconds) : label}
      disabled={disabled || seconds > 0}
    />
  );
}
