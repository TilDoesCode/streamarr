import { useQuery, useQueryClient } from '@tanstack/react-query';
import Constants from 'expo-constants';
import { useFocusEffect, useRouter } from 'expo-router';
import {
  Activity,
  Clapperboard,
  Cpu,
  Gauge,
  LayoutGrid,
  Languages,
  LogOut,
  Pencil,
  Users,
} from '@/components/icons';
import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { GlassChip } from '@/components/glass';
import { ServerStatusEntry } from '@/diagnostics/service-status-ui';
import { useAccountsApi, useActiveAccount } from '@/accounts/accounts-provider';
import { unwrap } from '@/api/client';
import { displayServerUrl } from '@/api/server-url';
import { END_OF_ROW, FocusGuide } from '@/components/focus';
import {
  SettingsBlock,
  SettingsButtonRow,
  SettingsInfoRow,
  SettingsRow,
  SettingsSection,
} from '@/components/settings';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Text } from '@/components/ui/text';
import {
  LANGUAGE_PREFERENCES,
  setLanguagePreference,
  useLanguagePreference,
  type LanguagePreference,
} from '@/i18n';
import { platformKey } from '@/lib/platform';
import { hostDevice } from '@modules/host-system';
import {
  deviceWeakReason,
  PERFORMANCE_PREFERENCES,
  usePerformancePreference,
  writePerformancePreference,
  type PerformancePreference,
} from '@/performance';
import { useScreenTitle } from '@/navigation/screen-title';
import { DevicesSection, SecuritySection } from '@/screens/settings/account-security';
import { ProfileEditor } from '@/screens/settings/profile-editor';
import { RankingProfileEntry } from '@/screens/settings/ranking-profile';
import { accountKey } from '@/query/keys';
import { SHELL } from '@/shell/shell-metrics';
import { TabBarClip } from '@/shell/tab-bar-clip';
import { useShell } from '@/shell/use-shell';
import { gutterPadding, useDesign, useFocusGap } from '@/theme';

/** Server build of the active account's server (anonymous health endpoint). */
function useServerVersion() {
  const { account, client } = useActiveAccount();
  return useQuery({
    queryKey: accountKey(account.id, 'server', 'health'),
    queryFn: ({ signal }) =>
      unwrap(client.GET('/api/v1/health', { signal })).then((health) => health.version ?? null),
    staleTime: 10 * 60_000,
  });
}

/** Settings tab: account (switch, sign out), language override, app and server info. */
// Native tabs keep Settings mounted: coming back refetches profile, security and devices (mount uses refetchOnMount).
function useRefetchAccountOnRefocus() {
  const queryClient = useQueryClient();
  const { account } = useActiveAccount();
  const first = useRef(true);
  useFocusEffect(
    useCallback(() => {
      if (first.current) first.current = false;
      else
        void queryClient.refetchQueries({ queryKey: accountKey(account.id, 'me'), type: 'active' });
    }, [queryClient, account.id])
  );
}

/** Large shell column incl. gutters in mockup points: 1368 of content on TV (the left gutter is 168, the right 64). */
const SETTINGS_MAX_WIDTH = 1600;

export function SettingsScreen() {
  const { t } = useTranslation();
  useScreenTitle(t('tabs.settings'));
  useRefetchAccountOnRefocus();
  const design = useDesign();
  const insets = useSafeAreaInsets();
  const shell = useShell();
  // The large shell (TV, web, tablet) has no native header: the page draws its own heading.
  const pageHeading = design.isTV || Platform.OS === 'web' || shell.large;
  return (
    <TabBarClip>
      <ScrollView
        testID="settings-screen"
        showsVerticalScrollIndicator={!shell.large && Platform.OS !== 'web'}
        style={{ flex: 1 }}
        // Apple TV: no tab-bar inset, so the heading sits at the page top like Filme/Serien.
        contentInsetAdjustmentBehavior={
          Platform.OS === 'ios' && Platform.isTV ? 'never' : 'automatic'
        }
        contentContainerStyle={{
          paddingTop: shell.large
            ? shell.s(SHELL.page.top)
            : pageHeading
              ? design.layout.edgeVertical + insets.top
              : design.space.lg,
          paddingBottom: Math.max(insets.bottom, design.layout.edgeVertical) + design.space['3xl'],
          ...gutterPadding(design),
          gap: design.layout.sectionGap,
          width: '100%',
          maxWidth: shell.large ? shell.s(SETTINGS_MAX_WIDTH) : design.layout.maxContentWidth,
        }}
        snapToAlignment={design.isTV ? 'item' : undefined}
        snapToItemPadding={design.isTV ? design.layout.edgeVertical : undefined}>
        {pageHeading ? (
          <Text variant="title" role="heading" style={shell.pageTitle}>
            {t('tabs.settings')}
          </Text>
        ) : null}
        <SettingsSection
          title={t('serviceStatus.sectionTitle')}
          testID="settings-server-status"
          pageTop
          plain>
          <ServerStatusEntry />
        </SettingsSection>
        <AccountSection />
        <SecuritySection />
        <DevicesSection />
        <AppSection />
        <PlaybackSection />
        <AboutSection />
        {__DEV__ ? <DeveloperSection /> : null}
      </ScrollView>
    </TabBarClip>
  );
}

