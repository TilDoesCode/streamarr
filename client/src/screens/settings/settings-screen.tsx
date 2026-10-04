import { useQuery, useQueryClient } from '@tanstack/react-query';
import Constants from 'expo-constants';
import { useFocusEffect, useRouter } from 'expo-router';
import { Clapperboard, LayoutGrid, LogOut, Pencil, Users } from '@/components/icons';
import { useCallback, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { GlassChip } from '@/components/glass';
import { useAccountsApi, useActiveAccount } from '@/accounts/accounts-provider';
import { unwrap } from '@/api/client';
import { displayServerUrl } from '@/api/server-url';
import { END_OF_ROW, FocusGuide, FocusSection } from '@/components/focus';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { SkeletonText } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import {
  LANGUAGE_PREFERENCES,
  setLanguagePreference,
  useLanguagePreference,
  type LanguagePreference,
} from '@/i18n';
import { platformKey } from '@/lib/platform';
import { useScreenTitle } from '@/navigation/screen-title';
import { DevicesSection, SecuritySection } from '@/screens/settings/account-security';
import { ProfileEditor } from '@/screens/settings/profile-editor';
import { accountKey } from '@/query/keys';
import { SHELL } from '@/shell/shell-metrics';
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
        maxWidth: shell.large ? shell.s(1280) : design.layout.maxContentWidth,
      }}
      snapToAlignment={design.isTV ? 'item' : undefined}
      snapToItemPadding={design.isTV ? design.layout.edgeVertical : undefined}>
      {pageHeading ? (
        <Text variant="title" role="heading" style={shell.pageTitle}>
          {t('tabs.settings')}
        </Text>
      ) : null}
      <AccountSection />
      <SecuritySection />
      <DevicesSection />
      <LanguageSection />
      <AboutSection />
      {__DEV__ ? <DeveloperSection /> : null}
    </ScrollView>
  );
}

function Section({
  title,
  children,
  testID,
  pageTop,
}: {
  title: string;
  children: ReactNode;
  testID?: string;
  pageTop?: boolean;
}) {
  const design = useDesign();
  return (
    <FocusSection testID={testID} pageTop={pageTop}>
      <View style={{ gap: design.space.md }}>
        <Text variant="overline" tone="subtle">
          {title}
        </Text>
        {children}
      </View>
    </FocusSection>
  );
}

function ButtonRow({ children }: { children: ReactNode }) {
  const design = useDesign();
  const buttonGap = useFocusGap(design.space.md);
  return (
    <FocusGuide
      remember
      trap={END_OF_ROW}
      style={{ flexDirection: 'row', flexWrap: 'wrap', gap: buttonGap }}>
      {children}
    </FocusGuide>
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
    <Section title={t('settings.account.title')} testID="settings-account" pageTop>
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
      <ButtonRow>
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
      </ButtonRow>
      {editing && !design.isTV ? <ProfileEditor onDone={() => setEditing(false)} /> : null}
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
    </Section>
  );
}

export function LanguageSection() {
  const { t, i18n } = useTranslation();
  const design = useDesign();
  const chipGap = useFocusGap(design.space.sm);
  const preference = useLanguagePreference();
  const label = (value: LanguagePreference) => t(`language.${value}`);
  return (
    <Section title={t('language.title')} testID="settings-language">
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
      <Text testID="settings-language-current" variant="callout" tone="muted">
        {t('language.current', { language: label(i18n.language === 'de' ? 'de' : 'en') })}
      </Text>
    </Section>
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
    <Section title={t('settings.about.title')} testID="settings-about">
      <View style={{ gap: design.space.sm }}>
        <InfoRow
          label={t('settings.about.appVersion')}
          value={Constants.expoConfig?.version ?? t('settings.about.unavailable')}
        />
        <InfoRow
          label={t('settings.about.device')}
          value={`${t(`platform.${platformKey()}`)} · ${t(`formFactor.${design.formFactor}`)}`}
        />
        <InfoRow label={t('settings.about.server')} value={account.serverName} />
        <InfoRow label={t('settings.about.address')} value={displayServerUrl(account.serverUrl)} />
        <InfoRow
          testID="settings-server-version"
          label={t('settings.about.serverVersion')}
          value={serverVersion}
        />
      </View>
    </Section>
  );
}

function InfoRow({ label, value, testID }: { label: string; value?: string; testID?: string }) {
  const design = useDesign();
  return (
    <View style={{ flexDirection: 'row', gap: design.space.lg, alignItems: 'baseline' }}>
      <Text variant="callout" tone="muted" style={{ width: design.px(160) }}>
        {label}
      </Text>
      {value === undefined ? (
        <View style={{ flex: 1 }}>
          <SkeletonText width="30%" />
        </View>
      ) : (
        <Text testID={testID} variant="body" selectable style={{ flex: 1 }}>
          {value}
        </Text>
      )}
    </View>
  );
}

function DeveloperSection() {
  const { t } = useTranslation();
  const router = useRouter();
  return (
    <Section title={t('settings.developer.title')} testID="settings-developer">
      <ButtonRow>
        <Button
          testID="open-gallery"
          variant="secondary"
          icon={LayoutGrid}
          label={t('settings.developer.gallery')}
          onPress={() => router.push('/dev/gallery')}
        />
        <Button
          testID="open-player-lab"
          variant="secondary"
          icon={Clapperboard}
          label={t('settings.developer.playerLab')}
          onPress={() => router.push('/dev/player')}
        />
      </ButtonRow>
    </Section>
  );
}
