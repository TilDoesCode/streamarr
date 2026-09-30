import { useRouter } from 'expo-router';
import { Info, Play } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';

import { useMovieDetail, useSeriesDetail } from '@/browse/queries';
import { ResumeProgress, resumeSeconds, usePlay } from '@/browse/title-actions';
import { Artwork } from '@/components/media/artwork';
import { Hero, HeroTitle } from '@/components/media/hero';
import { Scrim } from '@/components/media/scrim';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ProgressBar } from '@/components/ui/progress-bar';
import { Text } from '@/components/ui/text';
import { useFormat } from '@/i18n/format';
import { titleHref } from '@/navigation/routes';
import { useDesign } from '@/theme';

import { useFeatured, type Featured, type FeaturedStore } from './featured';

/** Logo, rating, runtime and the play target of the featured title (cached detail queries). */
function useFeaturedDetail(featured: Featured | null) {
  const movie = useMovieDetail(featured?.tmdbId, featured?.kind === 'movie');
  const series = useSeriesDetail(featured?.tmdbId, featured?.kind === 'series');
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
        }
      : undefined;
  }
  const data = series.data;
  const next = data?.watch.nextEpisode;
  return data
    ? {
        logoUrl: data.logoUrl,
        backdropUrl: data.backdropUrl,
        certification: data.certification,
        runtimeMinutes: null,
        genres: data.genres,
        playWorkId: next?.workId ?? null,
        watch: next
          ? { positionTicks: next.positionTicks, durationTicks: next.durationTicks, played: false }
          : null,
        playTitle: featured.title,
      }
    : undefined;
}

function useMeta(featured: Featured, detail: ReturnType<typeof useFeaturedDetail>) {
  const format = useFormat();
  return [
    featured.year ? String(featured.year) : null,
    detail?.runtimeMinutes ? format.duration(detail.runtimeMinutes * 60) : null,
    detail?.genres?.slice(0, 2).join(', ') || null,
  ].filter((part): part is string => !!part);
}

/** Phone, tablet, web: the top pick as a full hero with Play and More info. */
export function HandheldHomeHero({ featured }: { featured: Featured }) {
  const { t } = useTranslation();
  const router = useRouter();
  const play = usePlay();
  const detail = useFeaturedDetail(featured);
  const meta = useMeta(featured, detail);
  const resume = resumeSeconds(detail?.watch);
  return (
    <Hero
      eyebrow={featured.eyebrow}
      title={featured.title}
      backdropUri={featured.backdropUrl}
      logoUri={detail?.logoUrl}
      meta={meta}
      badges={
        detail?.certification ? <Badge label={detail.certification} variant="outline" /> : undefined
      }
      overview={featured.overview ?? undefined}
      actions={
        <>
          {detail?.playWorkId ? (
            <Button
              testID="home-hero-play"
              icon={Play}
              label={t(resume ? 'common.resume' : 'common.play')}
              onPress={() =>
                detail.playWorkId &&
                play({ workId: detail.playWorkId, title: detail.playTitle, startSeconds: resume })
              }
            />
          ) : null}
          <Button
            testID="home-hero-info"
            variant="secondary"
            icon={Info}
            label={t('common.moreInfo')}
            onPress={() =>
              router.push(
                titleHref({
                  mediaType: featured.kind === 'series' ? 'tv' : 'movie',
                  tmdbId: featured.tmdbId,
                })
              )
            }
          />
        </>
      }>
      <ResumeProgress watch={detail?.watch} />
    </Hero>
  );
}

/** TV: the focused title's backdrop behind the page, fading into the canvas. */
export function TvHomeBackdrop({ store }: { store: FeaturedStore }) {
  const design = useDesign();
  const featured = useFeatured(store);
  const detail = useFeaturedDetail(featured);
  const width = design.window.width * 0.72;
  const height = width / (16 / 9);
  return (
    <View pointerEvents="none" style={{ position: 'absolute', top: 0, right: 0, width, height }}>
      {featured ? (
        <Animated.View
          key={featured.key}
          entering={FadeIn.duration(400)}
          exiting={FadeOut.duration(300)}
          style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 }}>
          <Artwork uri={featured.backdropUrl ?? detail?.backdropUrl} />
        </Animated.View>
      ) : null}
      <Scrim
        direction="right"
        style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: '60%' }}
      />
      <Scrim
        direction="up"
        style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: '55%' }}
      />
    </View>
  );
}

/** TV: title, facts and synopsis of the focused card above the rows. */
export function TvHomeInfo({ store }: { store: FeaturedStore }) {
  const design = useDesign();
  const featured = useFeatured(store);
  const detail = useFeaturedDetail(featured);
  const height = design.window.height * 0.46;
  return (
    <View
      testID="home-tv-hero"
      style={{
        height,
        justifyContent: 'flex-end',
        paddingHorizontal: design.layout.gutter,
        paddingTop: design.layout.edgeVertical,
        paddingBottom: design.space.md,
        maxWidth: design.window.width * 0.5,
        overflow: 'hidden',
        gap: design.space.sm,
      }}>
      {featured ? <TvInfoBody featured={featured} detail={detail} /> : null}
    </View>
  );
}

function TvInfoBody({
  featured,
  detail,
}: {
  featured: Featured;
  detail: ReturnType<typeof useFeaturedDetail>;
}) {
  const design = useDesign();
  const meta = useMeta(featured, detail);
  return (
    <>
      <Text testID="home-tv-hero-eyebrow" variant="overline" tone="accent" numberOfLines={1}>
        {featured.eyebrow}
      </Text>
      <View testID={`home-tv-hero-${featured.key}`} accessibilityLabel={featured.title}>
        <HeroTitle title={featured.title} logoUri={detail?.logoUrl} logoHeight={design.px(64)} />
      </View>
      {featured.detail ? (
        <Text variant="subheading" numberOfLines={1}>
          {featured.detail}
        </Text>
      ) : null}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: design.space.sm }}>
        {meta.length ? (
          <Text variant="callout" tone="muted" numberOfLines={1}>
            {meta.join(' · ')}
          </Text>
        ) : null}
        {detail?.certification ? <Badge label={detail.certification} variant="outline" /> : null}
      </View>
      {featured.progress !== undefined ? (
        <ProgressBar value={featured.progress} size="md" style={{ maxWidth: design.px(320) }} />
      ) : null}
      {featured.overview ? (
        <Text variant="body" tone="muted" numberOfLines={2}>
          {featured.overview}
        </Text>
      ) : null}
    </>
  );
}