function AccountSection() {
  const { t } = useTranslation();
  const design = useDesign();
  const router = useRouter();
  const api = useAccountsApi();
  const { account } = useActiveAccount();
  const [confirm, setConfirm] = useState(false);
  const [editing, setEditing] = useState(false);
  return (
    <SettingsSection
      title={t('settings.account.title')}
      testID="settings-account"
      pageTop
      footer={
        <Dialog
          testID="sign-out-dialog"
          open={confirm}
          onClose={() => setConfirm(false)}
          title={t('settings.account.signOutTitle', { name: account.displayName })}
          message={t('settings.account.signOutMessage')}
          actions={[
            {
              label: t('common.cancel'),
              variant: 'secondary',
              preferred: true,
              onPress: () => setConfirm(false),
            },
            {
              label: t('settings.account.signOut'),
              variant: 'destructive',
              onPress: () => {
                setConfirm(false);
                void api.signOut(account.id);
              },
            },
          ]}
        />
      }>
      <SettingsBlock>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: design.space.lg }}>
          <Avatar name={account.displayName} color={account.color} size={design.px(48)} />
          <View style={{ flex: 1, gap: design.space.xxs }}>
            <Text testID="settings-account-name" variant="subheading" numberOfLines={1}>
              {account.displayName}
            </Text>
            <Text variant="callout" tone="muted" numberOfLines={1}>
              {t('settings.account.signedInAs', {
                username: account.username,
                server: account.serverName,
              })}
            </Text>
          </View>
        </View>
        <SettingsButtonRow>
          <Button
            testID="settings-switch-profile"
            variant="secondary"
            icon={Users}
            label={t('settings.account.switch')}
            hasTVPreferredFocus
            onPress={() => router.push('/profiles')}
          />
          {/* TV shows the name and avatar; editing them needs a keyboard (phone or web). */}
          {design.isTV ? null : (
            <Button
              testID="settings-edit-profile"
              variant="secondary"
              icon={Pencil}
              aria-expanded={editing}
              label={t('settings.profile.edit')}
              onPress={() => setEditing(!editing)}
            />
          )}
          <Button
            testID="settings-sign-out"
            variant="secondary"
            icon={LogOut}
            label={t('settings.account.signOut')}
            onPress={() => setConfirm(true)}
          />
        </SettingsButtonRow>
        {editing && !design.isTV ? <ProfileEditor onDone={() => setEditing(false)} /> : null}
      </SettingsBlock>
    </SettingsSection>
  );
}

/** Per-device app preferences: language and performance mode. */
function AppSection() {
  const { t } = useTranslation();
  return (
    <SettingsSection title={t('settings.app.title')} testID="settings-app">
      <LanguageRow />
      <PerformanceRow />
    </SettingsSection>
  );
}

export function LanguageRow() {
  const { t, i18n } = useTranslation();
  const design = useDesign();
  const chipGap = useFocusGap(design.space.sm);
  const preference = useLanguagePreference();
  const label = (value: LanguagePreference) => t(`language.${value}`);
  return (
    <SettingsRow
      testID="settings-language"
      icon={Languages}
      label={t('language.title')}
      description={t('language.current', { language: label(i18n.language === 'de' ? 'de' : 'en') })}
      descriptionTestID="settings-language-current">
      <FocusGuide
        remember
        trap={END_OF_ROW}
        testID="settings-language-chips"
        style={{ flexDirection: 'row', flexWrap: 'wrap', gap: chipGap }}>
        {LANGUAGE_PREFERENCES.map((value) => (
          <GlassChip
            key={value}
            testID={`settings-language-${value}`}
            role="radio"
            aria-checked={preference === value}
            label={label(value)}
            selected={preference === value}
            onPress={() => void setLanguagePreference(value)}
          />
        ))}
      </FocusGuide>
    </SettingsRow>
  );
}

