import { useQueryClient } from '@tanstack/react-query';
import { useFocusEffect, useIsFocused, useRouter } from 'expo-router';
import { useCallback, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useAccounts, useAccountsApi, useSessionGate } from '@/accounts/accounts-provider';
import { serverKey } from '@/api/server-url';
import { AmbientBackdrop } from '@/components/ambient';
import { FocusGuide, useBackHandler } from '@/components/focus';
import { ArrowLeft, ArrowRight, ArrowRightLeft, UserPlus } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { useRelativeNow } from '@/diagnostics/use-relative-now';
import { readiness } from '@/local-server/model';
import { useEmbeddedServer, useReadinessProbes } from '@/local-server/use-embedded-server';
import { useScreenTitle } from '@/navigation/screen-title';
import { queryKeys } from '@/query/keys';
import { FormError } from '@/screens/onboarding/form-parts';
import { enterApp } from '@/screens/onboarding/use-onboarding';
import { colors, useDesign } from '@/theme';

import { AddressPanel } from './address-panel';
import { ActionRow } from './card';
import { ReadinessList } from './readiness-list';
import { LogPanel, ServerSettings } from './server-settings';
import { StatusCard } from './status-card';

/** `select` argument of the device-aware strings: TV boxes say "this TV", everything else "this device". */
export const useDeviceWord = () => (useDesign().isTV ? 'tv' : 'other');

/** "Server on this device": run the bundled Core Server, scan its address with a phone, then connect to it. */
export function LocalServerScreen() {
  const { t } = useTranslation();
  const device = useDeviceWord();
  const server = useEmbeddedServer();
  useScreenTitle(t('localServer.title', { device }));
  const { refresh } = server;
  useFocusEffect(useCallback(() => refresh(), [refresh]));
  const back = useLeave();
  useBackHandler(back.onHardwareBack);

  if (!server.supported)
    return (
      <Page>
        <Heading onBack={back.leave} />
        <Text testID="local-server-unsupported" variant="body" tone="muted">
          {t('localServer.unsupported', { device })}
        </Text>
        <ActionRow>
          <Button
            testID="local-server-unsupported-back"
            variant="secondary"
            icon={ArrowLeft}
            label={t('common.back')}
            hasTVPreferredFocus
            onPress={back.leave}
          />
        </ActionRow>
      </Page>
    );
  if (!server.status)
    return (
      <Page>
        <Heading onBack={back.leave} />
        {server.error ? (
          <FormError
            testID="local-server-load-error"
            error={server.error}
            actions={
              <Button
                size="sm"
                variant="secondary"
                label={t('common.retry')}
                hasTVPreferredFocus
                onPress={refresh}
              />
            }
          />
        ) : (
          <Spinner accessibilityLabel={t('a11y.loading')} />
        )}
      </Page>
    );
  return <Loaded server={server} onBack={back.leave} />;
}

function Loaded({
  server,
  onBack,
}: {
  server: ReturnType<typeof useEmbeddedServer>;
  onBack: () => void;
}) {
  const design = useDesign();
  const focused = useIsFocused();
  const now = useRelativeNow();
  const status = server.status!;
  const probes = useReadinessProbes(status, focused);
  const { checks, ready } = readiness({
    status,
    health: probes.health,
    viewer: probes.viewer,
    now,
  });
  const [logsShown, setLogsShown] = useState(false);
  const [revealPassword, setRevealPassword] = useState(0);
  const wide = design.isTV || design.formFactor !== 'phone';
  const left = (
    <>
      <StatusCard server={server} status={status} preferFocus={!ready} />
      <ReadinessList checks={checks}>
        {ready && probes.viewer.data ? (
          <ConnectActions info={probes.viewer.data} preferFocus={ready} />
        ) : null}
      </ReadinessList>
      <ServerSettings
        server={server}
        status={status}
        logsShown={logsShown}
        onToggleLogs={() => setLogsShown(!logsShown)}
        onPasswordReset={() => setRevealPassword(Date.now())}
      />
    </>
  );
  const right = <AddressPanel status={status} revealPassword={revealPassword} />;
  return (
    <Page>
      <Heading onBack={onBack} />
      {wide ? (
        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: design.space.xl }}>
          <FocusGuide remember style={{ flex: 1.2, gap: design.space.lg }}>
            {left}
          </FocusGuide>
          <FocusGuide remember style={{ flex: 1, gap: design.space.lg }}>
            {right}
          </FocusGuide>
        </View>
      ) : (
        <View style={{ gap: design.space.lg }}>
          {left}
          {right}
        </View>
      )}
      {logsShown ? <LogPanel active={focused} /> : null}
    </Page>
  );
}

