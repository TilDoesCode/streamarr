import type { TFunction } from 'i18next';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import { useFormat } from '@/i18n/format';
import type { SpecTone } from '@/components/spec';

import type { RowMatch } from './download-model';

/** "1.4 GB", or "about 1.4 GB" while the size is an estimate (indexer size or a pack share). */
export function useSizeText() {
  const { t } = useTranslation();
  const format = useFormat();
  return useCallback(
    (bytes: number, estimate = false) =>
      estimate
        ? t('downloads.sheet.approx', { size: format.fileSize(bytes) })
        : format.fileSize(bytes),
    [t, format]
  );
}

const MATCH_TONE: Record<RowMatch, SpecTone> = {
  same_release: 'ok',
  same_variant: 'ok',
  same_group: 'info',
  best_available: 'warn',
  none: 'bad',
  manual: 'neutral',
  recommended: 'neutral',
};

/** Marker of a review row: how close the episode's release is to the one the viewer picked. */
export function matchLabel(t: TFunction, match: RowMatch): { label: string; tone: SpecTone } {
  return {
    label: match === 'recommended' ? t('media.recommended') : t(`downloads.sheet.match.${match}`),
    tone: MATCH_TONE[match],
  };
}
