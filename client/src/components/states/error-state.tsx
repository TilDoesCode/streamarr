import { CircleAlert, Lock, WifiOff, type LucideIcon } from '@/components/icons';
import { useTranslation } from 'react-i18next';

import { describeError } from '@/api/error-text';
import type { ErrorParams } from '@/api/errors';

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
  /** Server error params (age-gate reason, other device) for a more specific message. */
  params?: ErrorParams;
  /** HTTP status (0 = no answer): picks the category text of a code the app does not know. */
  status?: number;
  /** Actions in priority order; the first is rendered as the primary button. */
  actions?: readonly ErrorAction[];
  onAction?: (action: ErrorAction) => void;
  /** Moves TV focus to the primary action when shown. */
  autoFocus?: boolean;
  /** Inside a card that already has padding. */
  compact?: boolean;
  /** A short window: no icon, tighter gaps. */
  dense?: boolean;
  testID?: string;
};

export function ErrorState({
  code = 'unknown',
  params,
  status,
  actions = ['retry'],
  onAction,
  autoFocus = false,
  compact = false,
  dense = false,
  testID,
}: ErrorStateProps) {
  const { t } = useTranslation();
  const text = describeError(t, { code, params, status });
  return (
    <EmptyState
      testID={testID}
      compact={compact}
      dense={dense}
      icon={ICONS[code] ?? CircleAlert}
      iconColor={colors.danger.DEFAULT}
      title={text.title}
      message={text.message}
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
