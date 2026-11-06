import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { FocusSection } from '@/components/focus';
import { Glass } from '@/components/glass';
import { Text } from '@/components/ui/text';
import {
  downloadTitle,
  useDownloadActions,
  type OfflineDownload,
  type OfflineLibrary,
} from '@/downloads';
import { useFormat } from '@/i18n/format';
import { META_SEPARATOR } from '@/lib/media-labels';
import { seasonName } from '@/browse/season-name';
import { gutterPadding, useDesign } from '@/theme';

import { DownloadControls, DownloadProgressLine } from './download-item';

/** The profile's downloads: series (seasons, episodes), then movies; each with its state and controls. */
export function DownloadsList({ library }: { library: OfflineLibrary }) {
  const { t } = useTranslation();
  const design = useDesign();
  const format = useFormat();
  return (
    <View testID="downloads-list" style={{ ...gutterPadding(design), gap: design.space.lg }}>
      {library.series.map((series) => (
        <FocusSection key={series.seriesId} testID={`downloads-series-${series.seriesId}`}>
          <View style={{ gap: design.space.sm }}>
            <Text variant="subheading" numberOfLines={1}>
              {series.title}
            </Text>
            <Text variant="caption" tone="muted">
              {t('downloads.screen.seriesLine', {
                count: series.episodeCount,
                size: format.fileSize(series.bytes),
              })}
            </Text>
            {series.seasons.map((season) => (
              <View key={season.seasonId} style={{ gap: design.space.xs }}>
                <Text variant="overline" tone="muted">
                  {seasonName(t, null, season.seasonNumber)}
                </Text>
                {season.episodes.map((episode) => (
                  <DownloadRow
                    key={episode.id}
                    download={episode}
                    playTitle={`${series.title}${META_SEPARATOR}${downloadTitle(t, episode)}`}
                  />
                ))}
              </View>
            ))}
          </View>
        </FocusSection>
      ))}
      {library.movies.length ? (
        <FocusSection testID="downloads-movies">
          <View style={{ gap: design.space.sm }}>
            <Text variant="subheading">{t('tabs.movies')}</Text>
            {library.movies.map((movie) => (
              <DownloadRow key={movie.id} download={movie} playTitle={movie.meta.title} />
            ))}
          </View>
        </FocusSection>
      ) : null}
    </View>
  );
}

function DownloadRow({ download, playTitle }: { download: OfflineDownload; playTitle: string }) {
  const { t } = useTranslation();
  const design = useDesign();
  const actions = useDownloadActions();
  const testID = `downloads-item-${download.workId}`;
  return (
    <Glass radius={design.radius.lg} intensity="subtle">
      <View
        testID={testID}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: design.space.md,
          paddingVertical: design.space.sm,
          paddingHorizontal: design.space.md,
        }}>
        <View style={{ flex: 1, gap: design.space.xxs }}>
          <Text variant="callout" numberOfLines={1}>
            {downloadTitle(t, download)}
          </Text>
          <DownloadProgressLine download={download} testID={testID} />
        </View>
        <DownloadControls
          download={download}
          actions={actions}
          playTitle={playTitle}
          testID={testID}
        />
      </View>
    </Glass>
  );
}
