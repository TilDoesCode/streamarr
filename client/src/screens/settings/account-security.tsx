import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { TFunction } from 'i18next';
import qrcode from 'qrcode-generator';
import { KeyRound, LogOut, Mail, MonitorSmartphone, ShieldCheck } from 'lucide-react-native';
import { useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import Svg, { Path, Rect } from 'react-native-svg';

import { useActiveAccount } from '@/accounts/accounts-provider';
import { unwrap } from '@/api/client';
import { describeError } from '@/api/error-text';
import { toAppError } from '@/api/errors';
import type { components } from '@/api/schema';
import { END_OF_ROW, FocusGuide, FocusSection } from '@/components/focus';
import { Glass } from '@/components/glass';
import { Button } from '@/components/ui/button';
import { FormMessage } from '@/components/ui/form-message';
import { SkeletonText } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { TextField } from '@/components/ui/text-field';
import { useToast } from '@/components/ui/toast';
import { accountKey, queryKeys } from '@/query/keys';
import { PasswordField } from '@/screens/onboarding/form-parts';
import { useServerInfo } from '@/screens/onboarding/use-onboarding';
import { colors, useDesign } from '@/theme';

type DeviceSession = components['schemas']['ViewerDeviceSessionResponse'];
type Profile = components['schemas']['ViewerProfileResponse'];

/** On /viewer/me a wrong current password answers invalid_credentials, which the login text would misname. */
export function accountErrorText(t: TFunction, error: unknown) {
  const appError = toAppError(error);
  if (appError.code === 'invalid_credentials')
    return {
      code: appError.code,
      title: t('settings.security.wrongPassword'),
      message: t('settings.security.wrongPasswordMessage'),
    };
  return { code: appError.code, ...describeError(t, appError) };
}

function AccountError({ error, testID }: { error: unknown; testID: string }) {
  const { t } = useTranslation();
  if (!error) return null;
  const text = accountErrorText(t, error);
  return (
    <FormMessage
      tone="danger"
      title={text.title}
      message={text.message}
      testID={`${testID}-${text.code}`}
    />
  );
}

function Panel({ children, testID }: { children: ReactNode; testID?: string }) {
  const design = useDesign();
  return (
    <Glass
      testID={testID}
      intensity="subtle"
      radius={design.radius.lg}
      style={{ gap: design.space.md, padding: design.space.lg }}>
      {children}
    </Glass>
  );
}

function Row({ children }: { children: ReactNode }) {
  const design = useDesign();
  return (
    <FocusGuide
      remember
      trap={END_OF_ROW}
      style={{ flexDirection: 'row', flexWrap: 'wrap', gap: design.space.md }}>
      {children}
    </FocusGuide>
  );
}

function useMeClient() {
  const { account, client } = useActiveAccount();
  return { account, client };
}

function formatLastSeen(iso: string | undefined, language: string) {
  if (!iso) return '';
  try {
    return new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' }).format(
      new Date(iso)
    );
  } catch {
    return new Date(iso).toLocaleString();
  }
}

