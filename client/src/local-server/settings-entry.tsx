import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';

import { embeddedServer } from '@modules/embedded-server';
import { displayServerUrl } from '@/api/server-url';
import { Server } from '@/components/icons';
import { SettingsRow, SettingsSection } from '@/components/settings';
import { useDesign } from '@/theme';

import { qrAddress } from './model';
import { ServerStateBadge } from './state-badge';
import { useEmbeddedServer } from './use-embedded-server';

/** Settings: the server on this device with its live state; Android builds with the bundled server only. */
export function LocalServerSection() {
  if (!embeddedServer.supported) return null;
  return <Entry />;
}

function Entry() {
  const { t } = useTranslation();
  const router = useRouter();
  const device = useDesign().isTV ? 'tv' : 'other';
  const { status } = useEmbeddedServer();
  const best = status?.state === 'running' ? qrAddress(status.addresses) : undefined;
  return (
    <SettingsSection title={t('localServer.entry.section')} testID="settings-local-server">
      <SettingsRow
        testID="settings-local-server-open"
        icon={Server}
        label={t('localServer.entry.label', { device })}
        description={
          best
            ? t('localServer.entry.running', { url: displayServerUrl(best.url) })
            : t('localServer.entry.idle')
        }
        badge={
          status ? (
            <ServerStateBadge state={status.state} testID="settings-local-server-state" />
          ) : null
        }
        onPress={() => router.push('/server/local')}
      />
    </SettingsSection>
  );
}
