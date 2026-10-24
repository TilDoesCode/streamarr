import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';

import {
  BookmarkCheck,
  BookmarkPlus,
  ListChecks,
  ListPlus,
  type LucideIcon,
} from '@/components/icons';
import { GlassButton } from '@/components/glass';

import { useListToggle } from './queries';

type ListLabels = { icon: LucideIcon; label: string };

/** Icon and accessible name of the toggle: add while off the list, remove once on it. */
export function listLabels(onList: boolean, t: TFunction, season?: number): ListLabels {
  if (season !== undefined)
    return {
      icon: onList ? ListChecks : ListPlus,
      label: t(onList ? 'mylist.removeSeason' : 'mylist.addSeason', { season }),
    };
  return {
    icon: onList ? BookmarkCheck : BookmarkPlus,
    label: t(onList ? 'mylist.remove' : 'mylist.add'),
  };
}

/** The phone detail's action row item (like Watched): "My List", highlighted once on it. */
export function listAction(onList: boolean, t: TFunction) {
  return {
    icon: onList ? BookmarkCheck : BookmarkPlus,
    label: t(onList ? 'mylist.onListShort' : 'mylist.addShort'),
    accessibilityLabel: t(onList ? 'mylist.remove' : 'mylist.add'),
    selected: onList,
  };
}

/**
 * Adds a movie, series or season to My List (round glass button of the large detail; a labelled pill with `labelled`).
 * Disabled until the server said whether it is on the list.
 */
export function ListToggleButton({
  workId,
  title,
  season,
  tint,
  labelled = false,
  testID,
}: {
  workId: string | null | undefined;
  /** Name in the toast. */
  title: string;
  /** Season entries: the season number (labels and icon). */
  season?: number;
  tint?: string | null;
  labelled?: boolean;
  testID: string;
}) {
  const { t } = useTranslation();
  const list = useListToggle({ workId, title });
  if (!workId) return null;
  const { icon, label } = listLabels(list.onList, t, season);
  return (
    <GlassButton
      testID={testID}
      iconOnly={!labelled}
      icon={icon}
      label={
        labelled && list.onList && season !== undefined
          ? t('mylist.seasonShort', { season })
          : label
      }
      accessibilityLabel={label}
      aria-selected={list.onList}
      tint={tint}
      disabled={!list.ready || list.pending}
      onPress={list.toggle}
    />
  );
}
