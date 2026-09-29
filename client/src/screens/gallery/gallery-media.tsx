import { Info, Layers, Play } from 'lucide-react-native';
import type { Ref } from 'react';
import { useTranslation } from 'react-i18next';
import { View, type View as ViewType } from 'react-native';

import type { FocusGuideProps } from '@/components/focus';
import { EpisodeRow } from '@/components/media/episode-row';
import { Hero } from '@/components/media/hero';
import { LandscapeCard } from '@/components/media/landscape-card';
import { PosterCard } from '@/components/media/poster-card';
import { Shelf } from '@/components/media/shelf';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/ui/icon-button';
import { currentLanguage } from '@/i18n';
import { useFormat } from '@/i18n/format';
import { MEDIA_LABELS } from '@/lib/media-labels';
import { aspect, useDesign } from '@/theme';

import { GALLERY_TITLES, type GalleryTitle } from './gallery-data';
import { GallerySection } from './gallery-section';

const MOVIES = GALLERY_TITLES.filter((title) => title.kind === 'movie');
const SERIES = GALLERY_TITLES.filter((title) => title.kind === 'series');
const SHERLOCK = SERIES.find((title) => title.key === 'sherlock')!;
const FEATURED = MOVIES.find((title) => title.key === 'sintel')!;

type ContinueItem = {
  key: string;
  title: string;
  image: string | null;
  progress: number;
  remainingSeconds: number;
  code?: { season: number; episode: number };
};
type PosterItem = {
  key: string;
  title: GalleryTitle;
  progress?: number;
  played?: boolean;
  badge?: 'uhd' | 'new';
  noArt?: boolean;
};

const CONTINUE: ContinueItem[] = Array.from({ length: 12 }, (_, index) => {
  const progress = [0.18, 0.42, 0.66, 0.85, 0.3, 0.55][index % 6]!;
  if (index % 3 === 2) {
    const episode = SHERLOCK.episodes![index % SHERLOCK.episodes!.length]!;
    return {
      key: `continue-ep-${index}`,
      title: episode.title,
      image: episode.still,
      progress,
      remainingSeconds: (episode.runtimeMinutes ?? 60) * 60 * (1 - progress),
      code: { season: episode.season, episode: episode.episode },
    };
  }
  const movie = MOVIES[index % MOVIES.length]!;
  return {
    key: `continue-${movie.key}-${index}`,
    title: movie.title,
    image: movie.backdrop,
    progress,
    remainingSeconds: (movie.runtimeMinutes ?? 10) * 60 * (1 - progress),
  };
});

const TRENDING: PosterItem[] = Array.from({ length: 14 }, (_, index) => ({
  key: `trending-${index}`,
  title: MOVIES[index % MOVIES.length]!,
  badge: index === 1 ? 'uhd' : index === 3 ? 'new' : undefined,
  progress: index === 2 ? 0.4 : undefined,
  played: index === 5,
  noArt: index === 9,
}));

const POPULAR: PosterItem[] = Array.from({ length: 12 }, (_, index) => ({
  key: `popular-${index}`,
  title: GALLERY_TITLES[(index + 7) % GALLERY_TITLES.length]!,
  badge: index === 0 ? 'new' : undefined,
}));

export function GalleryHero({
  playRef,
  onActionsFocusEnter,
  onActionsFocusLeave,
  onAction,
}: {
  playRef: Ref<ViewType>;
  onActionsFocusEnter: FocusGuideProps['onFocusEnter'];
  onActionsFocusLeave: FocusGuideProps['onFocusLeave'];
  onAction: (name: string) => void;
}) {
  const { t } = useTranslation();
  const format = useFormat();
  const lang = currentLanguage();
  return (
    <Hero
      title={FEATURED.title}
      backdropUri={FEATURED.backdropLarge}
      eyebrow={t('gallery.hero.eyebrow')}
      meta={[
        String(FEATURED.year),
        format.duration((FEATURED.runtimeMinutes ?? 0) * 60),
        FEATURED.genres[lang].join(', '),
      ]}
      badges={
        <>
          {FEATURED.rating ? <Badge label={FEATURED.rating} variant="outline" /> : null}
          <Badge label={MEDIA_LABELS.uhd} variant="neutral" />
          <Badge label={MEDIA_LABELS.hdr10} variant="neutral" />
        </>
      }
      overview={FEATURED.overview[lang]}
      onActionsFocusEnter={onActionsFocusEnter}
      onActionsFocusLeave={onActionsFocusLeave}
      actions={
        <>
          <Button
            ref={playRef}
            testID="hero-play"
            label={t('common.play')}
            icon={Play}
            hasTVPreferredFocus
            onPress={() => onAction(t('common.play'))}
          />
          <Button
            testID="hero-info"
            label={t('common.moreInfo')}
            icon={Info}
            variant="secondary"
            onPress={() => onAction(t('common.moreInfo'))}
          />
          <IconButton
            testID="hero-versions"
            icon={Layers}
            accessibilityLabel={t('common.versions')}
            onPress={() => onAction(t('common.versions'))}
          />
        </>
      }
    />
  );
}

