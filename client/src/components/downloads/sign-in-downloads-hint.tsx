import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { useAccounts } from '@/accounts/accounts-provider';
import { serverKey } from '@/api/server-url';
import { Text } from '@/components/ui/text';
import { useOptionalDownloadsSnapshot } from '@/downloads/hooks';
import { downloadAccountKey } from '@/downloads/keys';
import { isActiveDownload } from '@/downloads/manager';

/** On the sign-in screen of a signed-out profile: how many of its downloads continue once it signs in again. */
export function SignInDownloadsHint({
  serverUrl,
  login,
}: {
  serverUrl: string;
  login: string | undefined;
}) {
  const { t } = useTranslation();
  const { accounts } = useAccounts();
  const downloads = useOptionalDownloadsSnapshot();
  const count = useMemo(() => {
    const name = login?.trim().toLowerCase();
    if (!name) return 0;
    const account = accounts.find(
      (item) =>
        serverKey(item.serverUrl) === serverKey(serverUrl) && item.username.toLowerCase() === name
    );
    if (!account) return 0;
    const owner = downloadAccountKey(account);
    return downloads.filter((item) => item.accountKey === owner && isActiveDownload(item)).length;
  }, [accounts, downloads, login, serverUrl]);
  if (!count) return null;
  return (
    <Text testID="sign-in-downloads-waiting" variant="callout" tone="muted">
      {t('downloads.account.continueAfterSignIn', { count })}
    </Text>
  );
}
