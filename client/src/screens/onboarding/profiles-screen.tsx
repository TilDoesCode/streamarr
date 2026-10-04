import { Redirect, useRouter } from 'expo-router';
import { Pencil, Plus } from '@/components/icons';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Animated, { interpolateColor, useAnimatedStyle } from 'react-native-reanimated';

import { useAccounts, useAccountsApi } from '@/accounts/accounts-provider';
import type { Account } from '@/accounts/types';
import { describeError } from '@/api/error-text';
import { CENTRED_ROW, FocusGuide, Focusable, FocusLift, useFocusState } from '@/components/focus';
import { displayServerUrl } from '@/api/server-url';
import { AmbientBackdrop } from '@/components/ambient';
import { ShellBrand } from '@/shell/brand-mark';
import { ShellDesign } from '@/shell/shell-design';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Text } from '@/components/ui/text';
import { colors, useDesign } from '@/theme';

import { useScreenTitle } from '@/navigation/screen-title';
import { onboardingExit } from '@/navigation/web-hosting';

import { enterApp } from './use-onboarding';

/** "Who's watching?": pick, add, sign out or remove profiles (accounts on one or more servers). */
export function ProfilesScreen() {
  return (
    <ShellDesign>
      <ProfilesContent />
    </ShellDesign>
  );
}

function ProfilesContent() {
  const { t } = useTranslation();
  useScreenTitle(t('profiles.title'));
  const design = useDesign();
  const router = useRouter();
  const api = useAccountsApi();
  const { accounts, activeId } = useAccounts();
  const [managing, setManaging] = useState(false);
  const [selected, setSelected] = useState<Account | null>(null);
  const [removing, setRemoving] = useState<Account | null>(null);

  if (!accounts.length) return <Redirect href="/server" />;

  const servers = new Set(accounts.map((account) => account.serverUrl));
  // Two servers with the same name: the address tells the tiles apart.
  const serverLabel = (account: Account) => {
    const twin = accounts.some(
      (other) => other.serverName === account.serverName && other.serverUrl !== account.serverUrl
    );
    return twin
      ? t('onboarding.serverChip', {
          name: account.serverName,
          url: displayServerUrl(account.serverUrl),
        })
      : account.serverName;
  };
  const tile = design.px(design.formFactor === 'phone' ? 88 : 104);

  const choose = (account: Account) => {
    if (managing) return setSelected(account);
    if (!account.signedIn)
      return router.push({
        pathname: '/sign-in',
        params: {
          server: account.serverUrl,
          login: account.username,
          ...(account.endedReason ? { reason: account.endedReason } : {}),
        },
      });
    api.activate(account.id);
    if (account.mustChangePassword)
      return router.push({ pathname: '/sign-in/change-password', params: { account: account.id } });
    enterApp(router);
  };

  return (
    <SafeAreaView testID="profiles-screen" style={{ flex: 1, backgroundColor: colors.background }}>
      <AmbientBackdrop />
      <ShellBrand />
      <ScrollView
        contentContainerStyle={{
          flexGrow: 1,
          alignItems: 'center',
          justifyContent: 'center',
          gap: design.space['3xl'],
          paddingHorizontal: design.layout.gutter,
          paddingVertical: design.layout.edgeVertical + design.space['2xl'],
        }}>
        <Text variant="display" style={{ textAlign: 'center' }}>
          {managing ? t('profiles.manageTitle') : t('profiles.title')}
        </Text>
        <FocusGuide
          remember
          trap={CENTRED_ROW}
          style={{
            flexDirection: 'row',
            flexWrap: 'wrap',
            justifyContent: 'center',
            gap: design.space['2xl'],
            maxWidth: design.px(900),
          }}>
          {accounts.map((account) => (
            <ProfileTile
              key={account.id}
              testID={`profile-${account.username}`}
              size={tile}
              name={account.displayName}
              color={account.color}
              caption={
                !account.signedIn
                  ? account.endedReason
                    ? describeError(t, { code: account.endedReason }).title
                    : t('profiles.signedOut')
                  : servers.size > 1
                    ? t('profiles.onServer', { server: serverLabel(account) })
                    : undefined
              }
              dimmed={!account.signedIn}
              editing={managing}
              preferred={account.id === activeId}
              accessibilityLabel={
                managing ? t('profiles.edit', { name: account.displayName }) : account.displayName
              }
              onPress={() => choose(account)}
            />
          ))}
          {managing ? null : (
            <ProfileTile
              testID="profile-add"
              size={tile}
              name={t('profiles.add')}
              icon={<Plus size={tile * 0.36} color={colors.foreground.muted} strokeWidth={1.75} />}
              accessibilityLabel={t('profiles.add')}
              preferred={!activeId}
              onPress={() => {
                onboardingExit.reset();
                router.push('/server');
              }}
            />
          )}
        </FocusGuide>
        <Button
          testID="profiles-manage"
          variant={managing ? 'primary' : 'secondary'}
          label={managing ? t('profiles.done') : t('profiles.manage')}
          icon={managing ? undefined : Pencil}
          onPress={() => setManaging((current) => !current)}
        />
      </ScrollView>

      <Dialog
        testID="profile-actions"
        open={!!selected}
        onClose={() => setSelected(null)}
        title={selected?.displayName ?? ''}
        message={selected ? t('profiles.onServer', { server: selected.serverName }) : undefined}
        actions={
          selected
            ? [
                selected.signedIn
                  ? {
                      label: t('profiles.signOut'),
                      variant: 'secondary' as const,
                      onPress: () => {
                        const account = selected;
                        setSelected(null);
                        void api.signOut(account.id);
                      },
                    }
                  : {
                      label: t('profiles.signIn'),
                      variant: 'secondary' as const,
                      onPress: () => {
                        const account = selected;
                        setSelected(null);
                        setManaging(false);
                        choose({ ...account });
                      },
                    },
                {
                  label: t('profiles.remove'),
                  variant: 'destructive' as const,
                  onPress: () => {
                    setRemoving(selected);
                    setSelected(null);
                  },
                },
                {
                  label: t('common.cancel'),
                  variant: 'ghost' as const,
                  onPress: () => setSelected(null),
                  preferred: true,
                },
              ]
            : []
        }
      />
      <Dialog
        testID="profile-remove"
        open={!!removing}
        onClose={() => setRemoving(null)}
        title={t('profiles.removeTitle', { name: removing?.displayName ?? '' })}
        message={t('profiles.removeMessage')}
        actions={[
          {
            label: t('common.cancel'),
            variant: 'secondary',
            onPress: () => setRemoving(null),
            preferred: true,
          },
          {
            label: t('profiles.removeConfirm'),
            variant: 'destructive',
            onPress: () => {
              const account = removing;
              setRemoving(null);
              if (account) void api.remove(account.id);
            },
          },
        ]}
      />
    </SafeAreaView>
  );
}

