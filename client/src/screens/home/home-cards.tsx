import { useRouter, type Href } from 'expo-router';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import {
  useMovieDetail,
  useSeasonDetail,
  type CatalogItem,
  type NextUpItem,
  type WatchState,
} from '@/browse/queries';
import { usePlayPending, usePlayWork, watchProgress } from '@/browse/title-actions';
import { LandscapeCard } from '@/components/media/landscape-card';
import { PosterCard } from '@/components/media/poster-card';
import { useFormat } from '@/i18n/format';
import { parseWorkId } from '@/lib/work-id';
import { titleHref, workHref } from '@/navigation/routes';
import { TICKS_PER_SECOND } from '@/player/playback-api';

import type { Featured } from './featured';

type CardProps = {
  width: number;
  testID: string;
  eyebrow: string;
  onFeature?: (featured: Featured) => void;
  hasTVPreferredFocus?: boolean;
  /** The first card: features its title before anything is focused or hovered (and while it stays featured). */
  onLead?: (featured: Featured) => void;
};

/** A started movie or episode: resumes on press, opens the title on long press. */
export function ContinueCard({ state, ...props }: CardProps & { state: WatchState }) {
  const { t } = useTranslation();
  const format = useFormat();
  const router = useRouter();
  const playWork = usePlayWork();
  const pending = usePlayPending(state.workId);
  const unavailable = state.available === false;
  const ref = parseWorkId(state.workId);
  const movie = useMovieDetail(ref?.tmdbId, ref?.kind === 'movie');
  const season = useSeasonDetail(
    ref?.kind === 'episode' ? ref.tmdbId : undefined,
    ref?.kind === 'episode' ? ref.season : undefined
  );
  const episode =
    ref?.kind === 'episode'
      ? season.data?.episodes?.find((item) => item.episodeNumber === ref.episode)
      : undefined;
  const code =
    ref?.kind === 'episode'
      ? t('media.episodeCode', { season: ref.season, episode: ref.episode })
      : undefined;
  const title =
    (ref?.kind === 'episode' ? season.data?.seriesTitle : movie.data?.title) ?? state.title ?? '';
  const left =
    state.durationTicks && state.positionTicks
      ? (state.durationTicks - state.positionTicks) / TICKS_PER_SECOND
      : undefined;
  const remaining = left ? t('media.remaining', { time: format.duration(left) }) : undefined;
  const subtitle = [code, remaining].filter(Boolean).join(' · ');
  const image = episode?.stillUrl ?? movie.data?.backdropUrl;
  const progress = watchProgress(state);
  const playTitle = code
    ? t('detail.episodeTitle', { series: title, code, title: episode?.title ?? '' })
    : title;
  const featured: Featured | undefined = ref
    ? {
        key: featuredKey.continue(state.workId),
        kind: ref.kind === 'movie' ? 'movie' : 'series',
        tmdbId: ref.tmdbId,
        title,
        eyebrow: props.eyebrow,
        backdropUrl: movie.data?.backdropUrl ?? episode?.stillUrl,
        year: movie.data?.year,
        overview: episode?.overview ?? movie.data?.overview,
        detail: code ? [code, episode?.title].filter(Boolean).join(' · ') : undefined,
        episode:
          ref.kind === 'episode' && state.workId
            ? {
                workId: state.workId,
                season: ref.season,
                episode: ref.episode,
                playTitle,
                positionTicks: state.positionTicks,
                durationTicks: state.durationTicks,
                lastReleaseId: state.lastReleaseId,
                available: state.available !== false,
              }
            : undefined,
        progress,
        tint: state.tint,
        tint2: state.tint2,
        highlight: state.highlight,
        spec: state.spec,
      }
    : undefined;
  // Details that load while the card is focused (season, movie) update the hero too.
  const focused = useRef(false);
  const { onFeature } = props;
  const signature = featured ? JSON.stringify(featured) : '';
  const leads = !!props.onLead;
  // Also when this card becomes the first one (the card before it left the row, Q1-40 phone).
  useEffect(() => {
    if (focused.current && featured) onFeature?.(featured);
    if (featured) props.onLead?.(featured);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, leads]);

  return (
    <LandscapeCard
      testID={props.testID}
      title={title}
      subtitle={subtitle || undefined}
      imageUri={image}
      progress={progress}
      width={props.width}
      spec={state.spec}
      tint={state.tint}
      hasTVPreferredFocus={props.hasTVPreferredFocus}
      onHoverIn={() => featured && props.onFeature?.(featured)}
      onFocus={() => {
        focused.current = true;
        if (featured) props.onFeature?.(featured);
      }}
      onBlur={() => {
        focused.current = false;
      }}
      badge={unavailable ? t('media.notAvailableYet') : undefined}
      aria-busy={pending}
      onPress={() => {
        if (!state.workId) return;
        // No version (B9 `available: false`): the series or movie explains it instead of a failing player.
        if (unavailable && ref)
          return router.push(
            ref.kind === 'episode'
              ? episodeHref(ref.tmdbId, ref.season, ref.episode)
              : workHref(state.workId)!
          );
        playWork({ workId: state.workId, title: playTitle, watch: state });
      }}
      onLongPress={() => {
        const href = workHref(state.workId);
        if (href) router.push(href);
      }}
    />
  );
}

