import { useRouter } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { END_OF_ROW, FocusGuide } from '@/components/focus';
import { Download, EyeOff, Pause, Settings } from '@/components/icons';
import { EmptyState } from '@/components/states/empty-state';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { FormMessage } from '@/components/ui/form-message';
import { Text } from '@/components/ui/text';
import {
  isActiveDownload,
  useDownloadActions,
  useDownloads,
  useDownloadsSupported,
  useDownloadStorage,
} from '@/downloads';
import { useFormat } from '@/i18n/format';
import { useScreenTitle } from '@/navigation/screen-title';
import { SHELL } from '@/shell/shell-metrics';
import { TabBarClip } from '@/shell/tab-bar-clip';
import { useShell } from '@/shell/use-shell';
import { colors, gutterPadding, useDesign, useFocusGap } from '@/theme';

import { DownloadsList } from './downloads-list';
import { StorageBar } from './storage-bar';
import { useDownloadsUi } from './use-download-ui';

/** Downloads tab / rail entry: storage, bulk actions and the profile's downloads (series → seasons → episodes, movies). */
export function DownloadsScreen() {
  const { t } = useTranslation();
  useScreenTitle(t('tabs.downloads'));
  const design = useDesign();
  const shell = useShell();
  const insets = useSafeAreaInsets();
  const ui = useDownloadsUi();
  return (
    <TabBarClip>
      <ScrollView
        testID="downloads-screen"
        style={{ flex: 1, backgroundColor: shell.large ? undefined : colors.background }}
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={!shell.large}
        contentContainerStyle={{
          paddingTop: shell.large
            ? shell.s(SHELL.page.top)
            : design.layout.edgeVertical + insets.top,
          paddingBottom: Math.max(insets.bottom, design.layout.edgeVertical) + design.space['3xl'],
          gap: design.layout.sectionGap,
        }}>
        <View style={gutterPadding(design)}>
          <Text variant="title" role="heading" numberOfLines={1} style={shell.pageTitle}>
            {t('tabs.downloads')}
          </Text>
        </View>
        {ui ? (
          <DownloadsContent />
        ) : (
          <EmptyState
            testID="downloads-unsupported"
            icon={Download}
            title={t('downloads.sheet.unsupportedTitle')}
            message={t('downloads.sheet.unsupportedMessage')}
          />
        )}
      </ScrollView>
    </TabBarClip>
  );
}

function DownloadsContent() {
  const { t } = useTranslation();
  const design = useDesign();
  const router = useRouter();
  const format = useFormat();
  const library = useDownloads();
  const storage = useDownloadStorage();
  const actions = useDownloadActions();
  const support = useDownloadsSupported();
  const gap = useFocusGap(design.space.sm);
  const [confirmWatched, setConfirmWatched] = useState(false);
  const running = library.active.filter(
    (item) => isActiveDownload(item) && item.state !== 'paused'
  );
  const finished = library.all.filter((item) => item.state === 'done').length;
  return (
    <>
      <View testID="downloads-header" style={{ ...gutterPadding(design), gap: design.space.md }}>
        <Text testID="downloads-summary" variant="callout" tone="muted">
          {t('downloads.screen.summary', {
            count: library.all.length,
            size: format.fileSize(library.bytes),
          })}
        </Text>
        <StorageBar storage={storage} />
        {support.reason === 'permission' ? (
          <FormMessage
            testID="downloads-not-allowed"
            tone="warning"
            title={t('downloads.sheet.notAllowedTitle')}
            message={t('downloads.screen.notAllowedMessage')}
          />
        ) : null}
        <FocusGuide
          remember
          trap={END_OF_ROW}
          style={{ flexDirection: 'row', flexWrap: 'wrap', gap }}>
          {running.length ? (
            <Button
              testID="downloads-pause-all"
              variant="secondary"
              size="sm"
              icon={Pause}
              label={t('downloads.screen.pauseAll')}
              onPress={() => running.forEach((item) => void actions.pause(item.id))}
            />
          ) : null}
          {finished ? (
            <Button
              testID="downloads-remove-watched"
              variant="secondary"
              size="sm"
              icon={EyeOff}
              label={t('downloads.screen.removeWatched')}
              onPress={() => setConfirmWatched(true)}
            />
          ) : null}
          <Button
            testID="downloads-manage"
            variant="ghost"
            size="sm"
            icon={Settings}
            label={t('downloads.screen.manage')}
            onPress={() => router.navigate('/settings')}
          />
        </FocusGuide>
      </View>
      {library.all.length ? (
        <DownloadsList library={library} />
      ) : (
        <EmptyState
          testID="downloads-empty"
          icon={Download}
          title={t('downloads.screen.emptyTitle')}
          message={t('downloads.screen.emptyMessage')}
        />
      )}
      <Dialog
        testID="downloads-remove-watched-dialog"
        open={confirmWatched}
        onClose={() => setConfirmWatched(false)}
        title={t('downloads.screen.removeWatchedTitle')}
        message={t('downloads.screen.removeWatchedMessage')}
        actions={[
          {
            label: t('common.cancel'),
            variant: 'secondary',
            preferred: true,
            onPress: () => setConfirmWatched(false),
          },
          {
            testID: 'downloads-remove-watched-confirm',
            label: t('downloads.screen.removeWatched'),
            variant: 'destructive',
            onPress: () => {
              setConfirmWatched(false);
              void actions.removeWatched();
            },
          },
        ]}
      />
    </>
  );
}
