import { Stack, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { ErrorState } from '@/components/states/error-state';
import { colors } from '@/theme';

export default function NotFoundScreen() {
  const { t } = useTranslation();
  const router = useRouter();
  return (
    <>
      <Stack.Screen options={{ title: t('notFound.title') }} />
      <View style={{ flex: 1, justifyContent: 'center', backgroundColor: colors.background }}>
        <ErrorState
          code="not_found"
          actions={['goHome']}
          autoFocus
          onAction={() => router.replace('/')}
        />
      </View>
    </>
  );
}