/** Signed-in devices of this viewer: sign out one, or every other one. */
export function DevicesSection() {
  const { t, i18n } = useTranslation();
  const design = useDesign();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { account, client } = useMeClient();
  const key = accountKey(account.id, 'me', 'sessions');
  const sessions = useQuery({
    queryKey: key,
    queryFn: ({ signal }) => unwrap(client.GET('/api/v1/viewer/me/sessions', { signal })),
  });
  const revoke = useMutation({
    mutationFn: async (ids: string[]) => {
      for (const id of ids)
        await unwrap(
          client.DELETE('/api/v1/viewer/me/sessions/{sessionId}', {
            params: { path: { sessionId: id } },
          })
        );
      return ids.length;
    },
    onSuccess: (count) =>
      toast.show({ tone: 'success', message: t('settings.devices.signedOut', { count }) }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: key }),
  });
  const list = [...(sessions.data ?? [])].sort(
    (a, b) =>
      Number(b.current) - Number(a.current) ||
      (b.lastSeenAt ?? '').localeCompare(a.lastSeenAt ?? '')
  );
  const others = list.filter((s) => !s.current && s.id).map((s) => s.id as string);
  return (
    <FocusSection testID="settings-devices">
      <View style={{ gap: design.space.md }}>
        <Text variant="overline" tone="subtle">
          {t('settings.devices.title')}
        </Text>
        {sessions.isPending ? (
          <View testID="settings-devices-loading" style={{ gap: design.space.sm }}>
            <SkeletonText width="60%" />
            <SkeletonText width="45%" />
          </View>
        ) : sessions.error ? (
          <FormMessage
            tone="danger"
            testID="settings-devices-error"
            {...accountErrorText(t, sessions.error)}
            actions={
              <Button
                variant="secondary"
                label={t('common.retry')}
                onPress={() => void sessions.refetch()}
              />
            }
          />
        ) : (
          <>
            {list.map((session) => (
              <DeviceRow
                key={session.id}
                session={session}
                language={i18n.language}
                busy={revoke.isPending}
                onSignOut={() => session.id && revoke.mutate([session.id])}
              />
            ))}
            {others.length === 0 ? (
              <Text testID="settings-devices-empty" variant="callout" tone="muted">
                {t('settings.devices.onlyThis')}
              </Text>
            ) : (
              <Row>
                <Button
                  testID="settings-devices-sign-out-others"
                  variant="secondary"
                  icon={LogOut}
                  loading={revoke.isPending}
                  label={t('settings.devices.signOutOthers', { count: others.length })}
                  onPress={() => revoke.mutate(others)}
                />
              </Row>
            )}
            <AccountError error={revoke.error} testID="settings-devices-revoke-error" />
          </>
        )}
      </View>
    </FocusSection>
  );
}

function DeviceRow({
  session,
  language,
  busy,
  onSignOut,
}: {
  session: DeviceSession;
  language: string;
  busy: boolean;
  onSignOut: () => void;
}) {
  const { t } = useTranslation();
  const design = useDesign();
  const name = session.deviceName || t('settings.devices.unknownDevice');
  const method = t(`settings.devices.method.${session.authMethod ?? 'other'}`, {
    defaultValue: session.authMethod ?? '',
  });
  const details = [
    session.clientName,
    method,
    t('settings.devices.lastSeen', { date: formatLastSeen(session.lastSeenAt, language) }),
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <View
      testID={`settings-device-${session.id}`}
      style={{ flexDirection: 'row', alignItems: 'center', gap: design.space.md }}>
      <MonitorSmartphone size={design.px(22)} color={colors.foreground.muted} />
      <View style={{ flex: 1, gap: design.space.xxs }}>
        <Text variant="body" numberOfLines={1}>
          {name}
        </Text>
        {session.current ? (
          <Text variant="caption" tone="accent" testID="settings-device-current">
            {t('settings.devices.thisDevice')}
          </Text>
        ) : null}
        <Text variant="caption" tone="muted" numberOfLines={2}>
          {details}
        </Text>
      </View>
      {session.current ? null : (
        <Row>
          <Button
            testID={`settings-device-sign-out-${session.id}`}
            variant="ghost"
            size="sm"
            disabled={busy}
            label={t('settings.devices.signOut')}
            accessibilityLabel={t('settings.devices.signOutNamed', { name })}
            onPress={onSignOut}
          />
        </Row>
      )}
    </View>
  );
}

type Open = 'password' | 'email' | 'twoFactor' | null;