type ProfileTileProps = {
  size: number;
  name: string;
  color?: number;
  icon?: ReactNode;
  caption?: string;
  dimmed?: boolean;
  editing?: boolean;
  preferred?: boolean;
  accessibilityLabel: string;
  onPress: () => void;
  testID?: string;
};

function ProfileTile({
  size,
  name,
  color = 0,
  icon,
  caption,
  dimmed,
  editing,
  preferred,
  accessibilityLabel,
  onPress,
  testID,
}: ProfileTileProps) {
  const design = useDesign();
  return (
    <Focusable
      testID={testID}
      role="button"
      accessibilityLabel={caption ? `${accessibilityLabel}, ${caption}` : accessibilityLabel}
      hasTVPreferredFocus={preferred}
      onPress={onPress}
      style={{ width: size + design.space.lg, alignItems: 'center' }}>
      <FocusLift kind="card" radius={design.radius.lg * (size / design.px(64))}>
        {icon ? (
          <View
            style={{
              width: size,
              height: size,
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: design.radius.lg * (size / design.px(64)),
              borderCurve: 'continuous',
              borderWidth: design.px(2),
              borderStyle: 'dashed',
              borderColor: colors.border,
            }}>
            {icon}
          </View>
        ) : (
          <View>
            <Avatar name={name} color={color} size={size} dimmed={dimmed} />
            {editing ? <EditBadge size={size} /> : null}
          </View>
        )}
      </FocusLift>
      <TileLabel name={name} caption={caption} />
    </Focusable>
  );
}

function EditBadge({ size }: { size: number }) {
  const badge = size * 0.32;
  return (
    <View
      style={{
        position: 'absolute',
        right: -badge * 0.2,
        bottom: -badge * 0.2,
        width: badge,
        height: badge,
        borderRadius: badge / 2,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: colors.surface.overlay,
        borderWidth: 2,
        borderColor: colors.background,
      }}>
      <Pencil size={badge * 0.5} color={colors.foreground.DEFAULT} />
    </View>
  );
}

function TileLabel({ name, caption }: { name: string; caption?: string }) {
  const design = useDesign();
  const { focus, hover } = useFocusState();
  const nameStyle = useAnimatedStyle(() => ({
    color: interpolateColor(
      Math.max(focus.get(), hover.get()),
      [0, 1],
      [colors.foreground.muted, colors.foreground.DEFAULT]
    ),
  }));
  return (
    <View style={{ alignItems: 'center', marginTop: design.space.lg, gap: design.space.xxs }}>
      <Animated.Text
        numberOfLines={2}
        style={[design.type.subheading, { textAlign: 'center' }, nameStyle]}>
        {name}
      </Animated.Text>
      {caption ? (
        <Text variant="caption" tone="subtle" numberOfLines={2} style={{ textAlign: 'center' }}>
          {caption}
        </Text>
      ) : null}
    </View>
  );
}
