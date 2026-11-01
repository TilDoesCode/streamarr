import Constants from 'expo-constants';
import { useTranslation } from 'react-i18next';
import { Platform, View, type ViewStyle } from 'react-native';

import {
  ChevronRight,
  CircleCheck,
  Download,
  RefreshCw,
  TriangleAlert,
  type LucideIcon,
} from '@/components/icons';
import { Focusable, FocusLift } from '@/components/focus';
import {
  SettingsBlock,
  SettingsInfoRow,
  SettingsRow,
  SettingsSection,
} from '@/components/settings';
import { Button } from '@/components/ui/button';
import { FormMessage } from '@/components/ui/form-message';
import { Text } from '@/components/ui/text';
import { useToast } from '@/components/ui/toast';
import { formatClock } from '@/diagnostics/service-status';
import { colors, useDesign } from '@/theme';

import { openNativeUpdate, type NativeRelease } from './native-release';
import {
  installedApp,
  useOtaUpdate,
  useRequiredNativeUpdate,
  type OtaStatus,
} from './use-app-update';

function useOpenNativeUpdate() {
  const { t } = useTranslation();
  const toast = useToast();
  return (release: NativeRelease) =>
    openNativeUpdate(release).catch(() =>
      toast.show({
        tone: 'error',
        message: t('appUpdate.native.openFailed', { url: release.downloadURL }),
      })
    );
}

function useNativeText(release: NativeRelease) {
  const { t } = useTranslation();
  const ios = Platform.OS === 'ios';
  return {
    title: t('appUpdate.native.title', { version: release.version, build: release.build }),
    message: t(ios ? 'appUpdate.native.messageIos' : 'appUpdate.native.messageAndroid'),
    action: t(ios ? 'appUpdate.native.openIos' : 'appUpdate.native.openAndroid'),
  };
}

function useStatusText(status: OtaStatus): string {
  const { t, i18n } = useTranslation();
  switch (status.kind) {
    case 'disabled':
      return t('appUpdate.status.disabled');
    case 'checking':
      return t('appUpdate.status.checking');
    case 'downloading':
      return status.progress
        ? t('appUpdate.status.downloadingProgress', { percent: Math.round(status.progress * 100) })
        : t('appUpdate.status.downloading');
    case 'ready':
      return t('appUpdate.status.ready');
    case 'error':
      return t('appUpdate.status.error', { message: status.message });
    case 'idle':
      return status.checkedAt
        ? t('appUpdate.status.upToDate', {
            time: formatClock(status.checkedAt.toISOString(), i18n.language),
          })
        : t('appUpdate.status.idle');
  }
}

/** Settings: OTA status with a manual check, a required reinstall, and what is installed. Hidden on web. */
export function AppUpdateSection() {
  const { t, i18n } = useTranslation();
  const ota = useOtaUpdate();
  const native = useRequiredNativeUpdate();
  const statusText = useStatusText(ota.status);
  if (Platform.OS === 'web') return null;
  const { build, runtimeVersion } = installedApp();
  const running = ota.running;
  const createdAt =
    running.createdAt && !Number.isNaN(running.createdAt.getTime()) ? running.createdAt : null;
  const busy = ota.status.kind === 'checking' || ota.status.kind === 'downloading';
  return (
    <SettingsSection title={t('appUpdate.sectionTitle')} testID="settings-app-update">
      {native ? <NativeUpdateMessage release={native} /> : null}
      <SettingsRow
        testID="settings-app-update-status"
        icon={RefreshCw}
        label={t('appUpdate.label')}
        description={statusText}
        descriptionTestID="settings-app-update-status-text"
        trailing={
          ota.status.kind === 'disabled' ? null : ota.status.kind === 'ready' ? (
            <Button
              testID="settings-app-update-restart"
              size="sm"
              label={t('appUpdate.restart')}
              onPress={() => void ota.restart()}
            />
          ) : (
            <Button
              testID="settings-app-update-check"
              size="sm"
              variant="secondary"
              label={t('appUpdate.check')}
              loading={busy}
              onPress={busy ? undefined : () => void ota.check()}
            />
          )
        }
      />
      <SettingsBlock>
        <SettingsInfoRow
          valueTestID="settings-app-update-version"
          label={t('appUpdate.version')}
          value={t('appUpdate.versionValue', {
            version: Constants.expoConfig?.version ?? '–',
            build: build ?? '–',
          })}
        />
        <SettingsInfoRow
          valueTestID="settings-app-update-installed"
          label={t('appUpdate.installedUpdate')}
          value={
            running.isEmbeddedLaunch || !createdAt
              ? t('appUpdate.embedded')
              : t('appUpdate.updateValue', {
                  date: formatClock(createdAt.toISOString(), i18n.language),
                  id: running.updateId?.slice(0, 8) ?? '–',
                })
          }
        />
        <SettingsInfoRow
          valueTestID="settings-app-update-runtime"
          label={t('appUpdate.runtime')}
          value={runtimeVersion ? runtimeVersion.slice(0, 8) : '–'}
        />
      </SettingsBlock>
    </SettingsSection>
  );
}