/** Password, e-mail and two-factor; TV shows a hint instead (typing secrets with a remote is no fun). */
export function SecuritySection() {
  const { t } = useTranslation();
  const design = useDesign();
  const { account, client } = useMeClient();
  const [open, setOpen] = useState<Open>(null);
  const [codesShown, setCodesShown] = useState(false);
  const me = useQuery({
    queryKey: queryKeys.me(account.id),
    queryFn: ({ signal }) => unwrap(client.GET('/api/v1/viewer/me', { signal })),
  });
  if (design.isTV)
    return (
      <FocusSection testID="settings-security">
        <View style={{ gap: design.space.md }}>
          <Text variant="overline" tone="subtle">
            {t('settings.security.title')}
          </Text>
          <Text testID="settings-security-tv-hint" variant="callout" tone="muted">
            {t('settings.security.tvHint')}
          </Text>
        </View>
      </FocusSection>
    );
  const toggle = (next: Exclude<Open, null>) => {
    setCodesShown(false);
    setOpen(open === next ? null : next);
  };
  return (
    <FocusSection testID="settings-security">
      <View style={{ gap: design.space.md }}>
        <Text variant="overline" tone="subtle">
          {t('settings.security.title')}
        </Text>
        {me.isPending ? (
          <View testID="settings-security-loading" style={{ gap: design.space.sm }}>
            <SkeletonText width="50%" />
            <SkeletonText width="40%" />
          </View>
        ) : me.error ? (
          <FormMessage
            tone="danger"
            testID="settings-security-error"
            {...accountErrorText(t, me.error)}
            actions={
              <Button
                variant="secondary"
                label={t('common.retry')}
                onPress={() => void me.refetch()}
              />
            }
          />
        ) : (
          <>
            <Item
              icon={KeyRound}
              testID="settings-password"
              label={t('settings.security.password')}
              status={t('settings.security.passwordStatus')}
              action={t('settings.security.changePassword')}
              open={open === 'password'}
              onToggle={() => toggle('password')}>
              <PasswordForm onDone={() => setOpen(null)} />
            </Item>
            <Item
              icon={Mail}
              testID="settings-email"
              label={t('settings.security.email')}
              status={emailStatus(t, me.data)}
              action={t(
                me.data.email ? 'settings.security.changeEmail' : 'settings.security.addEmail'
              )}
              open={open === 'email'}
              onToggle={() => toggle('email')}>
              <EmailForm profile={me.data} onDone={() => setOpen(null)} />
            </Item>
            <Item
              icon={ShieldCheck}
              testID="settings-two-factor"
              label={t('settings.security.twoFactor')}
              status={
                me.data.twoFactorEnabled
                  ? t('settings.security.twoFactorOn', {
                      count: me.data.recoveryCodesRemaining ?? 0,
                    })
                  : t('settings.security.twoFactorOff')
              }
              action={t(
                me.data.twoFactorEnabled ? 'settings.security.manage' : 'settings.security.setUp'
              )}
              open={open === 'twoFactor'}
              done={codesShown}
              onToggle={() => toggle('twoFactor')}>
              <TwoFactorForm enabled={!!me.data.twoFactorEnabled} onCodesShown={setCodesShown} />
            </Item>
          </>
        )}
      </View>
    </FocusSection>
  );
}

function emailStatus(t: TFunction, profile: Profile) {
  if (profile.pendingEmail) {
    const pending = t('settings.security.emailPending', { email: profile.pendingEmail });
    return profile.email ? `${profile.email} · ${pending}` : pending;
  }
  if (!profile.email) return t('settings.security.emailNone');
  return profile.emailVerified
    ? profile.email
    : t('settings.security.emailUnverified', { email: profile.email });
}

function Item({
  icon: Icon,
  label,
  status,
  action,
  open,
  done = false,
  onToggle,
  testID,
  children,
}: {
  icon: typeof KeyRound;
  label: string;
  status: string;
  action: string;
  open: boolean;
  /** The open form finished (recovery codes shown): the panel button closes it as "Done". */
  done?: boolean;
  onToggle: () => void;
  testID: string;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const design = useDesign();
  return (
    <Panel testID={testID}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: design.space.md }}>
        <Icon size={design.px(22)} color={colors.foreground.muted} />
        <View style={{ flex: 1, gap: design.space.xxs }}>
          <Text variant="body">{label}</Text>
          <Text testID={`${testID}-status`} variant="caption" tone="muted" numberOfLines={2}>
            {status}
          </Text>
        </View>
        <Row>
          <Button
            testID={`${testID}-toggle`}
            variant={open ? 'ghost' : 'secondary'}
            size="sm"
            aria-expanded={open}
            label={open ? t(done ? 'common.done' : 'common.cancel') : action}
            onPress={onToggle}
          />
        </Row>
      </View>
      {open ? children : null}
    </Panel>
  );
}

