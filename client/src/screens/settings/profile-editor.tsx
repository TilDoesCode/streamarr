import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check } from '@/components/icons';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { useAccountsApi, useActiveAccount } from '@/accounts/accounts-provider';
import { AVATAR_KEYS, profileColor } from '@/accounts/account-store';
import { syncProfile } from '@/accounts/use-profile-sync';
import { unwrap } from '@/api/client';
import { END_OF_ROW, Focusable, FocusGuide, FocusLift } from '@/components/focus';
import { GlassChip } from '@/components/glass';
import { Avatar, avatarColor } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { FormMessage } from '@/components/ui/form-message';
import { TextField } from '@/components/ui/text-field';
import { Text } from '@/components/ui/text';
import { useToast } from '@/components/ui/toast';
import { queryKeys } from '@/query/keys';
import { accountErrorText } from '@/screens/settings/account-security';
import { colors, useDesign, useFocusGap } from '@/theme';

const DISPLAY_NAME_MAX = 64;

/** A name of only whitespace: neither a name nor the empty "use my username". */
export function isBlankName(name: string): boolean {
  return name.length > 0 && name.trim().length === 0;
}

/** Display name and avatar colour (PATCH /viewer/me); an empty name or "Automatic" resets to the default. */
export function ProfileEditor({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation();
  const design = useDesign();
  const buttonGap = useFocusGap(design.space.md);
  const toast = useToast();
  const api = useAccountsApi();
  const queryClient = useQueryClient();
  const { account, client } = useActiveAccount();
  const [name, setName] = useState(account.displayName);
  const [avatarKey, setAvatarKey] = useState<string | null>(account.avatarKey ?? null);
  const save = useMutation({
    mutationFn: () =>
      unwrap(
        client.PATCH('/api/v1/viewer/me', {
          body: { displayName: name.trim() || null, avatarKey },
        })
      ),
    onSuccess: (profile) => {
      queryClient.setQueryData(queryKeys.me(account.id), profile);
      syncProfile(api, account, profile);
      toast.show({ tone: 'success', message: t('settings.profile.saved') });
      onDone();
    },
  });
  // Empty resets to the username; only spaces is a mistake the server rejects (400).
  const blank = isBlankName(name);
  const error = save.error ? accountErrorText(t, save.error) : null;
  const preview = name.trim() || account.username;
  const swatch = design.px(40);
  return (
    <View testID="settings-profile-editor" style={{ gap: design.space.md }}>
      <TextField
        testID="settings-profile-name"
        label={t('settings.profile.name')}
        hint={t('settings.profile.nameHint', { username: account.username })}
        value={name}
        onChangeText={(value) => {
          setName(value);
          save.reset();
        }}
        error={
          blank
            ? t('settings.profile.nameBlank', { username: account.username })
            : error?.code === 'invalid_display_name'
              ? error.message
              : undefined
        }
        maxLength={DISPLAY_NAME_MAX}
        autoComplete="nickname"
        autoCorrect={false}
        returnKeyType="done"
        initialFocus
      />
      <Text variant="callout" tone="muted">
        {t('settings.profile.avatar')}
      </Text>
      <FocusGuide
        remember
        trap={END_OF_ROW}
        role="radiogroup"
        style={{
          flexDirection: 'row',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: design.space.sm,
        }}>
        <Avatar
          name={preview}
          color={profileColor(account.viewerId, avatarKey)}
          size={design.px(48)}
          round
        />
        {AVATAR_KEYS.map((key, slot) => (
          <Focusable
            key={key}
            testID={`settings-profile-avatar-${key}`}
            role="radio"
            aria-checked={avatarKey === key}
            accessibilityLabel={t(`settings.profile.colors.${key}`)}
            onPress={() => setAvatarKey(key)}>
            <FocusLift kind="button" radius={swatch / 2}>
              <View
                style={{
                  width: swatch,
                  height: swatch,
                  borderRadius: swatch / 2,
                  backgroundColor: avatarColor(slot),
                  borderWidth: avatarKey === key ? 3 : 0,
                  borderColor: colors.foreground.DEFAULT,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}>
                {avatarKey === key ? (
                  <Check size={design.px(20)} color={colors.foreground.DEFAULT} />
                ) : null}
              </View>
            </FocusLift>
          </Focusable>
        ))}
        <GlassChip
          testID="settings-profile-avatar-auto"
          role="radio"
          aria-checked={avatarKey === null}
          selected={avatarKey === null}
          label={t('settings.profile.automatic')}
          onPress={() => setAvatarKey(null)}
        />
      </FocusGuide>
      {error && error.code !== 'invalid_display_name' ? (
        <FormMessage
          tone="danger"
          testID={`settings-profile-error-${error.code}`}
          title={error.title}
          message={error.message}
        />
      ) : null}
      <FocusGuide
        remember
        trap={END_OF_ROW}
        style={{ flexDirection: 'row', flexWrap: 'wrap', gap: buttonGap }}>
        <Button
          testID="settings-profile-save"
          label={t('settings.profile.save')}
          loading={save.isPending}
          disabled={blank}
          onPress={() => !save.isPending && !blank && save.mutate()}
        />
        <Button
          testID="settings-profile-cancel"
          variant="secondary"
          label={t('common.cancel')}
          onPress={onDone}
        />
      </FocusGuide>
    </View>
  );
}
