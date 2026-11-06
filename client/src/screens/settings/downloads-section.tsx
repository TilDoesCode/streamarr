import { useRouter } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { END_OF_ROW, FocusGuide } from '@/components/focus';
import { Download, EyeOff, Layers, Trash2, WifiOff, type LucideIcon } from '@/components/icons';
import { GlassChip } from '@/components/glass';
import {
  SettingsBlock,
  SettingsButtonRow,
  SettingsRow,
  SettingsSection,
} from '@/components/settings';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Text } from '@/components/ui/text';
import { useToast } from '@/components/ui/toast';
import { useDownloadActions, useDownloads, useDownloadSettings } from '@/downloads';
import { useFormat } from '@/i18n/format';
import { StorageSummary } from '@/components/downloads';
import { useDownloadsUi } from '@/screens/downloads/use-download-ui';
import { useDesign, useFocusGap } from '@/theme';

/** Concurrent downloads the settings offer (the engine allows up to six). */
export const CONCURRENT_CHOICES = [1, 2, 3] as const;

/** Settings → Downloads: only where downloads exist (not on the web or Apple TV). */
export function DownloadsSettingsSection() {
  return useDownloadsUi() ? <DownloadsSettings /> : null;
}

function DownloadsSettings() {
  const { t } = useTranslation();
  const router = useRouter();
  const toast = useToast();
  const format = useFormat();
  const settings = useDownloadSettings();
  const library = useDownloads();
  const actions = useDownloadActions();
  const [confirm, setConfirm] = useState(false);
  const count = library.all.length;
  const size = format.fileSize(library.bytes);
  return (
    <SettingsSection
      title={t('downloads.settings.title')}
      testID="settings-downloads"
      footer={
        <Dialog
          testID="settings-downloads-remove-all-dialog"
          open={confirm}
          onClose={() => setConfirm(false)}
          title={t('downloads.settings.removeAllTitle')}
          message={t('downloads.settings.removeAllMessage', { count, size })}
          actions={[
            {
              label: t('common.cancel'),
              variant: 'secondary',
              preferred: true,
              onPress: () => setConfirm(false),
            },
            {
              testID: 'settings-downloads-remove-all-confirm',
              label: t('downloads.settings.removeAllConfirm'),
              variant: 'destructive',
              onPress: () => {
                setConfirm(false);
                void actions
                  .removeAll()
                  .then(() =>
                    toast.show({ message: t('downloads.settings.removedAll'), tone: 'success' })
                  );
              },
            },
          ]}
        />
      }>
      <SettingsRow
        testID="settings-downloads-open"
        icon={Download}
        label={t('downloads.settings.open')}
        description={t('downloads.settings.openHint', { count, size })}
        onPress={() => router.navigate('/downloads')}
      />
      <ToggleRow
        testID="settings-downloads-wifi"
        icon={WifiOff}
        label={t('downloads.settings.wifiOnly')}
        description={t('downloads.settings.wifiOnlyHint')}
        value={settings.wifiOnly}
        onChange={(value) => void settings.setWifiOnly(value)}
      />
      <ChoiceRow
        testID="settings-downloads-concurrent"
        icon={Layers}
        label={t('downloads.settings.concurrent')}
        description={t('downloads.settings.concurrentHint')}
        value={settings.maxConcurrent}
        options={CONCURRENT_CHOICES}
        labelOf={String}
        onChange={(value) => void settings.setMaxConcurrent(value)}
      />
      <ToggleRow
        testID="settings-downloads-delete-watched"
        icon={EyeOff}
        label={t('downloads.settings.deleteWatched')}
        description={t('downloads.settings.deleteWatchedHint')}
        value={settings.deleteWatched}
        onChange={(value) => settings.setDeleteWatched(value)}
      />
      <SettingsBlock testID="settings-downloads-storage">
        <Text variant="body">{t('downloads.settings.storage')}</Text>
        <StorageSummary testID="settings-downloads-storage-bar" />
        {count ? (
          <SettingsButtonRow>
            <Button
              testID="settings-downloads-remove-all"
              variant="destructive"
              icon={Trash2}
              label={t('downloads.settings.removeAll')}
              onPress={() => setConfirm(true)}
            />
          </SettingsButtonRow>
        ) : null}
      </SettingsBlock>
    </SettingsSection>
  );
}

function ToggleRow({
  testID,
  icon,
  label,
  description,
  value,
  onChange,
}: {
  testID: string;
  icon: LucideIcon;
  label: string;
  description: string;
  value: boolean;
  onChange: (value: boolean) => void;
}) {
  const { t } = useTranslation();
  return (
    <ChoiceRow
      testID={testID}
      icon={icon}
      label={label}
      description={description}
      value={value ? 'on' : 'off'}
      options={['on', 'off'] as const}
      labelOf={(option) => t(`downloads.settings.${option}`)}
      onChange={(option) => onChange(option === 'on')}
    />
  );
}

function ChoiceRow<T extends string | number>({
  testID,
  icon,
  label,
  description,
  value,
  options,
  labelOf,
  onChange,
}: {
  testID: string;
  icon: LucideIcon;
  label: string;
  description: string;
  value: T;
  options: readonly T[];
  labelOf: (option: T) => string;
  onChange: (option: T) => void;
}) {
  const design = useDesign();
  const chipGap = useFocusGap(design.space.sm);
  return (
    <SettingsRow testID={testID} icon={icon} label={label} description={description}>
      <FocusGuide
        remember
        trap={END_OF_ROW}
        testID={`${testID}-chips`}
        style={{ flexDirection: 'row', flexWrap: 'wrap', gap: chipGap }}>
        {options.map((option) => (
          <GlassChip
            key={String(option)}
            testID={`${testID}-${option}`}
            role="radio"
            aria-checked={value === option}
            label={labelOf(option)}
            selected={value === option}
            onPress={() => value !== option && onChange(option)}
          />
        ))}
      </FocusGuide>
    </SettingsRow>
  );
}
