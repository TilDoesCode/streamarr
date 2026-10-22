import type { ErrorBoundaryProps } from 'expo-router';
import { useRouter } from 'expo-router';
import { useEffect } from 'react';
import { View } from 'react-native';

import { useBackHandler } from '@/components/focus';
import { ErrorState, type ErrorAction } from '@/components/states/error-state';
import { colors } from '@/theme';

import { leavePlayer } from './player-tv-back';

/** The player route's own boundary: a render error in the player is its card, not the app-wide error screen. */
export function PlayerErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  const router = useRouter();
  useEffect(() => {
    if (__DEV__) console.warn('[player] render error', error);
  }, [error]);
  const back = () => leavePlayer(router);
  useBackHandler(() => {
    back();
    return true;
  });
  const onAction = (action: ErrorAction) => (action === 'retry' ? void retry() : back());
  return (
    <View
      testID="player-error-boundary"
      style={{ flex: 1, justifyContent: 'center', backgroundColor: colors.video }}>
      <ErrorState
        code="player_internal_error"
        actions={['retry', 'back']}
        onAction={onAction}
        autoFocus
      />
    </View>
  );
}
