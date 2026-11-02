import type { EmbeddedServerStatus } from '@modules/embedded-server';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { FormError } from '@/screens/onboarding/form-parts';
import { Play, Square } from '@/components/icons';
import { SettingsInfoRow } from '@/components/settings';
import { Button } from '@/components/ui/button';
import { FormMessage } from '@/components/ui/form-message';
import { Text } from '@/components/ui/text';
import { useRelativeNow } from '@/diagnostics/use-relative-now';
import { formatDuration } from '@/i18n/format';
import { isTransitioning, parseFailure, runningPort } from '@/local-server/model';
import { ServerStateBadge } from '@/local-server/state-badge';
import type { useEmbeddedServer } from '@/local-server/use-embedded-server';
import { useDesign } from '@/theme';

import { ActionRow, Card } from './card';

/** The last failure: a coded one ("port_in_use: …") gets its localized text, the English detail stays a second line. */
function FailedMessage({ lastError }: { lastError?: string }) {
  const { t } = useTranslation();
  const { code, detail } = parseFailure(lastError);
  const message = code
    ? [t(`errors.codes.${code}.message`), detail].filter(Boolean).join('\n')
    : (detail ?? t('localServer.status.failedNoDetail'));
  return (
    <FormMessage
      testID="local-server-failed"
      title={code ? t(`errors.codes.${code}.title`) : t('localServer.status.failedTitle')}
      message={message}
    />
  );
}

/** State, uptime, versions, port and the last failure, with Start / Stop. */
export function StatusCard({
  server,
  status,
  preferFocus,
}: {
  server: ReturnType<typeof useEmbeddedServer>;
  status: EmbeddedServerStatus;
  preferFocus: boolean;
}) {
  const { t } = useTranslation();
  const design = useDesign();
  const now = useRelativeNow();
  const { state } = status;
  const up = state === 'running' || state === 'starting';
  const action = up ? server.stop : server.start;
  const busy = isTransitioning(state) || server.start.isPending || server.stop.isPending;
  const uptime =
    state === 'running' && status.startedAt
      ? formatDuration(Math.max(0, (now - status.startedAt) / 1000), t)
      : undefined;
  const port = state === 'running' ? runningPort(status) : status.port;
  return (
    <Card testID="local-server-status" pageTop>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: design.space.md }}>
        <Text variant="heading" style={{ flexShrink: 1 }}>
          {t('localServer.status.title')}
        </Text>
        <ServerStateBadge state={state} testID="local-server-state" />
      </View>
      <View style={{ gap: design.space.xs }}>
        {uptime ? (
          <SettingsInfoRow
            valueTestID="local-server-uptime"
            label={t('localServer.status.uptime')}
            value={uptime}
          />
        ) : null}
        {status.version ? (
          <SettingsInfoRow
            valueTestID="local-server-version"
            label={t('localServer.status.version')}
            value={status.version.split('+')[0]}
          />
        ) : null}
        <SettingsInfoRow
          valueTestID="local-server-port"
          label={t('localServer.status.port')}
          value={String(port)}
        />
        <SettingsInfoRow
          valueTestID="local-server-bundle"
          label={t('localServer.status.bundle')}
          value={status.bundleVersion}
        />
        {status.restartCount > 0 ? (
          <SettingsInfoRow
            valueTestID="local-server-restarts"
            label={t('localServer.status.restarts')}
            value={t('localServer.status.restartCount', { count: status.restartCount })}
          />
        ) : null}
      </View>
      {state === 'failed' ? <FailedMessage lastError={status.lastError} /> : null}
      <FormError testID="local-server-action-error" error={action.error} />
      <ActionRow>
        <Button
          testID={up ? 'local-server-stop' : 'local-server-start'}
          variant={up ? 'secondary' : 'primary'}
          icon={up ? Square : Play}
          label={
            state === 'starting'
              ? t('localServer.status.starting')
              : state === 'stopping'
                ? t('localServer.status.stopping')
                : up
                  ? t('localServer.status.stop')
                  : state === 'failed'
                    ? t('localServer.status.retry')
                    : t('localServer.status.start')
          }
          loading={busy}
          hasTVPreferredFocus={preferFocus}
          onPress={() => {
            server.start.reset();
            server.stop.reset();
            action.mutate();
          }}
        />
      </ActionRow>
    </Card>
  );
}
