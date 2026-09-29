import { useMutation } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { createAuthApi } from '@/accounts/auth-api';
import { signInFlow } from '@/accounts/sign-in-flow';
import { AppError, toAppError } from '@/api/errors';
import { Button } from '@/components/ui/button';
import { TextField } from '@/components/ui/text-field';

import { AuthScaffold } from './auth-scaffold';
import { FormError, FormLinks } from './form-parts';
import { useCompleteSignIn, useServerInfo } from './use-onboarding';

type Mode = 'authenticator' | 'recovery';

/** Second factor after the password or email code: 6-digit authenticator code or a recovery code. */
export function SecondFactorScreen() {
  const { server: serverUrl = '' } = useLocalSearchParams<{ server?: string }>();
  const { t } = useTranslation();
  const router = useRouter();
  const info = useServerInfo(serverUrl);
  const complete = useCompleteSignIn();
  const [pending] = useState(() => signInFlow.secondFactor(serverUrl));
  const [mode, setMode] = useState<Mode>('authenticator');
  const [code, setCode] = useState('');
  const [fieldError, setFieldError] = useState<string>();

  const verify = useMutation({
    mutationFn: async () => {
      if (!pending || pending.expiresAt <= Date.now()) throw new AppError('mfa_expired');
      const value = mode === 'authenticator' ? code.replace(/\s/g, '') : code.trim();
      return createAuthApi(serverUrl).secondFactor(pending.mfaToken, value);
    },
    onSuccess: async (result) => {
      if (result.kind !== 'authenticated' || !info.data) throw new AppError('server_error');
      await complete(info.data, result, pending?.password);
    },
  });

  const expired =
    !pending || (verify.error && toAppError(verify.error).code === 'mfa_expired') || false;
  const restart = () => (router.canGoBack() ? router.back() : router.replace('/server'));

  const submit = () => {
    if (verify.isPending) return;
    const value = code.replace(/\s/g, '');
    if (!value) return setFieldError(t('onboarding.validation.codeRequired'));
    if (mode === 'authenticator' && !/^\d{6}$/.test(value))
      return setFieldError(t('onboarding.validation.codeDigits'));
    setFieldError(undefined);
    verify.mutate();
  };

  const switchMode = () => {
    setMode((current) => (current === 'authenticator' ? 'recovery' : 'authenticator'));
    setCode('');
    setFieldError(undefined);
    verify.reset();
  };

  return (
    <AuthScaffold
      testID="second-factor-screen"
      title={t('onboarding.secondFactor.title')}
      subtitle={
        mode === 'authenticator'
          ? t('onboarding.secondFactor.subtitle')
          : t('onboarding.secondFactor.recoverySubtitle')
      }
      server={info.data ? { name: info.data.name, url: serverUrl } : undefined}>
      <TextField
        key={mode}
        testID="second-factor-code"
        label={
          mode === 'authenticator'
            ? t('onboarding.secondFactor.code')
            : t('onboarding.secondFactor.recoveryCode')
        }
        value={code}
        onChangeText={(value) => {
          setCode(value);
          setFieldError(undefined);
        }}
        error={fieldError}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType={mode === 'authenticator' ? 'number-pad' : 'default'}
        inputMode={mode === 'authenticator' ? 'numeric' : 'text'}
        textContentType="oneTimeCode"
        autoComplete="one-time-code"
        maxLength={mode === 'authenticator' ? 7 : 64}
        returnKeyType="go"
        submitBehavior="blurAndSubmit"
        onSubmitEditing={submit}
        editable={!expired}
        initialFocus
      />
      <FormError
        error={expired ? (verify.error ?? new AppError('mfa_expired')) : verify.error}
        actions={
          expired ? (
            <Button
              size="sm"
              variant="secondary"
              label={t('onboarding.secondFactor.restart')}
              onPress={restart}
            />
          ) : undefined
        }
      />
      <Button
        testID="second-factor-submit"
        size="lg"
        label={t('onboarding.secondFactor.submit')}
        loading={verify.isPending}
        disabled={expired}
        onPress={submit}
      />
      <FormLinks>
        <Button
          testID="second-factor-mode"
          variant="ghost"
          label={
            mode === 'authenticator'
              ? t('onboarding.secondFactor.useRecovery')
              : t('onboarding.secondFactor.useAuthenticator')
          }
          disabled={verify.isPending || expired}
          onPress={switchMode}
        />
      </FormLinks>
    </AuthScaffold>
  );
}
