import type { EmbeddedServerStatus } from '@modules/embedded-server';
import { useFocusEffect, useIsFocused } from 'expo-router';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { displayServerUrl } from '@/api/server-url';
import { Eye, EyeOff } from '@/components/icons';
import { SettingsButtonRow, SettingsInfoRow } from '@/components/settings';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { QrCode } from '@/components/ui/qr-code';
import { SkeletonText } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { qrAddress, sortedAddresses } from '@/local-server/model';
import { useServerCredentials } from '@/local-server/use-embedded-server';
import { FormError } from '@/screens/onboarding/form-parts';
import { colors, useDesign } from '@/theme';

import { Card } from './card';

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
  // A 1080p TV is read from the couch: the code is about a quarter of the screen width.
  const size = design.isTV ? design.px(208) : design.px(200);
  return (
    <Card testID="local-server-qr-card">
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
          {sortedAddresses(status.addresses).map((address) => (
            <View
              key={address.url}
              testID={`local-server-address-${address.kind}`}
              style={{ flexDirection: 'row', alignItems: 'center', gap: design.space.md }}>
              <View style={{ width: design.px(88) }}>
                <Badge
                  variant={address.url === best?.url ? 'accent' : 'outline'}
                  label={t(`localServer.address.${address.kind}`)}
                />
              </View>
              <Text variant="callout" selectable style={{ flex: 1 }} numberOfLines={1}>
                {displayServerUrl(address.url)}
              </Text>
              {address.interfaceName ? (
                <Text variant="caption" tone="subtle">
                  {address.interfaceName}
                </Text>
              ) : null}
            </View>
          ))}
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
        <Text testID="local-server-password-changed" variant="caption" tone="muted">
          {t('localServer.credentials.changedHint')}
        </Text>
      ) : data ? (
        <SettingsButtonRow>
          <Button
            testID="local-server-password-toggle"
            variant="secondary"
            size="sm"
            icon={shown ? EyeOff : Eye}
            aria-pressed={shown}
            label={shown ? t('localServer.credentials.hide') : t('localServer.credentials.show')}
            onPress={toggle}
          />
        </SettingsButtonRow>
      ) : null}
    </Card>
  );
}
