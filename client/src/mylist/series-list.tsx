import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { SeriesDetail } from '@/browse/queries';
import { seasonName } from '@/browse/season-name';
import { orderedSeasons } from '@/browse/series-selection';
import { GlassButton } from '@/components/glass';
import { BookmarkCheck, BookmarkPlus, Check, Plus } from '@/components/icons';
import { Dialog } from '@/components/ui/dialog';

import { listLabels } from './list-toggle';
import { useListToggle } from './queries';

type SeasonEntry = NonNullable<SeriesDetail['seasons']>[number];

/** The season My List offers beside the series: the one on screen, on a series with several regular seasons. */
export function listSeason(
  seasons: readonly SeasonEntry[] | null | undefined,
  selected: number | undefined
): (SeasonEntry & { workId: string }) | undefined {
  const regular = orderedSeasons(seasons).filter((item) => item.seasonNumber > 0);
  const found =
    regular.length > 1 ? regular.find((item) => item.seasonNumber === selected) : undefined;
  return found?.workId ? { ...found, workId: found.workId } : undefined;
}

/**
 * The series page's one My List control. Without a season context it toggles the series; with one it opens a
 * chooser (whole series / the season on screen) and its state is "on the list" when either is.
 */
export function useSeriesList({
  workId,
  title,
  season,
}: {
  workId: string | null | undefined;
  title: string;
  season?: { workId: string; number: number; title?: string | null };
}) {
  const { t } = useTranslation();
  const series = useListToggle({ workId, title });
  const seasonLabel = season ? seasonName(t, season.title, season.number) : '';
  const seasonList = useListToggle({
    workId: season?.workId,
    title: `${title} · ${seasonLabel}`,
  });
  const [open, setOpen] = useState(false);
  const choose = !!season;
  const onList = series.onList || (choose && seasonList.onList);
  const pick = (toggle: () => void) => () => {
    setOpen(false);
    toggle();
  };
  const dialog = season ? (
    <Dialog
      testID="series-list-choice"
      stacked
      open={open}
      onClose={() => setOpen(false)}
      title={t('mylist.choice.title')}
      message={t('mylist.choice.message')}
      actions={[
        {
          testID: 'series-list-choice-series',
          label: t('mylist.choice.series'),
          icon: series.onList ? Check : Plus,
          selected: series.onList,
          variant: series.onList ? 'primary' : 'secondary',
          preferred: true,
          onPress: pick(series.toggle),
        },
        {
          testID: 'series-list-choice-season',
          label: seasonLabel,
          icon: seasonList.onList ? Check : Plus,
          selected: seasonList.onList,
          variant: seasonList.onList ? 'primary' : 'secondary',
          onPress: pick(seasonList.toggle),
        },
        { label: t('common.cancel'), variant: 'ghost', onPress: () => setOpen(false) },
      ]}
    />
  ) : null;
  return {
    onList,
    label: choose ? t('mylist.choice.title') : listLabels(onList, t).label,
    disabled:
      !series.ready || series.pending || (choose && (!seasonList.ready || seasonList.pending)),
    press: choose ? () => setOpen(true) : series.toggle,
    dialog,
  };
}

/** Round glass button of the large detail's action row; `list` comes from useSeriesList. */
export function SeriesListButton({
  list,
  tint,
  testID,
}: {
  list: Pick<ReturnType<typeof useSeriesList>, 'onList' | 'label' | 'disabled' | 'press'>;
  tint?: string | null;
  testID: string;
}) {
  return (
    <GlassButton
      testID={testID}
      iconOnly
      icon={list.onList ? BookmarkCheck : BookmarkPlus}
      label={list.label}
      aria-selected={list.onList}
      tint={tint}
      disabled={list.disabled}
      onPress={list.press}
    />
  );
}
