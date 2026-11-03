import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { END_OF_ROW, FocusGuide } from '@/components/focus';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import {
  embeddedServer,
  type EmbeddedServerCredentials,
  type EmbeddedServerStatus,
} from '@modules/embedded-server';
import { colors, useDesign } from '@/theme';

const LOG_LINES = 40;

/** `/dev/server` (no account needed): start/stop the server bundled into the Android TV app and watch its status, addresses and log. */
export function DevServerScreen() {
  const { t } = useTranslation();
  const design = useDesign();
  const insets = useSafeAreaInsets();
  const [status, setStatus] = useState<EmbeddedServerStatus | null>(null);
  const [credentials, setCredentials] = useState<EmbeddedServerCredentials | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const run = (action: () => Promise<unknown>) => {
    setError(null);
    action()
      .then((result) => {
        if (result && typeof result === 'object' && 'state' in result)
          setStatus(result as EmbeddedServerStatus);
      })
      .catch((e: Error) => setError(e.message));
  };

  useEffect(() => {
    if (!embeddedServer.supported) return;
    embeddedServer
      .getStatus()
      .then(setStatus)
      .catch((e: Error) => setError(e.message));
    const subscription = embeddedServer.addStatusListener(setStatus);
    const timer = setInterval(() => {
      embeddedServer
        .getLogs(LOG_LINES)
        .then(setLogs)
        .catch(() => {});
    }, 2000);
    return () => {
      subscription.remove();
      clearInterval(timer);
    };
  }, []);

  if (!embeddedServer.supported)
    return (
      <View
        testID="dev-server-screen"
        style={{ flex: 1, padding: design.layout.gutter, backgroundColor: colors.background }}>
        <Text variant="title">{t('devServer.title')}</Text>
        <Text tone="muted">{t('devServer.unsupported')}</Text>
      </View>
    );

  return (
    <View testID="dev-server-screen" style={{ flex: 1, backgroundColor: colors.background }}>
      <ScrollView
        contentContainerStyle={{
          paddingTop: design.isTV ? design.layout.edgeVertical : insets.top + design.space.lg,
          paddingBottom: Math.max(insets.bottom, design.layout.edgeVertical) + design.space['3xl'],
          paddingHorizontal: design.layout.gutter,
          gap: design.layout.sectionGap,
        }}>
        <View style={{ gap: design.space.xs }}>
          <Text variant="title">{t('devServer.title')}</Text>
          <Text variant="callout" tone="muted" testID="dev-server-state">
            {t('devServer.state', {
              state: status?.state ?? 'stopped',
              port: status?.port ?? 0,
              version: status?.version ?? status?.bundleVersion ?? '…',
            })}
          </Text>
          {status?.lastError ? <Text tone="danger">{status.lastError}</Text> : null}
          {error ? <Text tone="danger">{error}</Text> : null}
        </View>

        <FocusGuide
          trap={END_OF_ROW}
          style={{ flexDirection: 'row', flexWrap: 'wrap', gap: design.space.sm }}>
          <Button
            testID="dev-server-start"
            size="sm"
            label={t('devServer.start')}
            onPress={() => run(() => embeddedServer.start())}
          />
          <Button
            testID="dev-server-stop"
            variant="secondary"
            size="sm"
            label={t('devServer.stop')}
            onPress={() => run(() => embeddedServer.stop())}
          />
          <Button
            variant="ghost"
            size="sm"
            label={t('devServer.autostart', { state: status?.autostart ? 'on' : 'off' })}
            onPress={() => run(() => embeddedServer.setAutostart(!status?.autostart))}
          />
          <Button
            testID="dev-server-credentials"
            variant="ghost"
            size="sm"
            label={t('devServer.showCredentials')}
            onPress={() => run(() => embeddedServer.getCredentials().then(setCredentials))}
          />
          <Button
            variant="ghost"
            size="sm"
            label={t('devServer.resetPassword')}
            onPress={() => run(() => embeddedServer.resetAdminPassword().then(setCredentials))}
          />
        </FocusGuide>

        <View style={{ gap: design.space.xs }}>
          <Text variant="heading">{t('devServer.addresses')}</Text>
          {(status?.addresses ?? []).map((address) => (
            <Text key={address.url} variant="callout" testID={`dev-server-address-${address.kind}`}>
              {t('devServer.address', { kind: address.kind, url: address.url })}
            </Text>
          ))}
          <Text variant="caption" tone="muted">
            {t('devServer.storage', {
              path: status?.dataPath ?? '…',
              free: Math.round((status?.diskFreeBytes ?? 0) / (1024 * 1024 * 1024)),
            })}
          </Text>
          {credentials ? (
            <Text variant="callout" testID="dev-server-credentials-text">
              {t('devServer.credentials', {
                username: credentials.username,
                password: credentials.password ?? t('devServer.passwordChanged'),
              })}
            </Text>
          ) : null}
        </View>

        <View style={{ gap: design.space.xs }}>
          <Text variant="heading">{t('devServer.log')}</Text>
          {logs.map((line, index) => (
            <Text key={`${index}-${line}`} variant="caption" tone="muted">
              {line}
            </Text>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}
