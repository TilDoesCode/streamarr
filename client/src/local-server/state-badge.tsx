import type { EmbeddedServerState } from '@modules/embedded-server';
import { useTranslation } from 'react-i18next';

import { Badge, type BadgeVariant } from '@/components/ui/badge';

import { STATE_TONE, type StateTone } from './model';

const VARIANT: Record<StateTone, BadgeVariant> = {
  success: 'success',
  warning: 'warning',
  danger: 'danger',
  neutral: 'neutral',
};

/** Läuft / Gestoppt / Fehler … in the state's tone (Settings row, status card). */
export function ServerStateBadge({
  state,
  testID,
}: {
  state: EmbeddedServerState;
  testID?: string;
}) {
  const { t } = useTranslation();
  return (
    <Badge
      testID={testID}
      variant={VARIANT[STATE_TONE[state]]}
      label={t(`localServer.state.${state}`)}
    />
  );
}
