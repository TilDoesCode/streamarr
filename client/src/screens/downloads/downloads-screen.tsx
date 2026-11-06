import { useRouter } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { DownloadsLibrary } from '@/components/downloads';
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
} from '@/downloads';
import { useFormat } from '@/i18n/format';
import { useScreenTitle } from '@/navigation/screen-title';
import { SHELL } from '@/shell/shell-metrics';
import { TabBarClip } from '@/shell/tab-bar-clip';
import { useShell } from '@/shell/use-shell';
import { colors, gutterPadding, useDesign, useFocusGap } from '@/theme';

import { useDownloadsUi } from './use-download-ui';

/** Downloads tab / rail entry: the core's library (storage, running, series, movies) under bulk actions. */
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
        {ui ? null : (
          <View style={gutterPadding(design)}>
            <PageTitle />
          </View>
        )}
        {ui ? (
          <View style={gutterPadding(design)}>
            <DownloadsLibrary header={<DownloadsHeader />} />
          </View>
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

function PageTitle() {
  const { t } = useTranslation();
  const shell = useShell();
  return (
    <Text variant="title" role="heading" numberOfLines={1} style={shell.pageTitle}>
      {t('tabs.downloads')}
    </Text>
  );
}

/** Title, count and size, the permission note and the bulk actions above the library. */
function DownloadsHeader() {
  const { t } = useTranslation();
  const design = useDesign();
  const router = useRouter();
  const format = useFormat();
  const library = useDownloads();
  const actions = useDownloadActions();
  const support = useDownloadsSupported();
  const gap = useFocusGap(design.space.sm);
  const [confirmWatched, setConfirmWatched] = useState(false);
  const running = library.active.filter(
    (item) => isActiveDownload(item) && item.state !== 'paused'
  );
  const finished = library.all.filter((item) => item.state === 'done').length;
  return (
    <View testID="downloads-header" style={{ gap: design.space.md }}>
      <View style={{ gap: design.space.xs }}>
        <PageTitle />
        <Text testID="downloads-summary" variant="callout" tone="muted">
          {t('downloads.screen.summary', {
            count: library.all.length,
            size: format.fileSize(library.bytes),
          })}
        </Text>
      </View>
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
    </View>
  );
}