function PasswordForm({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { account, client } = useMeClient();
  const minLength = useServerInfo(account.serverUrl).data?.options.passwordMinLength ?? 8;
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [missing, setMissing] = useState(false);
  const change = useMutation({
    mutationFn: () =>
      unwrap(
        client.POST('/api/v1/viewer/me/password', {
          body: { currentPassword: current, newPassword: next },
        })
      ),
    onSuccess: () => {
      toast.show({ tone: 'success', message: t('settings.security.passwordChanged') });
      void queryClient.invalidateQueries({ queryKey: accountKey(account.id, 'me') });
      onDone();
    },
  });
  const submit = () => {
    if (change.isPending) return;
    setMissing(!current || !next);
    if (current && next) change.mutate();
  };
  return (
    <>
      <PasswordField
        testID="settings-password-current"
        label={t('settings.security.currentPassword')}
        value={current}
        onChangeText={setCurrent}
        error={missing && !current ? t('onboarding.validation.passwordRequired') : undefined}
        autoComplete="current-password"
        textContentType="password"
        initialFocus
      />
      <PasswordField
        testID="settings-password-new"
        label={t('settings.security.newPassword')}
        value={next}
        onChangeText={setNext}
        error={missing && !next ? t('onboarding.validation.passwordRequired') : undefined}
        hint={t('settings.security.newPasswordHint', { min: minLength })}
        autoComplete="new-password"
        textContentType="newPassword"
        returnKeyType="go"
        onSubmitEditing={submit}
      />
      <AccountError error={change.error} testID="settings-password-error" />
      <Row>
        <Button
          testID="settings-password-submit"
          label={t('settings.security.changePassword')}
          loading={change.isPending}
          onPress={submit}
        />
      </Row>
    </>
  );
}

function EmailForm({ profile, onDone }: { profile: Profile; onDone: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { account, client } = useMeClient();
  const [email, setEmail] = useState(profile.pendingEmail ?? '');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(profile.pendingEmail ?? null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: queryKeys.me(account.id) });
  const request = useMutation({
    mutationFn: () =>
      unwrap(
        client.POST('/api/v1/viewer/me/email', {
          body: { email: email.trim(), currentPassword: password },
        })
      ),
    onSuccess: (result) => {
      void refresh();
      setPassword('');
      setCode('');
      if (result.verificationSent) setSentTo(result.pendingEmail ?? email.trim());
      else {
        toast.show({ tone: 'success', message: t('settings.security.emailSaved') });
        onDone();
      }
    },
  });
  const verify = useMutation({
    mutationFn: () =>
      unwrap(client.POST('/api/v1/viewer/me/email/verify', { body: { code: code.trim() } })),
    onSuccess: (updated) => {
      queryClient.setQueryData(queryKeys.me(account.id), updated);
      toast.show({ tone: 'success', message: t('settings.security.emailVerified') });
      onDone();
    },
  });
  if (sentTo)
    return (
      <>
        <FormMessage
          tone="info"
          testID="settings-email-sent"
          title={t('settings.security.codeSentTitle')}
          message={t('settings.security.codeSent', { email: sentTo })}
        />
        <TextField
          testID="settings-email-code"
          label={t('settings.security.code')}
          value={code}
          onChangeText={setCode}
          autoCapitalize="characters"
          autoCorrect={false}
          autoComplete="one-time-code"
          textContentType="oneTimeCode"
          returnKeyType="go"
          onSubmitEditing={() => code.trim() && verify.mutate()}
          initialFocus
        />
        <AccountError error={verify.error} testID="settings-email-verify-error" />
        <Row>
          <Button
            testID="settings-email-verify"
            label={t('settings.security.verify')}
            disabled={!code.trim()}
            loading={verify.isPending}
            onPress={() => verify.mutate()}
          />
          <Button
            testID="settings-email-restart"
            variant="ghost"
            label={t('settings.security.otherAddress')}
            onPress={() => {
              setCode('');
              setSentTo(null);
            }}
          />
        </Row>
      </>
    );
  return (
    <>
      <TextField
        testID="settings-email-address"
        label={t('settings.security.newEmail')}
        hint={profile.email ? t('settings.security.emailRemoveHint') : undefined}
        value={email}
        onChangeText={setEmail}
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="email"
        keyboardType="email-address"
        textContentType="emailAddress"
        initialFocus
      />
      <PasswordField
        testID="settings-email-password"
        label={t('settings.security.currentPassword')}
        value={password}
        onChangeText={setPassword}
        autoComplete="current-password"
        textContentType="password"
        returnKeyType="go"
        onSubmitEditing={() => password && request.mutate()}
      />
      <AccountError error={request.error} testID="settings-email-error" />
      <Row>
        <Button
          testID="settings-email-submit"
          label={t(email.trim() ? 'settings.security.sendCode' : 'settings.security.removeEmail')}
          disabled={!password || (!email.trim() && !profile.email)}
          loading={request.isPending}
          onPress={() => request.mutate()}
        />
      </Row>
    </>
  );
}

type TwoFactorStep =
  | { kind: 'idle' }
  | { kind: 'setup'; secret: string; uri: string }
  | { kind: 'codes'; codes: string[] };

function TwoFactorForm({
  enabled,
  onCodesShown,
}: {
  enabled: boolean;
  onCodesShown: (shown: boolean) => void;
}) {
  const { t } = useTranslation();
  const design = useDesign();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { account, client } = useMeClient();
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [step, setStepState] = useState<TwoFactorStep>({ kind: 'idle' });
  const setStep = (next: TwoFactorStep) => {
    setStepState(next);
    onCodesShown(next.kind === 'codes');
  };
  const refresh = () => queryClient.invalidateQueries({ queryKey: queryKeys.me(account.id) });
  const body = { body: { currentPassword: password } };
  const setup = useMutation({
    mutationFn: () => unwrap(client.POST('/api/v1/viewer/me/two-factor/setup', body)),
    onSuccess: (result) =>
      setStep({ kind: 'setup', secret: result.secret ?? '', uri: result.otpAuthUri ?? '' }),
  });
  const enable = useMutation({
    mutationFn: () =>
      unwrap(client.POST('/api/v1/viewer/me/two-factor/enable', { body: { code: code.trim() } })),
    onSuccess: (result) => {
      void refresh();
      setStep({ kind: 'codes', codes: result.recoveryCodes ?? [] });
    },
  });
  const disable = useMutation({
    mutationFn: () => unwrap(client.POST('/api/v1/viewer/me/two-factor/disable', body)),
    onSuccess: () => {
      void refresh();
      toast.show({ tone: 'success', message: t('settings.security.twoFactorDisabled') });
    },
  });
  const regenerate = useMutation({
    mutationFn: () => unwrap(client.POST('/api/v1/viewer/me/two-factor/recovery-codes', body)),
    onSuccess: (result) => {
      void refresh();
      setStep({ kind: 'codes', codes: result.recoveryCodes ?? [] });
    },
  });

  if (step.kind === 'codes')
    return (
      <View testID="settings-recovery-codes" style={{ gap: design.space.md }}>
        <FormMessage
          tone="warning"
          title={t('settings.security.recoveryTitle')}
          message={t('settings.security.recoveryMessage')}
        />
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: design.space.sm }}>
          {step.codes.map((value) => (
            <Text
              key={value}
              variant="body"
              selectable
              style={{ fontFamily: 'monospace', minWidth: design.px(140) }}>
              {value}
            </Text>
          ))}
        </View>
        <Row>
          <Button
            testID="settings-recovery-done"
            label={t('settings.security.recoverySaved')}
            onPress={() => {
              setStep({ kind: 'idle' });
              setPassword('');
              setCode('');
            }}
          />
        </Row>
      </View>
    );

  if (step.kind === 'setup')
    return (
      <View testID="settings-two-factor-setup" style={{ gap: design.space.md }}>
        <Text variant="callout" tone="muted">
          {t('settings.security.scan')}
        </Text>
        <View
          style={{
            flexDirection: 'row',
            flexWrap: 'wrap',
            gap: design.space.lg,
            alignItems: 'center',
          }}>
          <QrCode value={step.uri} size={design.px(184)} label={t('settings.security.qrLabel')} />
          <View style={{ flex: 1, minWidth: design.px(200), gap: design.space.xs }}>
            <Text variant="caption" tone="muted">
              {t('settings.security.secret')}
            </Text>
            <Text
              testID="settings-two-factor-secret"
              variant="body"
              selectable
              style={{ fontFamily: 'monospace' }}>
              {groupSecret(step.secret)}
            </Text>
          </View>
        </View>
        <TextField
          testID="settings-two-factor-code"
          label={t('settings.security.authCode')}
          value={code}
          onChangeText={setCode}
          keyboardType="number-pad"
          autoComplete="one-time-code"
          textContentType="oneTimeCode"
          maxLength={6}
          returnKeyType="go"
          onSubmitEditing={() => code.trim() && enable.mutate()}
        />
        <AccountError error={enable.error} testID="settings-two-factor-enable-error" />
        <Row>
          <Button
            testID="settings-two-factor-enable"
            label={t('settings.security.enable')}
            disabled={code.trim().length < 6}
            loading={enable.isPending}
            onPress={() => enable.mutate()}
          />
        </Row>
      </View>
    );

  const pending = setup.isPending || disable.isPending || regenerate.isPending;
  return (
    <>
      <PasswordField
        testID="settings-two-factor-password"
        label={t('settings.security.currentPassword')}
        value={password}
        onChangeText={setPassword}
        autoComplete="current-password"
        textContentType="password"
        initialFocus
      />
      <AccountError
        error={setup.error ?? disable.error ?? regenerate.error}
        testID="settings-two-factor-error"
      />
      <Row>
        {enabled ? (
          <>
            <Button
              testID="settings-two-factor-regenerate"
              variant="secondary"
              label={t('settings.security.newRecoveryCodes')}
              disabled={!password || pending}
              loading={regenerate.isPending}
              onPress={() => regenerate.mutate()}
            />
            <Button
              testID="settings-two-factor-disable"
              variant="destructive"
              label={t('settings.security.disable')}
              disabled={!password || pending}
              loading={disable.isPending}
              onPress={() => disable.mutate()}
            />
          </>
        ) : (
          <Button
            testID="settings-two-factor-start"
            label={t('settings.security.continue')}
            disabled={!password || pending}
            loading={setup.isPending}
            onPress={() => setup.mutate()}
          />
        )}
      </Row>
    </>
  );
}

function groupSecret(secret: string) {
  return secret.replace(/(.{4})/g, '$1 ').trim();
}

/** otpauth:// URI as a QR code, drawn black on a white quiet zone so every scanner reads it. */
export function QrCode({ value, size, label }: { value: string; size: number; label: string }) {
  const { path, count } = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(value);
    qr.make();
    const modules = qr.getModuleCount();
    let d = '';
    for (let row = 0; row < modules; row++)
      for (let col = 0; col < modules; col++)
        if (qr.isDark(row, col)) d += `M${col + 4} ${row + 4}h1v1h-1z`;
    return { path: d, count: modules + 8 };
  }, [value]);
  return (
    <View testID="settings-two-factor-qr" role="img" aria-label={label}>
      <Svg width={size} height={size} viewBox={`0 0 ${count} ${count}`}>
        <Rect x={0} y={0} width={count} height={count} fill={colors.qr.light} />
        <Path d={path} fill={colors.qr.dark} />
      </Svg>
    </View>
  );
}
