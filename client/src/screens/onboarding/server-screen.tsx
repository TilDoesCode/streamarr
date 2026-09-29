import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View, type TextInput } from 'react-native';

import { useAccounts } from '@/accounts/accounts-provider';
import { probeServer, type ServerInfo } from '@/api/probe';
import { displayServerUrl } from '@/api/server-url';
import { Button } from '@/components/ui/button';
import { FormMessage } from '@/components/ui/form-message';
import { Text } from '@/components/ui/text';
import { TextField } from '@/components/ui/text-field';
import { queryKeys } from '@/query/keys';
import { useDesign } from '@/theme';

import { AuthScaffold } from './auth-scaffold';
import { FormError } from './form-parts';

/** Step 1: which server. Normalises the address, probes the viewer auth options, warns on remote http. */
export function ServerScreen() {
  const { t } = useTranslation();
  const design = useDesign();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { accounts } = useAccounts();
  const params = useLocalSearchParams<{ address?: string }>();
  const inputRef = useRef<TextInput>(null);
  const [address, setAddress] = useState(params.address ?? '');
  const [fieldError, setFieldError] = useState<string>();
  const [insecure, setInsecure] = useState<ServerInfo | null>(null);

  const proceed = (info: ServerInfo) =>
    router.push({ pathname: '/sign-in', params: { server: info.baseUrl } });

  const probe = useMutation({
    mutationFn: (input: string) => probeServer(input),
    onSuccess: (info) => {
      queryClient.setQueryData(queryKeys.serverOptions(info.baseUrl), info);
      if (info.insecure) setInsecure(info);
      else proceed(info);
    },
  });

  const connect = (input = address) => {
    if (probe.isPending) return;
    if (!input.trim()) {
      setFieldError(t('onboarding.validation.addressRequired'));
      return;
    }
    setFieldError(undefined);
    setInsecure(null);
    probe.mutate(input);
  };

  const known = accounts.filter(
    (account, index) => accounts.findIndex((a) => a.serverUrl === account.serverUrl) === index
  );

  return (
    <AuthScaffold
      testID="server-screen"
      title={t('onboarding.server.title')}
      subtitle={t('onboarding.server.subtitle')}>
      <TextField
        ref={inputRef}
        testID="server-address"
        label={t('onboarding.server.label')}
        placeholder={t('onboarding.server.placeholder')}
        value={address}
        onChangeText={(value) => {
          setAddress(value);
          setFieldError(undefined);
          setInsecure(null);
          probe.reset();
        }}
        error={fieldError}
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="url"
        textContentType="URL"
        keyboardType="url"
        inputMode="url"
        returnKeyType="go"
        submitBehavior="blurAndSubmit"
        onSubmitEditing={() => connect()}
        initialFocus
      />
      <FormError error={probe.error} />
      {insecure ? (
        <FormMessage
          testID="server-insecure"
          tone="warning"
          title={t('onboarding.server.insecureTitle')}
          message={t('onboarding.server.insecureMessage', {
            host: displayServerUrl(insecure.baseUrl),
          })}
          actions={
            <>
              <Button
                testID="server-insecure-continue"
                size="sm"
                variant="secondary"
                label={t('onboarding.server.continueAnyway')}
                onPress={() => proceed(insecure)}
              />
              <Button
                size="sm"
                variant="ghost"
                label={t('onboarding.server.changeAddress')}
                onPress={() => {
                  setInsecure(null);
                  inputRef.current?.focus();
                }}
              />
            </>
          }
        />
      ) : null}
      <Button
        testID="server-connect"
        label={t('onboarding.server.connect')}
        size="lg"
        loading={probe.isPending}
        onPress={() => connect()}
      />
      {known.length ? (
        <View style={{ gap: design.space.sm, marginTop: design.space.md }}>
          <Text variant="overline" tone="subtle">
            {t('onboarding.server.known')}
          </Text>
          {known.map((account) => (
            <Button
              key={account.serverUrl}
              testID={`known-server-${account.id}`}
              variant="secondary"
              label={t('onboarding.serverChip', {
                name: account.serverName,
                url: displayServerUrl(account.serverUrl),
              })}
              onPress={() => {
                setAddress(account.serverUrl);
                connect(account.serverUrl);
              }}
            />
          ))}
        </View>
      ) : null}
    </AuthScaffold>
  );
}
