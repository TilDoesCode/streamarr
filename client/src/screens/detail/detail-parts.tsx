import { useRouter } from 'expo-router';
import type { ReactNode } from 'react';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { toAppError } from '@/api/errors';
import { ErrorState } from '@/components/states/error-state';
import { colors, useDesign } from '@/theme';

/** A positive TMDB id / season number from a route param, else undefined. */
export function routeNumber(value: string | string[] | undefined): number | undefined {
  const number = Number(Array.isArray(value) ? value[0] : value);
  return Number.isInteger(number) && number >= 0 ? number : undefined;
}

/** Scrolling page of a title screen (TV: item snapping like the other pages). */
export function DetailScroll({ children, testID }: { children: ReactNode; testID?: string }) {
  const design = useDesign();
  const insets = useSafeAreaInsets();
  return (
    <ScrollView
      testID={testID}
      style={{ flex: 1, backgroundColor: colors.background }}
      contentContainerStyle={{
        paddingBottom: Math.max(insets.bottom, design.layout.edgeVertical) + design.space['3xl'],
        gap: design.layout.sectionGap,
      }}
      snapToAlignment={design.isTV ? 'item' : undefined}
      snapToItemPadding={design.isTV ? design.layout.edgeVertical : undefined}>
      {children}
    </ScrollView>
  );
}

/** Full-screen error of a title screen: retry (transient failures), or go back. */
export function DetailError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const router = useRouter();
  const appError = error ? toAppError(error) : undefined;
  return (
    <View style={{ flex: 1, justifyContent: 'center', backgroundColor: colors.background }}>
      <ErrorState
        testID="detail-error"
        code={appError?.code ?? 'not_found'}
        params={appError?.params}
        actions={appError?.isTransient ? ['retry', 'back'] : ['back']}
        autoFocus
        onAction={(action) => {
          if (action === 'retry') onRetry();
          else if (router.canGoBack()) router.back();
          else router.replace('/');
        }}
      />
    </View>
  );
}
