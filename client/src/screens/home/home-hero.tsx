import type { Href } from 'expo-router';
import { Info, Play } from '@/components/icons';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { playTarget } from '@/browse/play-target';
import {
  useCachedVersions,
  useMovieDetail,
  useSeriesDetail,
  useSeriesFocus,
} from '@/browse/queries';
import { ResumeProgress, resumeSeconds, usePlayWork } from '@/browse/title-actions';
import {
  titleTargetHref,
  useOpenTitle,
  type TitlePreview,
  type TitleTarget,
} from '@/browse/title-open';
import { versionSpec } from '@/browse/version-format';
import { GlassButton } from '@/components/glass';
import { Artwork } from '@/components/media/artwork';
import { HeroTitle } from '@/components/media/hero';
import { SpecLabels } from '@/components/spec';
import { Badge } from '@/components/ui/badge';
import { Text } from '@/components/ui/text';
import { useFormat } from '@/i18n/format';
import { HeroFade } from '@/shell/hero-fade';
import { useDesign } from '@/theme';

import type { Featured } from './featured';

/** Logo, rating, runtime and the play target of the featured title (cached detail queries). */
export function useFeaturedDetail(featured: Featured | null) {
  const movie = useMovieDetail(featured?.tmdbId, featured?.kind === 'movie');
  const series = useSeriesDetail(featured?.tmdbId, featured?.kind === 'series');
  const focus = useSeriesFocus(featured?.kind === 'series' ? series.data : undefined);
  if (!featured) return undefined;
  if (featured.kind === 'movie') {
    const data = movie.data;
    return data
      ? {
          logoUrl: data.logoUrl,
          certification: data.certification,
          runtimeMinutes: data.runtimeMinutes,
          genres: data.genres,
          playWorkId: data.workId,
          watch: data.watch,
          playTitle: data.title ?? featured.title,
          season: undefined,
          episode: undefined,
          unavailable: false,
        }
      : undefined;
  }
  const data = series.data;
  // A continue / next-up card plays its own episode; a discover title the series focus.
  const card = featured.episode;
  const next = card
    ? {
        workId: card.workId,
        seasonNumber: card.season,
        episodeNumber: card.episode,
        positionTicks: card.positionTicks,
        durationTicks: card.durationTicks,
        lastReleaseId: card.lastReleaseId,
        available: card.available,
      }
    : focus;
  // B9: no version yet, so no Play into a failing player; "More info" stays and explains it.
  const unavailable = next?.available === false;
  return data
    ? {
        logoUrl: data.logoUrl,
        backdropUrl: data.backdropUrl,
        backdropSizes: data.backdropSizes,
        certification: data.certification,
        runtimeMinutes: null,
        genres: data.genres,
        playWorkId: unavailable ? null : (next?.workId ?? null),
        unavailable,
        watch: next
          ? {
              positionTicks: next.positionTicks,
              durationTicks: next.durationTicks,
              played: false,
              lastReleaseId: next.lastReleaseId,
            }
          : null,
        playTitle: card?.playTitle ?? featured.title,
        season: next?.seasonNumber,
        episode: next?.episodeNumber,
      }
    : undefined;
}

/** "More info": a series opens on the episode the hero shows (its play target), a movie on its detail. */
export function featuredInfoTarget(
  featured: Featured,
  detail: ReturnType<typeof useFeaturedDetail>
): TitleTarget {
  if (featured.kind === 'movie') return { kind: 'movie', tmdbId: featured.tmdbId };
  const season = featured.episode?.season ?? detail?.season;
  const episode = featured.episode?.episode ?? detail?.episode;
  return {
    kind: 'series',
    tmdbId: featured.tmdbId,
    ...(season !== undefined ? { season } : null),
    ...(season !== undefined && episode !== undefined ? { episode } : null),
  };
}

export function featuredInfoHref(
  featured: Featured,
  detail: ReturnType<typeof useFeaturedDetail>
): Href {
  return titleTargetHref(featuredInfoTarget(featured, detail));
}

/** What the hero already shows, for the detail's first frame (a series card's still is no series backdrop). */
export function featuredPreview(
  featured: Featured,
  detail: ReturnType<typeof useFeaturedDetail>
): TitlePreview {
  const movie = featured.kind === 'movie';
  return {
    title: featured.title,
    backdropUrl: detail?.backdropUrl ?? (movie || !featured.episode ? featured.backdropUrl : null),
    logoUrl: detail?.logoUrl,
    tint: featured.tint,
    tint2: featured.tint2,
    highlight: featured.highlight,
    year: featured.year,
    overview: movie ? featured.overview : undefined,
  };
}