/** The next episode of a series in progress: plays on press, opens the series on long press. */
export function NextUpCard({ item, ...props }: CardProps & { item: NextUpItem }) {
  const { t } = useTranslation();
  const router = useRouter();
  const playWork = usePlayWork();
  const pending = usePlayPending(item.workId);
  const ref = parseWorkId(item.workId);
  const code = t('media.episodeCode', { season: item.seasonNumber, episode: item.episodeNumber });
  const title = item.seriesTitle ?? '';
  const watch = {
    positionTicks: item.positionTicks,
    durationTicks: item.durationTicks,
    played: false,
  };
  const progress = watchProgress(watch);
  const playTitle = t('detail.episodeTitle', {
    series: title,
    code,
    title: item.episodeTitle ?? '',
  });
  const featured: Featured | undefined = ref && {
    key: featuredKey.next(item.workId),
    kind: 'series',
    tmdbId: ref.tmdbId,
    title,
    eyebrow: props.eyebrow,
    backdropUrl: item.stillUrl,
    detail: [code, item.episodeTitle].filter(Boolean).join(' · '),
    episode: item.workId
      ? {
          workId: item.workId,
          season: item.seasonNumber,
          episode: item.episodeNumber,
          playTitle,
          positionTicks: item.positionTicks,
          durationTicks: item.durationTicks,
          available: item.available,
        }
      : undefined,
    progress,
    tint: item.tint,
    tint2: item.tint2,
    highlight: item.highlight,
    spec: item.spec,
  };
  const feature = () => featured && props.onFeature?.(featured);
  const { onLead } = props;
  const signature = featured ? JSON.stringify(featured) : '';
  const leads = !!onLead;
  useEffect(() => {
    if (featured) onLead?.(featured);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, leads]);
  return (
    <LandscapeCard
      testID={props.testID}
      title={title}
      subtitle={[code, item.episodeTitle].filter(Boolean).join(' · ')}
      imageUri={item.stillUrl ?? item.seriesPosterUrl}
      progress={progress}
      width={props.width}
      spec={item.spec}
      tint={item.tint}
      hasTVPreferredFocus={props.hasTVPreferredFocus}
      onHoverIn={feature}
      onFocus={feature}
      badge={item.available === false ? t('media.notAvailableYet') : undefined}
      aria-busy={pending}
      onPress={() => {
        if (!item.workId || !ref) return;
        // No version (B9 `available: false`): the series explains it on that episode instead of a failing player.
        if (item.available === false)
          return router.push(episodeHref(ref.tmdbId, item.seasonNumber, item.episodeNumber));
        playWork({ workId: item.workId, title: playTitle, watch });
      }}
      onLongPress={() => {
        const href = workHref(item.workId);
        if (href) router.push(href);
      }}
    />
  );
}

/** The series detail opened on one episode. */
export function episodeHref(tmdbId: number, season: number, episode: number): Href {
  return {
    pathname: '/series/[id]',
    params: { id: String(tmdbId), season: String(season), episode: String(episode) },
  };
}

/** Hero keys of the Home cards (continue, next up, discover). */
export const featuredKey = {
  continue: (workId: string | null) => `continue-${workId}`,
  next: (workId: string | null) => `next-${workId}`,
  item: (mediaType: string | null, tmdbId: number) => `item-${mediaType}-${tmdbId}`,
};

/** Discover item as featured content. */
export function featuredFromItem(item: CatalogItem, eyebrow: string): Featured {
  return {
    key: featuredKey.item(item.mediaType, item.tmdbId),
    kind: item.mediaType === 'tv' || item.mediaType === 'series' ? 'series' : 'movie',
    tmdbId: item.tmdbId,
    title: item.title ?? '',
    eyebrow,
    backdropUrl: item.backdropUrl ?? item.posterUrl,
    year: item.year,
    overview: item.overview,
    tint: item.tint,
    tint2: item.tint2,
    highlight: item.highlight,
    spec: item.spec,
  };
}

/** Discover poster: opens the title. */
export function DiscoverCard({ item, ...props }: CardProps & { item: CatalogItem }) {
  const router = useRouter();
  return (
    <PosterCard
      testID={props.testID}
      title={item.title ?? ''}
      subtitle={item.year ? String(item.year) : undefined}
      imageUri={item.posterUrl}
      width={props.width}
      spec={item.spec}
      tint={item.tint}
      hasTVPreferredFocus={props.hasTVPreferredFocus}
      onHoverIn={() => props.onFeature?.(featuredFromItem(item, props.eyebrow))}
      onFocus={() => props.onFeature?.(featuredFromItem(item, props.eyebrow))}
      onPress={() => router.push(titleHref(item))}
    />
  );
}
