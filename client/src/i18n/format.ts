import type { TFunction } from 'i18next';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

export type DateStyle = 'short' | 'medium' | 'long';

const DATE_OPTIONS: Record<DateStyle, Intl.DateTimeFormatOptions> = {
  short: { day: 'numeric', month: 'numeric', year: 'numeric' },
  medium: { day: 'numeric', month: 'short', year: 'numeric' },
  long: { day: 'numeric', month: 'long', year: 'numeric' },
};

const DAY_MS = 24 * 60 * 60 * 1000;

function toDate(value: Date | string | number): Date {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, m, d] = value.split('-').map(Number) as [number, number, number];
    return new Date(y, m - 1, d);
  }
  return value instanceof Date ? value : new Date(value);
}

export function formatDate(
  value: Date | string | number,
  lang: string,
  style: DateStyle = 'medium'
) {
  return new Intl.DateTimeFormat(lang, DATE_OPTIONS[style]).format(toDate(value));
}

export function formatNumber(value: number, lang: string, options?: Intl.NumberFormatOptions) {
  return new Intl.NumberFormat(lang, options).format(value);
}

/** Runtime / duration: "1 h 42 min", "42 min", "35 s" (localized units). */
export function formatDuration(totalSeconds: number, t: TFunction) {
  const seconds = Math.max(0, Math.round(totalSeconds));
  if (seconds < 60) return t('format.duration.s', { seconds });
  const totalMinutes = Math.round(seconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return t('format.duration.m', { minutes });
  if (minutes === 0) return t('format.duration.h', { hours });
  return t('format.duration.hm', { hours, minutes });
}

export function formatRemaining(totalSeconds: number, t: TFunction) {
  return t('media.remaining', { time: formatDuration(totalSeconds, t) });
}

/** "Today", "Yesterday", "3 days ago" within a week, otherwise a medium date. */
export function formatRelativeDay(
  value: Date | string | number,
  lang: string,
  t: TFunction,
  now: Date = new Date()
) {
  const date = toDate(value);
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOf(now) - startOf(date)) / DAY_MS);
  if (days === 0) return t('format.relative.today');
  if (days === 1) return t('format.relative.yesterday');
  if (days === -1) return t('format.relative.tomorrow');
  if (days > 1 && days < 7) return t('format.relative.daysAgo', { count: days });
  if (days < -1 && days > -7) return t('format.relative.inDays', { count: -days });
  return formatDate(date, lang, 'medium');
}

export function formatFileSize(bytes: number, lang: string, t: TFunction) {
  const gb = bytes / 1_000_000_000;
  if (gb >= 1) {
    return t('format.size.gb', { value: formatNumber(gb, lang, { maximumFractionDigits: 1 }) });
  }
  const mb = bytes / 1_000_000;
  return t('format.size.mb', { value: formatNumber(mb, lang, { maximumFractionDigits: 0 }) });
}

/** Formatters bound to the current UI language. */
export function useFormat() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  return useMemo(
    () => ({
      lang,
      date: (value: Date | string | number, style?: DateStyle) => formatDate(value, lang, style),
      number: (value: number, options?: Intl.NumberFormatOptions) =>
        formatNumber(value, lang, options),
      duration: (seconds: number) => formatDuration(seconds, t),
      remaining: (seconds: number) => formatRemaining(seconds, t),
      relativeDay: (value: Date | string | number, now?: Date) =>
        formatRelativeDay(value, lang, t, now),
      fileSize: (bytes: number) => formatFileSize(bytes, lang, t),
    }),
    [lang, t]
  );
}
