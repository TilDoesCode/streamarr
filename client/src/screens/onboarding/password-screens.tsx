import { useMutation } from '@tanstack/react-query';
import { Redirect, useLocalSearchParams, useRouter } from 'expo-router';
import { useRef, useState, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import type { TextInput } from 'react-native';

import { useAccounts, useAccountsApi } from '@/accounts/accounts-provider';
import { createAuthApi } from '@/accounts/auth-api';
import { passwordProblem } from '@/accounts/password-rules';
import { signInFlow } from '@/accounts/sign-in-flow';
import { unwrap } from '@/api/client';
import { useBackHandler, useMenuClaim } from '@/components/focus';
import { Button } from '@/components/ui/button';
import { TextField } from '@/components/ui/text-field';
import { useToast } from '@/components/ui/toast';

import { AuthScaffold } from './auth-scaffold';
import { FormError, FormLinks, PasswordField } from './form-parts';
import { enterApp, usePasswordProblemText, useServerInfo } from './use-onboarding';

type Params = { server?: string; login?: string };

const DEFAULT_MIN_LENGTH = 8;

/** Requests a password reset code by email. */
export function ForgotPasswordScreen() {
  const { server: serverUrl = '', login: initialLogin } = useLocalSearchParams<Params>();
  const { t } = useTranslation();
  const router = useRouter();
  const info = useServerInfo(serverUrl);
  const [login, setLogin] = useState(initialLogin ?? '');
  const [fieldError, setFieldError] = useState<string>();

  const send = useMutation({
    mutationFn: () => createAuthApi(serverUrl).forgotPassword(login.trim()),
    onSuccess: () =>
      router.push({
        pathname: '/sign-in/reset-password',
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
      testID="forgot-password-screen"
      title={t('onboarding.forgot.title')}
      subtitle={t('onboarding.forgot.subtitle')}
      server={info.data ? { name: info.data.name, url: serverUrl } : undefined}>
      <TextField
        testID="forgot-login"
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
        testID="forgot-send"
        size="lg"
        label={t('onboarding.forgot.send')}
        loading={send.isPending}
        onPress={submit}
      />
    </AuthScaffold>
  );
}

type NewPasswordErrors = { code?: string; current?: string; password?: string; confirm?: string };

/** Validation messages per field; editing a field clears its message (as on the sign-in screen). */
function useFieldErrors() {
  const [errors, setErrors] = useState<NewPasswordErrors>({});
  const clear = (field: keyof NewPasswordErrors) =>
    setErrors((current) => (current[field] ? { ...current, [field]: undefined } : current));
  return [errors, setErrors, clear] as const;
}

/** Redeems the reset code with a new password, then returns to the password sign-in. */
export function ResetPasswordScreen() {
  const { server: serverUrl = '', login = '' } = useLocalSearchParams<Params>();
  const { t } = useTranslation();
  const router = useRouter();
  const toast = useToast();
  const info = useServerInfo(serverUrl);
  const problemText = usePasswordProblemText();
  const newRef = useRef<TextInput>(null);
  const confirmRef = useRef<TextInput>(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors, clearError] = useFieldErrors();
  const minLength = info.data?.options.passwordMinLength ?? DEFAULT_MIN_LENGTH;

  const reset = useMutation({
    mutationFn: () =>
      createAuthApi(serverUrl).resetPassword(login, code.trim().toUpperCase(), password),
    onSuccess: () => {
      toast.show({ tone: 'success', message: t('onboarding.forgot.done') });
      router.dismissTo({ pathname: '/sign-in', params: { server: serverUrl, login } });
    },
  });

  const submit = () => {
    if (reset.isPending) return;
    const problem = passwordProblem(password, confirm, {
      minLength,
      username: login.includes('@') ? undefined : login,
    });
    const next: NewPasswordErrors = {
      code: code.trim() ? undefined : t('onboarding.validation.codeRequired'),
      password: problem && problem.kind !== 'mismatch' ? problemText(problem) : undefined,
      confirm: problem?.kind === 'mismatch' ? problemText(problem) : undefined,
    };
    setErrors(next);
    if (next.code || next.password || next.confirm) return;
    reset.mutate();
  };

  return (
    <AuthScaffold
      testID="reset-password-screen"
      title={t('onboarding.forgot.resetTitle')}
      subtitle={t('onboarding.forgot.resetSubtitle', { login })}
      server={info.data ? { name: info.data.name, url: serverUrl } : undefined}>
      <TextField
        testID="reset-code"
        label={t('onboarding.forgot.code')}
        placeholder={t('onboarding.emailCode.codePlaceholder')}
        value={code}
        onChangeText={(value) => {
          setCode(value);
          clearError('code');
        }}
        error={errors.code}
        autoCapitalize="characters"
        autoCorrect={false}
        autoComplete="one-time-code"
        textContentType="oneTimeCode"
        maxLength={12}
        returnKeyType="next"
        submitBehavior="submit"
        onSubmitEditing={() => newRef.current?.focus()}
        initialFocus
      />
      <NewPasswordFields
        newRef={newRef}
        confirmRef={confirmRef}
        password={password}
        confirm={confirm}
        onPassword={(value) => {
          setPassword(value);
          clearError('password');
        }}
        onConfirm={(value) => {
          setConfirm(value);
          clearError('confirm');
        }}
        errors={errors}
        minLength={minLength}
        onSubmit={submit}
      />
      <FormError error={reset.error} />
      <Button
        testID="reset-submit"
        size="lg"
        label={t('onboarding.forgot.submit')}
        loading={reset.isPending}
        onPress={submit}
      />
    </AuthScaffold>
  );
}

/** An admin-assigned password must be replaced before the app can be used. */
export function ChangePasswordScreen() {
  const { account: accountId = '' } = useLocalSearchParams<{ account?: string }>();
  const { t } = useTranslation();
  const router = useRouter();
  const toast = useToast();
  const api = useAccountsApi();
  const { accounts } = useAccounts();
  const account = accounts.find((item) => item.id === accountId);
  const info = useServerInfo(account?.serverUrl);
  const problemText = usePasswordProblemText();
  const newRef = useRef<TextInput>(null);
  const confirmRef = useRef<TextInput>(null);
  const [known] = useState(() => signInFlow.takePassword(accountId));
  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors, clearError] = useFieldErrors();
  const minLength = info.data?.options.passwordMinLength ?? DEFAULT_MIN_LENGTH;
  const currentPassword = known ?? current;
  // After a replace (player card A07, session gate) nothing is below: Back opens the profiles, never exits.
  const lonely = !router.canGoBack();
  useMenuClaim(lonely ? 'always' : null);
  useBackHandler(() => {
    if (router.canGoBack()) return false;
    router.replace('/profiles');
    return true;
  });

  const change = useMutation({
    mutationFn: async () => {
      await unwrap(
        api.clientFor(accountId).POST('/api/v1/viewer/me/password', {
          body: { currentPassword, newPassword: password },
        })
      );
    },
    onSuccess: () => {
      api.store.update(accountId, { mustChangePassword: false });
      // Counts as picking this profile (the password change may have come straight from a cold start).
      api.activate(accountId);
      signInFlow.forgetPassword(accountId);
      toast.show({ tone: 'success', message: t('onboarding.changePassword.done') });
      enterApp(router);
    },
  });

  if (!account || !account.signedIn) return <Redirect href="/profiles" />;

  const submit = () => {
    if (change.isPending) return;
    const problem = passwordProblem(password, confirm, { minLength, username: account.username });
    const next: NewPasswordErrors = {
      current: currentPassword ? undefined : t('onboarding.validation.passwordRequired'),
      password:
        problem && problem.kind !== 'mismatch'
          ? problemText(problem)
          : password === currentPassword
            ? t('onboarding.validation.unchanged')
            : undefined,
      confirm: problem?.kind === 'mismatch' ? problemText(problem) : undefined,
    };
    setErrors(next);
    if (next.current || next.password || next.confirm) return;
    change.mutate();
  };

  return (
    <AuthScaffold
      testID="change-password-screen"
      title={t('onboarding.changePassword.title')}
      subtitle={t('onboarding.changePassword.subtitle')}
      server={{ name: account.serverName, url: account.serverUrl }}>
      {known ? null : (
        <PasswordField
          testID="change-current"
          label={t('onboarding.changePassword.current')}
          value={current}
          onChangeText={(value) => {
            setCurrent(value);
            clearError('current');
          }}
          error={errors.current}
          autoComplete="current-password"
          textContentType="password"
          returnKeyType="next"
          submitBehavior="submit"
          onSubmitEditing={() => newRef.current?.focus()}
          initialFocus
        />
      )}
      <NewPasswordFields
        newRef={newRef}
        confirmRef={confirmRef}
        password={password}
        confirm={confirm}
        onPassword={(value) => {
          setPassword(value);
          clearError('password');
        }}
        onConfirm={(value) => {
          setConfirm(value);
          clearError('confirm');
        }}
        errors={errors}
        minLength={minLength}
        onSubmit={submit}
        preferred={!!known}
      />
      <FormError error={change.error} />
      <Button
        testID="change-submit"
        size="lg"
        label={t('onboarding.changePassword.submit')}
        loading={change.isPending}
        onPress={submit}
      />
      <FormLinks>
        <Button
          testID="change-sign-out"
          variant="ghost"
          label={t('onboarding.changePassword.signOut')}
          disabled={change.isPending}
          onPress={async () => {
            await api.signOut(accountId);
            router.replace('/profiles');
          }}
        />
      </FormLinks>
    </AuthScaffold>
  );
}

function NewPasswordFields({
  newRef,
  confirmRef,
  password,
  confirm,
  onPassword,
  onConfirm,
  errors,
  minLength,
  onSubmit,
  preferred = false,
}: {
  newRef: RefObject<TextInput | null>;
  confirmRef: RefObject<TextInput | null>;
  password: string;
  confirm: string;
  onPassword: (value: string) => void;
  onConfirm: (value: string) => void;
  errors: NewPasswordErrors;
  minLength: number;
  onSubmit: () => void;
  preferred?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <>
      <PasswordField
        ref={newRef}
        testID="new-password"
        label={t('onboarding.fields.newPassword')}
        hint={t('onboarding.fields.passwordHint', { min: minLength })}
        value={password}
        onChangeText={onPassword}
        error={errors.password}
        autoComplete="new-password"
        textContentType="newPassword"
        returnKeyType="next"
        submitBehavior="submit"
        onSubmitEditing={() => confirmRef.current?.focus()}
        initialFocus={preferred}
      />
      <PasswordField
        ref={confirmRef}
        testID="confirm-password"
        label={t('onboarding.fields.confirmPassword')}
        value={confirm}
        onChangeText={onConfirm}
        error={errors.confirm}
        autoComplete="new-password"
        textContentType="newPassword"
        returnKeyType="go"
        submitBehavior="blurAndSubmit"
        onSubmitEditing={onSubmit}
      />
    </>
  );
}