export function GalleryShelves({ onAction }: { onAction: (name: string) => void }) {
  const { t } = useTranslation();
  const format = useFormat();
  const design = useDesign();
  const { landscapeWidth, posterWidth } = design.layout;
  const posterSubtitle = (title: GalleryTitle) =>
    title.kind === 'series' && title.seasons
      ? t('media.seasons', { count: title.seasons })
      : String(title.year);
  const posterBadge = (item: PosterItem) =>
    item.badge === 'uhd' ? MEDIA_LABELS.uhd : item.badge === 'new' ? t('media.new') : undefined;
  return (
    <View style={{ gap: design.layout.sectionGap / 2 }}>
      <Shelf
        testID="shelf-continue"
        memoryKey="gallery.continue"
        title={t('gallery.shelves.continueWatching')}
        data={CONTINUE}
        keyExtractor={(item) => item.key}
        itemWidth={landscapeWidth}
        artworkHeight={landscapeWidth / aspect.landscape}
        action={
          <Button
            label={t('common.seeAll')}
            variant="ghost"
            size="sm"
            onPress={() => onAction(t('common.seeAll'))}
          />
        }
        renderItem={({ item }) => (
          <LandscapeCard
            title={item.code ? `${t('media.episodeCode', item.code)} · ${item.title}` : item.title}
            subtitle={format.remaining(item.remainingSeconds)}
            imageUri={item.image}
            progress={item.progress}
            onPress={() => onAction(item.title)}
          />
        )}
      />
      <Shelf
        testID="shelf-trending"
        memoryKey="gallery.trending"
        title={t('gallery.shelves.trendingMovies')}
        data={TRENDING}
        keyExtractor={(item) => item.key}
        itemWidth={posterWidth}
        artworkHeight={posterWidth / aspect.poster}
        renderItem={({ item }) => (
          <PosterCard
            title={item.title.title}
            subtitle={posterSubtitle(item.title)}
            imageUri={item.noArt ? null : item.title.poster}
            progress={item.progress}
            played={item.played}
            badge={posterBadge(item)}
            onPress={() => onAction(item.title.title)}
          />
        )}
      />
      <Shelf
        testID="shelf-popular"
        memoryKey="gallery.popular"
        title={t('gallery.shelves.popularSeries')}
        data={POPULAR}
        keyExtractor={(item) => item.key}
        itemWidth={posterWidth}
        artworkHeight={posterWidth / aspect.poster}
        renderItem={({ item }) => (
          <PosterCard
            title={item.title.title}
            subtitle={posterSubtitle(item.title)}
            imageUri={item.title.poster}
            badge={posterBadge(item)}
            onPress={() => onAction(item.title.title)}
          />
        )}
      />
    </View>
  );
}

export function GalleryEpisodes({ onAction }: { onAction: (name: string) => void }) {
  const { t } = useTranslation();
  const design = useDesign();
  const episodes = SHERLOCK.episodes!.slice(0, 4);
  return (
    <GallerySection title={t('gallery.sections.episodes')} testID="section-episodes">
      <View style={{ gap: design.space.xs, maxWidth: design.layout.maxContentWidth }}>
        {episodes.map((episode, index) => (
          <EpisodeRow
            key={episode.title}
            testID={`episode-${index}`}
            episodeNumber={episode.episode}
            title={episode.title}
            overview={episode.overview ?? undefined}
            stillUri={episode.still}
            runtimeMinutes={episode.runtimeMinutes ?? undefined}
            airDate={episode.airDate ?? undefined}
            played={index === 0}
            progress={index === 1 ? 0.35 : undefined}
            unavailable={index === 3}
            onPress={() => onAction(episode.title)}
          />
        ))}
      </View>
    </GallerySection>
  );
}
