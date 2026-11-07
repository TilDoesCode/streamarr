import { useTranslation } from 'react-i18next';

import { useDelayedFlag } from '@/lib/use-delayed-flag';

import { DownloadRow, type DownloadRowProps } from './download-row';

/** Fast deletes (a whole season) only grey their rows; the label follows once one takes longer. */
export const REMOVING_LABEL_DELAY_MS = 600;

/** A download being cancelled or removed: greyed at once, "Removing…" after a moment, no actions. */
export function RemovingRow(
  props: Omit<
    DownloadRowProps,
    'detail' | 'problem' | 'progress' | 'onPress' | 'actions' | 'subdued'
  >
) {
  const { t } = useTranslation();
  const labelled = useDelayedFlag(true, REMOVING_LABEL_DELAY_MS);
  return (
    <DownloadRow {...props} subdued detail={labelled ? t('downloads.state.removing') : undefined} />
  );
}