/** The hero's Play / Resume: the same version the detail would start. */
export function usePlayFeatured(detail: ReturnType<typeof useFeaturedDetail>) {
  const playWork = usePlayWork();
  return () =>
    detail?.playWorkId &&
    playWork({ workId: detail.playWorkId, title: detail.playTitle, watch: detail.watch });
}

/** Spec chips of the version the hero's Play would start (server cache, no search); the card's summary until known. */
export function useFeaturedSpec(featured: Featured, detail: ReturnType<typeof useFeaturedDetail>) {
  const versions = useCachedVersions(detail?.playWorkId);
  const watch = detail?.watch;
  const target = playTarget(versions, watch, resumeSeconds(watch) ? 'resume' : 'play');
  if (target.state === 'ready') return versionSpec(target.version);
  return target.state === 'none' ? null : featured.spec;
}

export function useMeta(featured: Featured, detail: ReturnType<typeof useFeaturedDetail>) {
  const { t } = useTranslation();
  const format = useFormat();
  return [
    detail?.unavailable ? t('media.notAvailableYet') : null,
    featured.year ? String(featured.year) : null,
    detail?.runtimeMinutes ? format.duration(detail.runtimeMinutes * 60) : null,
    detail?.genres?.slice(0, 2).join(', ') || null,
  ].filter((part): part is string => !!part);
}

/** Phone compact hero: artwork on top fading into the page, the copy stacked below it. */
export function HandheldHomeHero({ featured }: { featured: Featured }) {
  const { t } = useTranslation();
  const openTitle = useOpenTitle();
  const design = useDesign();
  const detail = useFeaturedDetail(featured);
  const playFeatured = usePlayFeatured(detail);
  const meta = useMeta(featured, detail);
  const spec = useFeaturedSpec(featured, detail);
  const resume = resumeSeconds(detail?.watch);
  const { gutter } = design.layout;
  const image = featured.backdropUrl ?? detail?.backdropUrl;
  const imageSizes = featured.backdropUrl ? featured.backdropSizes : detail?.backdropSizes;
  return (
    <View testID="home-hero" collapsable={false}>
      <View style={{ width: '100%', aspectRatio: 4 / 3.4 }}>
        <HeroFade left={false}>
          <Artwork
            uri={image}
            sizes={imageSizes}
            // Phones: the full-width hero needs w780, not the w1280 of TV and desktop.
            request={{ kind: 'backdrop', size: 'medium' }}
            title={featured.title}
          />
        </HeroFade>
      </View>
      <View style={{ marginTop: -design.px(96), paddingHorizontal: gutter, gap: design.space.md }}>
        <Text variant="overline" tone="muted" numberOfLines={1}>
          {featured.eyebrow}
        </Text>
        <View accessibilityLabel={featured.title} style={{ minHeight: design.px(64) }}>
          <HeroTitle
            title={featured.title}
            logoUri={detail?.logoUrl}
            logoHeight={design.px(72)}
            logoWidth={design.px(240)}
          />
        </View>
        {featured.detail ? (
          <Text testID="home-hero-episode" variant="callout" numberOfLines={1}>
            {featured.detail}
          </Text>
        ) : null}
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: design.space.sm,
            flexWrap: 'wrap',
          }}>
          {meta.length ? (
            <Text variant="caption" tone="muted" numberOfLines={1}>
              {meta.join(' · ')}
            </Text>
          ) : null}
          {detail?.certification ? <Badge label={detail.certification} variant="outline" /> : null}
          <SpecLabels spec={spec} max={3} />
        </View>
        <ResumeProgress watch={detail?.watch} />
        {featured.overview ? (
          <Text variant="callout" tone="muted" numberOfLines={3}>
            {featured.overview}
          </Text>
        ) : null}
        <View style={{ flexDirection: 'row', gap: design.space.md, marginTop: design.space.xs }}>
          {detail?.playWorkId ? (
            <GlassButton
              testID="home-hero-play"
              tone="solid"
              icon={Play}
              label={t(resume ? 'common.resume' : 'common.play')}
              onPress={playFeatured}
            />
          ) : null}
          <GlassButton
            testID="home-hero-info"
            icon={Info}
            tint={featured.tint}
            label={t('common.moreInfo')}
            onPress={() =>
              openTitle(featuredInfoTarget(featured, detail), featuredPreview(featured, detail))
            }
          />
        </View>
      </View>
    </View>
  );
}
