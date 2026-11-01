import { useQuery } from '@tanstack/react-query';
import * as Application from 'expo-application';
import * as Updates from 'expo-updates';
import { useState } from 'react';
import { Platform } from 'react-native';

import {
  fetchNativeRelease,
  nativeReleaseUrl,
  needsNativeUpdate,
  type InstalledApp,
  type NativeRelease,
} from './native-release';

/** Off in development builds (Metro serves the JS) and on web (the server serves the latest build). */
export const updatesEnabled = Platform.OS !== 'web' && Updates.isEnabled;

export function installedApp(): InstalledApp {
  const build = Number.parseInt(Application.nativeBuildVersion ?? '', 10);
  return {
    build: Number.isSafeInteger(build) ? build : null,
    runtimeVersion: Updates.runtimeVersion || null,
  };
}

/** Latest sideload binary for this platform; refreshed every few hours. */
export function useNativeRelease() {
  const url = nativeReleaseUrl();
  return useQuery({
    queryKey: ['app-update', 'native-release', url],
    queryFn: ({ signal }) => fetchNativeRelease(url!, Application.applicationId ?? '', signal),
    enabled: updatesEnabled && url !== null,
    staleTime: 6 * 60 * 60_000,
    retry: 1,
  });
}

/** The newer binary this install has to be replaced with, or null while OTA updates keep it current. */
export function useRequiredNativeUpdate(): NativeRelease | null {
  const { data } = useNativeRelease();
  return data && needsNativeUpdate(installedApp(), data) ? data : null;
}

export type OtaStatus =
  | { kind: 'disabled' }
  | { kind: 'idle'; checkedAt?: Date }
  | { kind: 'checking' }
  | { kind: 'downloading'; progress?: number }
  | { kind: 'ready' }
  | { kind: 'error'; message: string };

/** OTA state (expo-updates) plus a manual check that downloads a found update right away. */
export function useOtaUpdate() {
  const updates = Updates.useUpdates();
  const [error, setError] = useState<string | null>(null);
  const [checkedAt, setCheckedAt] = useState<Date | undefined>();

  const status: OtaStatus = !updatesEnabled
    ? { kind: 'disabled' }
    : updates.isUpdatePending
      ? { kind: 'ready' }
      : updates.isDownloading
        ? { kind: 'downloading', progress: updates.downloadProgress }
        : updates.isChecking
          ? { kind: 'checking' }
          : error
            ? { kind: 'error', message: error }
            : { kind: 'idle', checkedAt: checkedAt ?? updates.lastCheckForUpdateTimeSinceRestart };

  const check = async () => {
    setError(null);
    try {
      const result = await Updates.checkForUpdateAsync();
      setCheckedAt(new Date());
      if (result.isAvailable) await Updates.fetchUpdateAsync();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return {
    status,
    running: updates.currentlyRunning,
    check,
    restart: () => Updates.reloadAsync(),
  };
}
