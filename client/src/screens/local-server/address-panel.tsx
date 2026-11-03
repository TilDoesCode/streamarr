import type { EmbeddedServerStatus } from '@modules/embedded-server';
import { useFocusEffect, useIsFocused } from 'expo-router';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { displayServerUrl } from '@/api/server-url';
import { Focusable, FocusLift } from '@/components/focus';
import { Eye, EyeOff } from '@/components/icons';
import { SettingsInfoRow } from '@/components/settings';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { QrCode } from '@/components/ui/qr-code';
import { SkeletonText } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { qrAddress, repeatedKinds, sortedAddresses } from '@/local-server/model';
import { useServerCredentials } from '@/local-server/use-embedded-server';
import { FormError } from '@/screens/onboarding/form-parts';
import { colors, useDesign } from '@/theme';

import { ActionRow, Card } from './card';

/** QR code of the best address for the phone, every address with its kind, and the admin sign-in. */
export function AddressPanel({
  status,
  revealPassword,
}: {
  status: EmbeddedServerStatus;
  /** Time of the last password reset: the fresh password is shown. */
  revealPassword: number;
}) {
  return (
    <>
      <QrCard status={status} />
      <CredentialsCard revealPassword={revealPassword} />
    </>
  );
}

function QrCard({ status }: { status: EmbeddedServerStatus }) {
  const { t } = useTranslation();
  const design = useDesign();
  const running = status.state === 'running';
  const best = running ? qrAddress(status.addresses) : undefined;
  // Two interfaces of one kind (eth0 + wlan0): their badges carry the interface name.
  const repeated = repeatedKinds(status.addresses);
  // A 1080p TV is read from the couch: the code is about a quarter of the screen width.
  const size = design.isTV ? design.px(208) : design.px(200);
  return (
    <Card testID="local-server-qr-card" pageTop>
      <Text variant="heading">{t('localServer.qr.title')}</Text>
      {best ? (
        <View style={{ alignItems: 'center', gap: design.space.md }}>
          <View style={{ borderRadius: design.radius.md, overflow: 'hidden' }}>
            <QrCode
              testID="local-server-qr"
              value={best.url}
              size={size}
              label={t('localServer.qr.label', { url: displayServerUrl(best.url) })}
            />
          </View>
          <Text testID="local-server-qr-url" variant="subheading" selectable>
            {displayServerUrl(best.url)}
          </Text>
          <Text variant="callout" tone="muted" style={{ textAlign: 'center' }}>
            {t('localServer.qr.hint')}
          </Text>
        </View>
      ) : (
        <View
          testID="local-server-qr-placeholder"
          style={{
            minHeight: size / 2,
            alignItems: 'center',
            justifyContent: 'center',
            padding: design.space.lg,
            borderRadius: design.radius.md,
            borderWidth: 1,
            borderStyle: 'dashed',
            borderColor: colors.border,
          }}>
          <Text variant="callout" tone="muted" style={{ textAlign: 'center' }}>
            {running ? t('localServer.qr.noNetwork') : t('localServer.qr.notRunning')}
          </Text>
        </View>
      )}
      {running && status.addresses.length ? (
        <View testID="local-server-addresses" style={{ gap: design.space.sm }}>
          {sortedAddresses(status.addresses).map((address) => {
            const kind = t(`localServer.address.${address.kind}`);
            const labelled = repeated.has(address.kind) && !!address.interfaceName;
            return (
              <View
                key={address.url}
                testID={`local-server-address-${address.kind}`}
                style={{ flexDirection: 'row', alignItems: 'center', gap: design.space.md }}>
                <View style={{ width: design.px(repeated.size ? 136 : 88) }}>
                  <Badge
                    variant={address.url === best?.url ? 'accent' : 'outline'}
                    label={
                      labelled
                        ? t('localServer.address.withInterface', {
                            kind,
                            name: address.interfaceName,
                          })
                        : kind
                    }
                  />
                </View>
                <Text variant="callout" selectable style={{ flex: 1 }} numberOfLines={1}>
                  {displayServerUrl(address.url)}
                </Text>
                {address.interfaceName && !labelled ? (
                  <Text variant="caption" tone="subtle">
                    {address.interfaceName}
                  </Text>
                ) : null}
              </View>
            );
          })}
        </View>
      ) : null}
    </Card>
  );
}

const MASK = '••••••••••';

function CredentialsCard({ revealPassword }: { revealPassword: number }) {
  const { t } = useTranslation();
  const design = useDesign();
  const focused = useIsFocused();
  const credentials = useServerCredentials(focused);
  const [toggled, setToggled] = useState(false);
  // A fresh password (reset time) stays visible until hidden or the page is left.
  const [hiddenAt, setHiddenAt] = useState(0);
  // TV: the toggle vanishes when the password was changed; if it had focus, the hint below takes it.
  const [toggleFocused, setToggleFocused] = useState(false);
  const shown = focused && (toggled || revealPassword > hiddenAt);
  const toggle = () => {
    setToggled(!shown);
    if (shown) setHiddenAt(Date.now());
  };
  // Leaving the page hides the password again.
  useFocusEffect(
    useCallback(
      () => () => {
        setToggled(false);
        setHiddenAt(Date.now());
      },
      []
    )
  );
  const data = credentials.data;
  return (
    <Card testID="local-server-credentials">
      <View style={{ gap: design.space.xxs }}>
        <Text variant="heading">{t('localServer.credentials.title')}</Text>
        <Text variant="caption" tone="muted">
          {t('localServer.credentials.hint')}
        </Text>
      </View>
      {data ? (
        <View style={{ gap: design.space.xs }}>
          <SettingsInfoRow
            valueTestID="local-server-username"
            label={t('localServer.credentials.username')}
            value={data.username}
          />
          <SettingsInfoRow
            valueTestID="local-server-password"
            label={t('localServer.credentials.password')}
            value={
              data.password === null
                ? t('localServer.credentials.changed')
                : shown
                  ? data.password
                  : MASK
            }
          />
        </View>
      ) : credentials.isPending ? (
        <View style={{ gap: design.space.sm }}>
          <SkeletonText width="50%" />
          <SkeletonText width="40%" />
        </View>
      ) : null}
      <FormError testID="local-server-credentials-error" error={credentials.error} />
      {data?.password === null ? (
        <ChangedHint takeFocus={design.isTV && toggleFocused} />
      ) : data ? (
        <ActionRow>
          <Button
            testID="local-server-password-toggle"
            variant="secondary"
            size="sm"
            icon={shown ? EyeOff : Eye}
            aria-pressed={shown}
            label={shown ? t('localServer.credentials.hide') : t('localServer.credentials.show')}
            onFocus={() => setToggleFocused(true)}
            onBlur={() => setToggleFocused(false)}
            onPress={toggle}
          />
        </ActionRow>
      ) : null}
    </Card>
  );
}

/** "Forgot the new password?" line; on TV a focus stop, so the remote never gets stranded when the toggle unmounts. */
function ChangedHint({ takeFocus }: { takeFocus: boolean }) {
  const { t } = useTranslation();
  const design = useDesign();
  const hint = (
    <Text testID="local-server-password-changed" variant="caption" tone="muted">
      {t('localServer.credentials.changedHint')}
    </Text>
  );
  if (!design.isTV) return hint;
  return (
    <Focusable
      testID="local-server-password-changed-stop"
      hasTVPreferredFocus={takeFocus}
      accessibilityLabel={t('localServer.credentials.changedHint')}>
      <FocusLift kind="none" radius={design.radius.sm}>
        <View style={{ padding: design.space.xs }}>{hint}</View>
      </FocusLift>
    </Focusable>
  );
}
