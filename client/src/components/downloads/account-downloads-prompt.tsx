import { useCallback, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import type { Account } from '@/accounts/types';
import { Dialog } from '@/components/ui/dialog';
import { downloadAccountKey } from '@/downloads/keys';
import { bytesOnDevice } from '@/downloads/library';
import { useOptionalDownloadsContext } from '@/downloads/provider';
import { useFormat } from '@/i18n/format';

type Pending = {
  account: Account;
  count: number;
  bytes: number;
  proceed: () => unknown;
};

/** Sign-out and profile removal ask whether the profile's downloads stay; other profiles' downloads are untouched. */
export function useAccountDownloadsPrompt(): {
  ask(account: Account, proceed: () => unknown): void;
  dialog: ReactNode;
} {
  const { t } = useTranslation();
  const format = useFormat();
  const downloads = useOptionalDownloadsContext();
  const [pending, setPending] = useState<Pending | null>(null);

  const ask = useCallback(
    (account: Account, proceed: () => unknown) => {
      const items = downloads?.manager.store.forAccount(downloadAccountKey(account)) ?? [];
      if (!items.length) {
        void proceed();
        return;
      }
      setPending({
        account,
        proceed,
        count: items.length,
        bytes: items.reduce((sum, item) => sum + bytesOnDevice(item), 0),
      });
    },
    [downloads]
  );

  const finish = async (remove: boolean) => {
    const current = pending;
    setPending(null);
    if (!current) return;
    // Deleted first, while the profile can still tell its server.
    if (remove && downloads)
      await downloads.manager.removeAll(downloadAccountKey(current.account)).catch(() => undefined);
    await current.proceed();
  };

  const dialog = (
    <Dialog
      testID="account-downloads-dialog"
      open={!!pending}
      stacked
      onClose={() => setPending(null)}
      title={t('downloads.account.title', { name: pending?.account.displayName ?? '' })}
      message={t('downloads.account.message', {
        name: pending?.account.displayName ?? '',
        count: pending?.count ?? 0,
        size: format.fileSize(pending?.bytes ?? 0),
      })}
      actions={[
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
      ]}
    />
  );
  return { ask, dialog };
}
