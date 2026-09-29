import { useMutation } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { createAuthApi } from '@/accounts/auth-api';
import { signInFlow } from '@/accounts/sign-in-flow';
import { Button } from '@/components/ui/button';
import { TextField } from '@/components/ui/text-field';
import { useToast } from '@/components/ui/toast';

import { AuthScaffold } from './auth-scaffold';
import { FormError, FormLinks } from './form-parts';
import { useCompleteSignIn, useServerInfo } from './use-onboarding';

type Params = { server?: string; login?: string };

/** Asks for the login and requests an emailed sign-in code (the answer never reveals the account). */
export function EmailCodeScreen() {
  const { server: serverUrl = '', login: initialLogin } = useLocalSearchParams<Params>();
  const { t } = useTranslation();
  const router = useRouter();
  const info = useServerInfo(serverUrl);
  const [login, setLogin] = useState(initialLogin ?? '');
  const [fieldError, setFieldError] = useState<string>();

  const send = useMutation({
    mutationFn: () => createAuthApi(serverUrl).requestEmailCode(login.trim()),
    onSuccess: () =>
      router.push({
        pathname: '/sign-in/verify-code',
        params: { server: serverUrl, login: login.trim() },
      }),
  });

  const submit = () => {
    if (send.isPending) return;
    if (!login.trim()) return setFieldError(t('onboarding.validation.loginRequired'));
    setFieldError(undefined);
    send.mutate();
  };

  return (
    <AuthScaffold
      testID="email-code-screen"
      title={t('onboarding.emailCode.title')}
      subtitle={t('onboarding.emailCode.subtitle')}
      server={info.data ? { name: info.data.name, url: serverUrl } : undefined}>
      <TextField
        testID="email-code-login"
        label={t('onboarding.signIn.login')}
        value={login}
        onChangeText={(value) => {
          setLogin(value);
          setFieldError(undefined);
        }}
        error={fieldError}
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="username"
        textContentType="username"
        returnKeyType="send"
        submitBehavior="blurAndSubmit"
        onSubmitEditing={submit}
        initialFocus
      />
      <FormError error={send.error} />
      <Button
        testID="email-code-send"
        size="lg"
        label={t('onboarding.emailCode.send')}
        loading={send.isPending}
        onPress={submit}
      />
    </AuthScaffold>
  );
}

/** Redeems the emailed code; continues with the second factor when the account has one. */
export function VerifyCodeScreen() {
  const { server: serverUrl = '', login = '' } = useLocalSearchParams<Params>();
  const { t } = useTranslation();
  const router = useRouter();
  const toast = useToast();
  const info = useServerInfo(serverUrl);
  const complete = useCompleteSignIn();
  const [code, setCode] = useState('');
  const [fieldError, setFieldError] = useState<string>();

  const verify = useMutation({
    mutationFn: () => createAuthApi(serverUrl).verifyEmailCode(login, code.trim().toUpperCase()),
    onSuccess: async (result) => {
      if (result.kind === 'second_factor') {
        signInFlow.startSecondFactor({
          serverUrl,
          login,
          mfaToken: result.mfaToken,
          expiresAt: result.expiresAt,
        });
        router.push({ pathname: '/sign-in/second-factor', params: { server: serverUrl } });
        return;
      }
      if (info.data) await complete(info.data, result);
    },
  });
  const resend = useMutation({
    mutationFn: () => createAuthApi(serverUrl).requestEmailCode(login),
    onSuccess: () => toast.show({ tone: 'success', message: t('onboarding.emailCode.resent') }),
  });

  const submit = () => {
    if (verify.isPending) return;
    if (!code.trim()) return setFieldError(t('onboarding.validation.codeRequired'));
    setFieldError(undefined);
    verify.mutate();
  };

  return (
    <AuthScaffold
      testID="verify-code-screen"
      title={t('onboarding.emailCode.verifyTitle')}
      subtitle={t('onboarding.emailCode.verifySubtitle', { login })}
      server={info.data ? { name: info.data.name, url: serverUrl } : undefined}>
      <TextField
        testID="verify-code-code"
        label={t('onboarding.emailCode.code')}
        placeholder={t('onboarding.emailCode.codePlaceholder')}
        value={code}
        onChangeText={(value) => {
          setCode(value);
          setFieldError(undefined);
        }}
        error={fieldError}
        autoCapitalize="characters"
        autoCorrect={false}
        autoComplete="one-time-code"
        textContentType="oneTimeCode"
        maxLength={12}
        returnKeyType="go"
        submitBehavior="blurAndSubmit"
        onSubmitEditing={submit}
        initialFocus
      />
      <FormError error={verify.error ?? resend.error} />
      <Button
        testID="verify-code-submit"
        size="lg"
        label={t('onboarding.emailCode.submit')}
        loading={verify.isPending}
        onPress={submit}
      />
      <FormLinks>
        <Button
          testID="verify-code-resend"
          variant="ghost"
          label={t('onboarding.emailCode.resend')}
          loading={resend.isPending}
          disabled={verify.isPending}
          onPress={() => resend.mutate()}
        />
      </FormLinks>
    </AuthScaffold>
  );
}
