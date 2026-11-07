import { useCallback, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import type { Account } from '@/accounts/types';
import { Dialog } from '@/components/ui/dialog';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import { downloadAccountKey } from '@/downloads/keys';
import { bytesOnDevice } from '@/downloads/library';
import { isRemovingDownload } from '@/downloads/manager';
import { useOptionalDownloadsContext } from '@/downloads/provider';
import { useFormat } from '@/i18n/format';
import { useDesign } from '@/theme';

type Pending = {
  account: Account;
  count: number;
  bytes: number;
  proceed: () => unknown;
  /** The profile is removed from this device (not just signed out). */
  removal: boolean;
};

/** Sign-out and profile removal ask whether the profile's downloads stay; other profiles' downloads are untouched. */
export function useAccountDownloadsPrompt(): {
  ask(account: Account, proceed: () => unknown, options?: { removal?: boolean }): void;
  dialog: ReactNode;
} {
  const { t } = useTranslation();
  const format = useFormat();
  const design = useDesign();
  const downloads = useOptionalDownloadsContext();
  const [pending, setPending] = useState<Pending | null>(null);
  const [telling, setTelling] = useState(false);

  const ask = useCallback(
    (account: Account, proceed: () => unknown, { removal = false } = {}) => {
      const items = (downloads?.manager.store.forAccount(downloadAccountKey(account)) ?? []).filter(
        (item) => !isRemovingDownload(item)
      );
      if (!items.length) {
        void proceed();
        return;
      }
      setPending({
        account,
        proceed,
        removal,
        count: items.length,
        bytes: items.reduce((sum, item) => sum + bytesOnDevice(item), 0),
      });
    },
    [downloads]
  );

  const finish = async (remove: boolean) => {
    const current = pending;
    if (!current || telling) return;
    // The server hears of them while the session still works (at most a few seconds); the files go in the background.
    if (remove && downloads) {
      setTelling(true);
      await downloads.manager
        .removeForSignOut(downloadAccountKey(current.account), { forget: current.removal })
        .catch(() => undefined);
      setTelling(false);
    }
    setPending(null);
    await current.proceed();
  };

  const dialog = (
    <Dialog
      testID="account-downloads-dialog"
      open={!!pending}
      stacked
      onClose={() => (telling ? undefined : setPending(null))}
      title={t('downloads.account.title', { name: pending?.account.displayName ?? '' })}
      message={
        telling
          ? undefined
          : t('downloads.account.message', {
              name: pending?.account.displayName ?? '',
              count: pending?.count ?? 0,
              size: format.fileSize(pending?.bytes ?? 0),
            })
      }
      actions={
        telling
          ? []
          : [
              {
                label: t('downloads.account.keep'),
                variant: 'secondary',
                preferred: true,
                testID: 'account-downloads-keep',
                onPress: () => void finish(false),
              },
              {
                label: t('downloads.account.delete'),
                variant: 'destructive',
                testID: 'account-downloads-delete',
                onPress: () => void finish(true),
              },
              {
                label: t('common.cancel'),
                variant: 'ghost',
                testID: 'account-downloads-cancel',
                onPress: () => setPending(null),
              },
            ]
      }>
      {telling ? (
        <View
          testID="account-downloads-removing"
          style={{ flexDirection: 'row', alignItems: 'center', gap: design.space.md }}>
          <Spinner size="sm" />
          <Text variant="body" tone="muted">
            {t('downloads.account.removing')}
          </Text>
        </View>
      ) : null}
    </Dialog>
  );
  return { ask, dialog };
}
