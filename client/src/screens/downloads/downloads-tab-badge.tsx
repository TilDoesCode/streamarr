import { useTranslation } from 'react-i18next';
import type { ViewStyle } from 'react-native';

import { CountBadge } from '@/mylist/tab-badge';

import { useDownloadsTab } from './use-download-ui';

/** The Downloads entry's badge (rail, web sidebar): downloads still running; nothing while none is. */
export function DownloadsTabBadge({ size, style }: { size: number; style?: ViewStyle }) {
  const { t } = useTranslation();
  const { count } = useDownloadsTab();
  return (
    <CountBadge
      testID="downloads-badge"
      count={count}
      size={size}
      style={style}
      label={t('downloads.screen.badgeLabel', { count })}
    />
  );
}
