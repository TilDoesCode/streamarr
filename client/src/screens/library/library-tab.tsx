import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform } from 'react-native';

import type { LibraryKind } from '@/browse/library';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { deviceSettings } from '@/lib/storage';

import { LibraryScreen } from './library-screen';

const KIND_KEY = 'library.kind';

/** Phones (native tab bar outside Apple TV) merge Movies and Series into one Library tab. */
export function usesLibraryTab(large: boolean): boolean {
  return !large && Platform.OS !== 'web' && !(Platform.OS === 'ios' && Platform.isTV);
}

const kindOf = (value: unknown): LibraryKind | undefined =>
  value === 'series' ? 'series' : value === 'movie' ? 'movie' : undefined;

/** The segment the Library tab opens on: the last choice on this device (Movies at first). */
export function readLibraryKind(): LibraryKind {
  return kindOf(deviceSettings.getString(KIND_KEY)) ?? 'movie';
}

/** Library tab: "Library" with a Movies | Series switch; `?kind=` (deep links to /movies, /series) picks the segment. */
export function LibraryTab() {
  const { t } = useTranslation();
  const router = useRouter();
  const linked = kindOf(useLocalSearchParams<{ kind?: string }>().kind);
  const [kind, setKind] = useState<LibraryKind>(() => linked ?? readLibraryKind());
  // A new link picks its segment (state follows the param during render, not in an effect).
  const [seen, setSeen] = useState(linked);
  if (linked !== seen) {
    setSeen(linked);
    if (linked) setKind(linked);
  }
  useEffect(() => {
    if (linked) deviceSettings.set(KIND_KEY, linked);
  }, [linked]);
  const choose = (next: LibraryKind) => {
    setKind(next);
    deviceSettings.set(KIND_KEY, next);
    if (linked) router.setParams({ kind: next });
  };
  return (
    <LibraryScreen
      key={kind}
      kind={kind}
      switcher={
        <SegmentedControl
          testID="library-kind"
          label={t('tabs.library')}
          stretch
          value={kind}
          onChange={choose}
          segments={[
            { value: 'movie', label: t('tabs.movies') },
            { value: 'series', label: t('tabs.series') },
          ]}
        />
      }
    />
  );
}