function NativeUpdateMessage({ release }: { release: NativeRelease }) {
  const open = useOpenNativeUpdate();
  const text = useNativeText(release);
  return (
    <FormMessage
      testID="settings-native-update"
      tone="warning"
      title={text.title}
      message={text.message}
      actions={
        <Button
          testID="settings-native-update-open"
          size="sm"
          icon={Download}
          label={text.action}
          onPress={() => void open(release)}
        />
      }
    />
  );
}

type Banner = { kind: 'native'; release: NativeRelease } | { kind: 'ready' };

function useBanner(): Banner | null {
  const native = useRequiredNativeUpdate();
  const ota = useOtaUpdate();
  if (native) return { kind: 'native', release: native };
  return ota.status.kind === 'ready' ? { kind: 'ready' } : null;
}

/** Whether Home shows the update strip: screens skip its wrapper otherwise. */
export function useAppUpdateBannerShown(): boolean {
  return useBanner() !== null;
}

/** Home strip: a required reinstall (opens AltStore / the APK) or a downloaded OTA update (restarts the app). */
export function AppUpdateBanner({ style }: { style?: ViewStyle }) {
  const banner = useBanner();
  if (!banner) return null;
  return banner.kind === 'native' ? (
    <NativeBanner release={banner.release} style={style} />
  ) : (
    <ReadyBanner style={style} />
  );
}

function NativeBanner({ release, style }: { release: NativeRelease; style?: ViewStyle }) {
  const open = useOpenNativeUpdate();
  const text = useNativeText(release);
  return (
    <BannerStrip
      testID="app-update-banner-native"
      icon={TriangleAlert}
      color={colors.warning.DEFAULT}
      background={colors.warning.muted}
      title={text.title}
      message={text.message}
      action={text.action}
      onPress={() => void open(release)}
      style={style}
    />
  );
}

function ReadyBanner({ style }: { style?: ViewStyle }) {
  const { t } = useTranslation();
  const ota = useOtaUpdate();
  return (
    <BannerStrip
      testID="app-update-banner-ready"
      icon={CircleCheck}
      color={colors.success.DEFAULT}
      background={colors.success.muted}
      title={t('appUpdate.banner.readyTitle')}
      message={t('appUpdate.banner.readyMessage')}
      action={t('appUpdate.restart')}
      onPress={() => void ota.restart()}
      style={style}
    />
  );
}

function BannerStrip({
  testID,
  icon: Icon,
  color,
  background,
  title,
  message,
  action,
  onPress,
  style,
}: {
  testID: string;
  icon: LucideIcon;
  color: string;
  background: string;
  title: string;
  message: string;
  action: string;
  onPress: () => void;
  style?: ViewStyle;
}) {
  const { t } = useTranslation();
  const design = useDesign();
  return (
    <View style={style}>
      <Focusable
        testID={testID}
        role="button"
        accessibilityLabel={t('appUpdate.banner.label', { title, message, action })}
        onPress={onPress}>
        <FocusLift kind="none" radius={design.radius.md}>
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: design.space.md,
              paddingVertical: design.space.md,
              paddingHorizontal: design.space.lg,
              borderRadius: design.radius.md,
              borderCurve: 'continuous',
              borderWidth: 1,
              borderColor: color,
              backgroundColor: background,
            }}>
            <Icon size={design.layout.iconSize.md} color={color} strokeWidth={2} />
            <View style={{ flex: 1, gap: design.space.xxs }}>
              <Text testID={`${testID}-title`} variant="callout">
                {title}
              </Text>
              <Text variant="caption" tone="muted">
                {message}
              </Text>
            </View>
            {design.formFactor === 'phone' ? null : (
              <Text variant="label" tone="muted">
                {action}
              </Text>
            )}
            <ChevronRight size={design.layout.iconSize.sm} color={colors.foreground.muted} />
          </View>
        </FocusLift>
      </Focusable>
    </View>
  );
}
