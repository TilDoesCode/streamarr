import { useMutation } from '@tanstack/react-query';
import { ArrowLeft } from '@/components/icons';
import { Redirect, useLocalSearchParams, useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View, type TextInput } from 'react-native';

import { useSessionGate } from '@/accounts/accounts-provider';
import { createAuthApi } from '@/accounts/auth-api';
import { signInFlow } from '@/accounts/sign-in-flow';
import { describeError } from '@/api/error-text';
import { toAppError } from '@/api/errors';
import { ErrorState } from '@/components/states/error-state';
import { Button } from '@/components/ui/button';
import { FormMessage } from '@/components/ui/form-message';
import { Spinner } from '@/components/ui/spinner';
import { TextField } from '@/components/ui/text-field';
import { colors, useDesign } from '@/theme';

import { AuthScaffold } from './auth-scaffold';
import { FormError, FormLinks, PasswordField } from './form-parts';
import { enterApp, useCompleteSignIn, useLeftOnboarding, useServerInfo } from './use-onboarding';

export type SignInParams = { server?: string; login?: string; reason?: string };

/** Step 2: password sign-in, with links to the email code and password reset flows. */
export function SignInScreen() {
  const { server: serverUrl, login: initialLogin, reason } = useLocalSearchParams<SignInParams>();
  const info = useServerInfo(serverUrl);
  const { t } = useTranslation();
  const router = useRouter();
  const left = useLeftOnboarding();

  if (left) return <Redirect href="/" />;
  if (!serverUrl) return <Redirect href="/server" />;
  if (!info.data) {
    return (
      <View
        style={{
          flex: 1,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: colors.background,
        }}>
        {info.error ? (
          <ErrorState
            testID="sign-in-server-error"
            code={toAppError(info.error).code}
            actions={['retry', 'back']}
            autoFocus
            onAction={(action) =>
              action === 'retry'
                ? void info.refetch()
                : router.canGoBack()
                  ? router.back()
                  : router.replace({ pathname: '/server', params: { address: serverUrl } })
            }
          />
        ) : (
          <Spinner accessibilityLabel={t('a11y.loading')} />
        )}
      </View>
    );
  }
  return (
    <SignInForm
      serverUrl={serverUrl}
      serverName={info.data.name}
      initialLogin={initialLogin}
      reason={reason}
    />
  );
}

function SignInForm({
  serverUrl,
  serverName,
  initialLogin,
  reason,
}: {
  serverUrl: string;
  serverName: string;
  initialLogin?: string;
  reason?: string;
}) {
  const { t } = useTranslation();
  const design = useDesign();
  const router = useRouter();
  const info = useServerInfo(serverUrl);
  const complete = useCompleteSignIn();
  const passwordRef = useRef<TextInput>(null);
  const [login, setLogin] = useState(initialLogin ?? '');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<{ login?: string; password?: string }>({});
  const options = info.data?.options;

  const signIn = useMutation({
    mutationFn: () => createAuthApi(serverUrl).password(login.trim(), password),
    onSuccess: async (result) => {
      if (result.kind === 'second_factor') {
        signInFlow.startSecondFactor({
          serverUrl,
          login: login.trim(),
          mfaToken: result.mfaToken,
          expiresAt: result.expiresAt,
          password,
        });
        router.push({ pathname: '/sign-in/second-factor', params: { server: serverUrl } });
        return;
      }
      if (info.data) await complete(info.data, result, password);
    },
    onError: (error) => {
      // Wrong password: back into the field with it selected, ready to retype (TV: no keyboard pop-up).
      if (design.isTV || toAppError(error).code !== 'invalid_credentials') return;
      passwordRef.current?.focus();
      passwordRef.current?.setSelection(0, password.length);
    },
  });
  // Opened while a profile is signed in (deep link, add profile): a way back to it.
  const signedIn = useSessionGate().reason === 'ready';

  const submit = () => {
    if (signIn.isPending) return;
    const next = {
      login: login.trim() ? undefined : t('onboarding.validation.loginRequired'),
      password: password ? undefined : t('onboarding.validation.passwordRequired'),
    };
    setErrors(next);
    if (next.login || next.password) return;
    signIn.mutate();
  };

  const loginParams = { server: serverUrl, ...(login.trim() ? { login: login.trim() } : {}) };
  const ended = reason ? describeError(t, { code: reason }) : null;

  return (
    <AuthScaffold
      testID="sign-in-screen"
      title={t('onboarding.signIn.title')}
      subtitle={t('onboarding.signIn.subtitle', { server: serverName })}
      server={{ name: serverName, url: serverUrl }}>
      {ended && !signIn.error ? (
        <FormMessage tone="warning" title={ended.title} message={ended.message} />
      ) : null}
      <TextField
        testID="sign-in-login"
        label={t('onboarding.signIn.login')}
        value={login}
        onChangeText={(value) => {
          setLogin(value);
          setErrors((current) => ({ ...current, login: undefined }));
        }}
        error={errors.login}
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="username"
        textContentType="username"
        returnKeyType="next"
        submitBehavior="submit"
        onSubmitEditing={() => passwordRef.current?.focus()}
        initialFocus={!initialLogin}
      />
      <PasswordField
        ref={passwordRef}
        testID="sign-in-password"
        label={t('onboarding.signIn.password')}
        value={password}
        onChangeText={(value) => {
          setPassword(value);
          setErrors((current) => ({ ...current, password: undefined }));
        }}
        error={errors.password}
        autoComplete="current-password"
        textContentType="password"
        returnKeyType="go"
        submitBehavior="blurAndSubmit"
        onSubmitEditing={submit}
        initialFocus={!!initialLogin}
      />
      <FormError error={signIn.error} />
      <Button
        testID="sign-in-submit"
        size="lg"
        label={t('onboarding.signIn.submit')}
        loading={signIn.isPending}
        onPress={submit}
      />
      <FormLinks>
        {options?.emailCodeLogin ? (
          <Button
            testID="sign-in-email-code"
            variant="ghost"
            label={t('onboarding.signIn.emailCode')}
            disabled={signIn.isPending}
            onPress={() => router.push({ pathname: '/sign-in/email-code', params: loginParams })}
          />
        ) : null}
        {options?.passwordReset ? (
          <Button
            testID="sign-in-forgot"
            variant="ghost"
            label={t('onboarding.signIn.forgot')}
            disabled={signIn.isPending}
            onPress={() =>
              router.push({ pathname: '/sign-in/forgot-password', params: loginParams })
            }
          />
        ) : null}
        <Button
          testID="sign-in-change-server"
          variant="ghost"
          label={t('onboarding.signIn.changeServer')}
          disabled={signIn.isPending}
          onPress={() => router.push('/server')}
        />
        {signedIn ? (
          <Button
            testID="sign-in-back-to-app"
            variant="ghost"
            icon={ArrowLeft}
            label={t('onboarding.signIn.backToApp')}
            disabled={signIn.isPending}
            onPress={() => enterApp(router)}
          />
        ) : null}
      </FormLinks>
      <View style={{ height: design.space.xs }} />
    </AuthScaffold>
  );
}
