import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import type { SeriesDetail } from '@/browse/queries';
import { seasonName } from '@/browse/season-name';
import { orderedSeasons } from '@/browse/series-selection';
import { END_OF_ROW, FocusGuide } from '@/components/focus';
import { GlassChip } from '@/components/glass';
import { Text } from '@/components/ui/text';
import { MIN_TEXT } from '@/shell/shell-metrics';
import { useShell } from '@/shell/use-shell';
import { colors, useFocusGap } from '@/theme';

/** Season chips of the series Bühne (specials last); Select/tap switches the season, focus alone never does. */
export function SeasonChips({
  seasons,
  season,
  tint,
  position,
  onSeason,
  onFocusInside,
}: {
  seasons: SeriesDetail['seasons'];
  season: number;
  tint?: string | null;
  /** "Episode 2 of 3" on the right. */
  position?: string;
  onSeason: (season: number) => void;
  /** TV: focus entered (true) or left (false) the chips. */
  onFocusInside?: (inside: boolean) => void;
}) {
  const { t } = useTranslation();
  const { s, font } = useShell();
  const gap = useFocusGap(s(16));
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: s(24) }}>
      <FocusGuide
        remember
        trap={END_OF_ROW}
        testID="series-seasons"
        onFocusEnter={() => onFocusInside?.(true)}
        onFocusLeave={() => onFocusInside?.(false)}
        style={{ flexDirection: 'row', gap, flexShrink: 1 }}>
        {orderedSeasons(seasons).map((item) => (
          <GlassChip
            key={item.seasonNumber}
            testID={`season-${item.seasonNumber}`}
            tint={tint}
            label={
              item.seasonNumber === 0
                ? item.title?.trim() || t('media.specials')
                : t('detail.seasonTag', {
                    title: seasonName(t, item.title, item.seasonNumber),
                    played: item.playedCount ?? 0,
                    total: item.episodeCount ?? 0,
                  })
            }
            selected={item.seasonNumber === season}
            onPress={() => item.seasonNumber !== season && onSeason(item.seasonNumber)}
          />
        ))}
      </FocusGuide>
      {position ? (
        <Text
          testID="series-episode-position"
          numberOfLines={1}
          style={{
            marginLeft: 'auto',
            fontSize: font(20, MIN_TEXT.caption),
            lineHeight: s(28),
            color: colors.foreground.muted,
          }}>
          {position}
        </Text>
      ) : null}
    </View>
  );
}
