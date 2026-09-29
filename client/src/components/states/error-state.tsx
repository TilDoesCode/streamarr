import { CircleAlert, Lock, WifiOff, type LucideIcon } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';

import { EmptyState } from '@/components/states/empty-state';
import { Button } from '@/components/ui/button';
import { colors } from '@/theme';

export type ErrorAction =
  'retry' | 'otherVersion' | 'lowerQuality' | 'useVlc' | 'signIn' | 'goHome' | 'back';

const ICONS: Record<string, LucideIcon> = {
  network_unreachable: WifiOff,
  timeout: WifiOff,
  age_restricted: Lock,
  forbidden: Lock,
  unauthorized: Lock,
};

export type ErrorStateProps = {
  /** Stable server/client error code; unknown codes fall back to a generic message. */
  code?: string;
  /** Actions in priority order; the first is rendered as the primary button. */
  actions?: readonly ErrorAction[];
  onAction?: (action: ErrorAction) => void;
  /** Moves TV focus to the primary action when shown. */
  autoFocus?: boolean;
  testID?: string;
};

export function ErrorState({
  code = 'unknown',
  actions = ['retry'],
  onAction,
  autoFocus = false,
  testID,
}: ErrorStateProps) {
  const { t, i18n } = useTranslation();
  const known = i18n.exists(`errors.codes.${code}.title`);
  const key = (known ? code : 'unknown') as 'unknown';
  return (
    <EmptyState
      testID={testID}
      icon={ICONS[code] ?? CircleAlert}
      iconColor={colors.danger.DEFAULT}
      title={t(`errors.codes.${key}.title`)}
      message={t(`errors.codes.${key}.message`)}
      detail={t('errors.codeLabel', { code })}
      actions={
        onAction && actions.length
          ? actions.map((action, index) => (
              <Button
                key={action}
                label={t(`errors.actions.${action}`)}
                variant={index === 0 ? 'primary' : 'secondary'}
                hasTVPreferredFocus={autoFocus && index === 0}
                onPress={() => onAction(action)}
              />
            ))
          : undefined
      }
    />
  );
}