/** Playback: ranking profile, what this device can play and how it reaches the server. */
function PlaybackSection() {
  const { t } = useTranslation();
  const router = useRouter();
  return (
    <SettingsSection title={t('settings.playback.title')} testID="settings-playback">
      <RankingProfileEntry />
      <SettingsRow
        testID="settings-capabilities"
        icon={Cpu}
        label={t('settings.capabilities.title')}
        description={t('settings.capabilities.summary')}
        onPress={() => router.push('/capabilities')}
      />
      <SettingsRow
        testID="settings-connection"
        icon={Activity}
        label={t('settings.connection.title')}
        description={t('settings.connection.summary')}
        onPress={() => router.push('/connection')}
      />
    </SettingsSection>
  );
}

/** Performance mode: per device; Automatic turns the lite UI on for weak TV hardware. */
export function PerformanceRow() {
  const { t } = useTranslation();
  const design = useDesign();
  const chipGap = useFocusGap(design.space.sm);
  const preference = usePerformancePreference();
  const label = (value: PerformancePreference) => t(`settings.performance.${value}`);
  const chip = hostDevice.socModel || hostDevice.boardPlatform || '';
  const status =
    preference === 'auto'
      ? deviceWeakReason
        ? t('settings.performance.autoOn', {
            reason: t(`settings.performance.reason.${deviceWeakReason}`, { chip }),
          })
        : t('settings.performance.autoOff')
      : t(preference === 'on' ? 'settings.performance.stateOn' : 'settings.performance.stateOff');
  return (
    <SettingsRow
      testID="settings-performance"
      icon={Gauge}
      label={t('settings.performance.title')}
      description={t('settings.performance.hint')}>
      <FocusGuide
        remember
        trap={END_OF_ROW}
        testID="settings-performance-chips"
        style={{ flexDirection: 'row', flexWrap: 'wrap', gap: chipGap }}>
        {PERFORMANCE_PREFERENCES.map((value) => (
          <GlassChip
            key={value}
            testID={`settings-performance-${value}`}
            role="radio"
            aria-checked={preference === value}
            label={label(value)}
            selected={preference === value}
            onPress={() => writePerformancePreference(value)}
          />
        ))}
      </FocusGuide>
      <Text testID="settings-performance-current" variant="callout" tone="muted">
        {status}
      </Text>
    </SettingsRow>
  );
}

function AboutSection() {
  const { t } = useTranslation();
  const design = useDesign();
  const { account } = useActiveAccount();
  const server = useServerVersion();
  const serverVersion = server.data
    ? server.data.split('+')[0]
    : server.isPending
      ? undefined
      : t('settings.about.unavailable');
  return (
    <SettingsSection title={t('settings.about.title')} testID="settings-about">
      <SettingsBlock>
        <SettingsInfoRow
          label={t('settings.about.appVersion')}
          value={Constants.expoConfig?.version ?? t('settings.about.unavailable')}
        />
        <SettingsInfoRow
          label={t('settings.about.device')}
          value={`${t(`platform.${platformKey()}`)} · ${t(`formFactor.${design.formFactor}`)}`}
        />
        <SettingsInfoRow label={t('settings.about.server')} value={account.serverName} />
        <SettingsInfoRow
          label={t('settings.about.address')}
          value={displayServerUrl(account.serverUrl)}
        />
        <SettingsInfoRow
          valueTestID="settings-server-version"
          label={t('settings.about.serverVersion')}
          value={serverVersion}
          loading={serverVersion === undefined}
        />
      </SettingsBlock>
    </SettingsSection>
  );
}

function DeveloperSection() {
  const { t } = useTranslation();
  const router = useRouter();
  return (
    <SettingsSection title={t('settings.developer.title')} testID="settings-developer">
      <SettingsRow
        testID="open-gallery"
        icon={LayoutGrid}
        label={t('settings.developer.gallery')}
        onPress={() => router.push('/dev/gallery')}
      />
      <SettingsRow
        testID="open-player-lab"
        icon={Clapperboard}
        label={t('settings.developer.playerLab')}
        onPress={() => router.push('/dev/player')}
      />
    </SettingsSection>
  );
}
