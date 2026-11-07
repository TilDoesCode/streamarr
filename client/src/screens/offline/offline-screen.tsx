import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BackHandler, Platform, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAccounts } from '@/accounts/accounts-provider';
import { useBackHandler } from '@/components/focus';
import { DownloadsLibrary } from '@/components/downloads';
import { RefreshCw, ServerOff, Users, WifiOff } from '@/components/icons';
import { SettingsSection } from '@/components/settings';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { useConnectivity } from '@/connectivity/provider';
import { useScreenTitle } from '@/navigation/screen-title';
import { pendingProgress } from '@/player/progress-queue';
import { DownloadsSettingsSection } from '@/screens/settings/downloads-section';
import { LanguageRow, PerformanceRow } from '@/screens/settings/settings-screen';
import { colors, gutterPadding, useDesign } from '@/theme';

/** Why the app is offline (no network vs the server not answering), with "Try again". */
export function OfflineBanner() {
  const { t } = useTranslation();
  const design = useDesign();
  const connectivity = useConnectivity();
  const { accounts, activeId } = useAccounts();
  const server = accounts.find((account) => account.id === activeId)?.serverName ?? '';
  const [checking, setChecking] = useState(false);
  const noNetwork = connectivity.state === 'offline_no_network';
  const Icon = noNetwork ? WifiOff : ServerOff;
  const retry = () => {
    setChecking(true);
    void connectivity.retry().finally(() => setChecking(false));
  };
  return (
    <View
      testID="offline-banner"
      role="alert"
      style={{
        gap: design.space.md,
        padding: design.space.lg,
        borderRadius: design.radius.lg,
        borderWidth: 1,
        borderColor: colors.warning.DEFAULT,
        backgroundColor: colors.surface.raised,
      }}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: design.space.md }}>
        <Icon size={design.layout.iconSize.md} color={colors.warning.DEFAULT} />
        <View style={{ flex: 1, gap: design.space.xxs }}>
          <Text testID="offline-banner-title" variant="subheading">
            {t(noNetwork ? 'offline.noNetwork.title' : 'offline.unreachable.title')}
          </Text>
          <Text variant="callout" tone="muted">
            {noNetwork
              ? t('offline.noNetwork.message')
              : t('offline.unreachable.message', { server })}
          </Text>
          <Text testID="offline-banner-retry" variant="caption" tone="muted">
            {t(noNetwork ? 'offline.noNetwork.autoRetry' : 'offline.autoRetry')}
          </Text>
        </View>
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: design.space.md }}>
        <Button
          testID="offline-retry"
          variant="secondary"
          size="sm"
          icon={RefreshCw}
          label={t('common.retry')}
          loading={checking}
          hasTVPreferredFocus
          onPress={retry}
        />
        {checking || connectivity.state === 'checking' ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: design.space.sm }}>
            <Spinner size="sm" />
            <Text variant="caption" tone="muted">
              {t('offline.checking')}
            </Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}

/** The offline shell: the profile's downloads, the reason, Try again, profile switching and on-device settings. */
export function OfflineScreen() {
  const { t } = useTranslation();
  useScreenTitle(t('offline.title'));
  const design = useDesign();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { accounts } = useAccounts();
  const [waiting, setWaiting] = useState(() => pendingProgress());
  const noNetwork = useConnectivity().state === 'offline_no_network';
  useEffect(() => {
    const timer = setInterval(() => setWaiting(pendingProgress()), 5_000);
    return () => clearInterval(timer);
  }, []);
  // The shell is the app's root while offline: Back leaves the app instead of returning to pages that need the server.
  useBackHandler(() => {
    if (Platform.OS === 'android') BackHandler.exitApp();
    return true;
  });
  const profiles = accounts.filter((account) => account.signedIn).length;
  return (
    <ScrollView
      testID="offline-screen"
      style={{ flex: 1, backgroundColor: colors.background }}
      contentContainerStyle={{
        paddingTop: Math.max(insets.top, design.layout.edgeVertical),
        paddingBottom: Math.max(insets.bottom, design.layout.edgeVertical) + design.space['3xl'],
        ...gutterPadding(design),
        gap: design.layout.sectionGap,
        width: '100%',
        maxWidth: design.layout.maxContentWidth,
        alignSelf: 'center',
      }}>
      <DownloadsLibrary
        offline
        header={
          <View style={{ gap: design.layout.sectionGap }}>
            <OfflineBanner />
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: design.space.md }}>
              <Text variant="title" role="heading" style={{ flex: 1 }}>
                {t('offline.title')}
              </Text>
              {profiles > 1 ? (
                <Button
                  testID="offline-switch-profile"
                  variant="secondary"
                  size="sm"
                  icon={Users}
                  label={t('settings.account.switch')}
                  onPress={() => router.push('/profiles')}
                />
              ) : null}
            </View>
            {waiting ? (
              <Text testID="offline-sync" variant="caption" tone="muted">
                {t(noNetwork ? 'offline.noNetwork.sync' : 'offline.sync')}
              </Text>
            ) : null}
          </View>
        }
      />
      <SettingsSection title={t('offline.settings')} testID="offline-settings">
        <LanguageRow />
        <PerformanceRow />
      </SettingsSection>
      <DownloadsSettingsSection offline />
    </ScrollView>
  );
}
