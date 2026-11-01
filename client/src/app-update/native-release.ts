import { Linking, Platform } from 'react-native';

const RELEASE_BASE = 'https://raw.githubusercontent.com/TilDoesCode/streamarr/altstore';
/** AltStore/SideStore source with the unsigned iOS builds (written by client/scripts/release-ios.mjs). */
export const IOS_SOURCE_URL = `${RELEASE_BASE}/source.json`;
/** Latest signed Android TV APK (written by client/scripts/release-android-manifest.mjs). */
export const ANDROID_RELEASE_URL = `${RELEASE_BASE}/android.json`;

export type NativeRelease = {
  version: string;
  build: number;
  /** Native runtime of the binary; only installs on the same runtime receive its OTA updates. */
  runtimeVersion: string | null;
  downloadURL: string;
  date: string | null;
  notes: string | null;
};

export type InstalledApp = { build: number | null; runtimeVersion: string | null };

type SourceVersion = {
  version?: string;
  buildVersion?: string;
  runtimeVersion?: string;
  downloadURL?: string;
  date?: string;
  localizedDescription?: string;
};

function toBuild(value: unknown): number | null {
  const build = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  return Number.isSafeInteger(build) && build > 0 ? build : null;
}

function release(entry: SourceVersion | undefined): NativeRelease | null {
  const build = toBuild(entry?.buildVersion);
  if (!entry?.version || !entry.downloadURL || build === null) return null;
  return {
    version: entry.version,
    build,
    runtimeVersion: entry.runtimeVersion ?? null,
    downloadURL: entry.downloadURL,
    date: entry.date ?? null,
    notes: entry.localizedDescription ?? null,
  };
}

/** Newest build of `bundleId` in an AltStore source. */
export function parseIosSource(json: unknown, bundleId: string): NativeRelease | null {
  const apps = (json as { apps?: { bundleIdentifier?: string; versions?: SourceVersion[] }[] })
    ?.apps;
  const versions = apps?.find((app) => app.bundleIdentifier === bundleId)?.versions ?? [];
  return versions
    .map(release)
    .filter((entry): entry is NativeRelease => entry !== null)
    .reduce<NativeRelease | null>(
      (best, entry) => (best && best.build >= entry.build ? best : entry),
      null
    );
}

export function parseAndroidRelease(json: unknown): NativeRelease | null {
  const data = json as { versionCode?: number } & SourceVersion;
  return release({ ...data, buildVersion: String(data?.versionCode ?? '') });
}

/**
 * A newer binary is required when this install can no longer follow along with OTA updates: the latest build is
 * newer and ships a different native runtime. A newer build on the same runtime arrives as an OTA update.
 */
export function needsNativeUpdate(installed: InstalledApp, latest: NativeRelease | null): boolean {
  if (!latest || installed.build === null || latest.build <= installed.build) return false;
  return !latest.runtimeVersion || latest.runtimeVersion !== installed.runtimeVersion;
}

/** Sideloaded binaries: iPhone/iPad via AltStore/SideStore, Android TV via the APK. Apple TV and web have none. */
export function nativeReleaseUrl(): string | null {
  if (Platform.OS === 'ios' && !Platform.isTV) return IOS_SOURCE_URL;
  if (Platform.OS === 'android') return ANDROID_RELEASE_URL;
  return null;
}

export async function fetchNativeRelease(
  url: string,
  bundleId: string,
  signal?: AbortSignal
): Promise<NativeRelease | null> {
  const response = await fetch(url, { signal, headers: { 'Cache-Control': 'no-cache' } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const json: unknown = await response.json();
  return url === IOS_SOURCE_URL ? parseIosSource(json, bundleId) : parseAndroidRelease(json);
}

/** iOS: the source in AltStore, else SideStore, else the IPA download; Android: the APK download. */
export async function openNativeUpdate(latest: NativeRelease): Promise<void> {
  if (Platform.OS === 'ios') {
    const source = encodeURIComponent(IOS_SOURCE_URL);
    for (const url of [`altstore://source?url=${source}`, `sidestore://source?url=${source}`]) {
      try {
        await Linking.openURL(url);
        return;
      } catch {
        // Store not installed: try the next one.
      }
    }
  }
  await Linking.openURL(latest.downloadURL);
}