/** Connect (sign in on the loopback address) or switch to a profile that already uses this server. */
function ConnectActions({
  info,
  preferFocus,
}: {
  info: NonNullable<ReturnType<typeof useReadinessProbes>['viewer']['data']>;
  preferFocus: boolean;
}) {
  const { t } = useTranslation();
  const router = useRouter();
  const queryClient = useQueryClient();
  const api = useAccountsApi();
  const { accounts } = useAccounts();
  const gate = useSessionGate();
  const key = serverKey(info.baseUrl);
  const existing = accounts
    .filter((account) => serverKey(account.serverUrl) === key)
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  const current =
    gate.reason === 'ready' && gate.account && serverKey(gate.account.serverUrl) === key;
  const signedIn = existing.find((account) => account.signedIn);
  const signIn = () => {
    queryClient.setQueryData(queryKeys.serverOptions(info.baseUrl), info);
    router.push({ pathname: '/sign-in', params: { server: info.baseUrl } });
  };
  return (
    <ActionRow>
      {current ? (
        <Button
          testID="local-server-open-app"
          icon={ArrowRight}
          label={t('localServer.connect.openApp')}
          hasTVPreferredFocus={preferFocus}
          onPress={() => enterApp(router)}
        />
      ) : signedIn ? (
        <Button
          testID="local-server-switch"
          icon={ArrowRightLeft}
          label={t('localServer.connect.switch')}
          hasTVPreferredFocus={preferFocus}
          onPress={() => {
            api.activate(signedIn.id);
            enterApp(router);
          }}
        />
      ) : (
        <Button
          testID="local-server-connect"
          icon={ArrowRight}
          label={t('localServer.connect.connect')}
          hasTVPreferredFocus={preferFocus}
          onPress={signIn}
        />
      )}
      {current || signedIn ? (
        <Button
          testID="local-server-add-account"
          variant="secondary"
          icon={UserPlus}
          label={t('localServer.connect.addAccount')}
          onPress={signIn}
        />
      ) : null}
    </ActionRow>
  );
}

/** Back from a cold deep link has nothing below it: go to the app (or onboarding) instead of closing it. */
function useLeave() {
  const router = useRouter();
  const leave = () => (router.canGoBack() ? router.back() : router.replace('/'));
  return {
    leave,
    onHardwareBack: () => {
      if (router.canGoBack()) return false;
      router.replace('/');
      return true;
    },
  };
}

function Heading({ onBack }: { onBack: () => void }) {
  const { t } = useTranslation();
  const design = useDesign();
  const device = useDeviceWord();
  return (
    <View style={{ gap: design.space.sm }}>
      {design.isTV ? null : (
        <IconButton
          testID="local-server-back"
          icon={ArrowLeft}
          variant="ghost"
          accessibilityLabel={t('common.back')}
          onPress={onBack}
          style={{ alignSelf: 'flex-start', marginLeft: -design.space.sm }}
        />
      )}
      <Text variant={design.isTV ? 'display' : 'title'} role="heading">
        {t('localServer.title', { device })}
      </Text>
      <Text variant="body" tone="muted" style={{ maxWidth: design.px(720) }}>
        {t('localServer.subtitle', { device })}
      </Text>
    </View>
  );
}

function Page({ children }: { children: ReactNode }) {
  const design = useDesign();
  return (
    <SafeAreaView
      testID="local-server-screen"
      style={{ flex: 1, backgroundColor: colors.background }}>
      <AmbientBackdrop />
      <ScrollView
        style={{ flex: 1 }}
        showsVerticalScrollIndicator={!design.isTV}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{
          paddingHorizontal: design.isTV
            ? design.layout.gutter + design.px(24)
            : design.layout.gutter,
          paddingTop: design.layout.edgeVertical + design.space.lg,
          paddingBottom: design.layout.edgeVertical + design.px(120),
          gap: design.space.xl,
          width: '100%',
          maxWidth: design.isTV ? undefined : design.layout.maxContentWidth,
          alignSelf: 'center',
        }}>
        {children}
      </ScrollView>
    </SafeAreaView>
  );
}
