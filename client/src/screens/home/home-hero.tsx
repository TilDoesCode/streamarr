import { useRouter } from 'expo-router';
import { Info, Play } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { useMovieDetail, useSeriesDetail } from '@/browse/queries';
import { ResumeProgress, resumeSeconds, usePlay } from '@/browse/title-actions';
import { GlassButton } from '@/components/glass';
import { Artwork } from '@/components/media/artwork';
import { HeroTitle } from '@/components/media/hero';
import { SpecLabels } from '@/components/spec';
import { Badge } from '@/components/ui/badge';
import { Text } from '@/components/ui/text';
import { useFormat } from '@/i18n/format';
import { titleHref } from '@/navigation/routes';
import { HeroFade } from '@/shell/hero-fade';
import { useDesign } from '@/theme';

import type { Featured } from './featured';

/** Logo, rating, runtime and the play target of the featured title (cached detail queries). */
export function useFeaturedDetail(featured: Featured | null) {
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

export function useMeta(featured: Featured, detail: ReturnType<typeof useFeaturedDetail>) {
  const format = useFormat();
  return [
    featured.year ? String(featured.year) : null,
    detail?.runtimeMinutes ? format.duration(detail.runtimeMinutes * 60) : null,
    detail?.genres?.slice(0, 2).join(', ') || null,
  ].filter((part): part is string => !!part);
}

/** Phone compact hero: artwork on top fading into the page, the copy stacked below it. */
export function HandheldHomeHero({ featured }: { featured: Featured }) {
  const { t } = useTranslation();
  const router = useRouter();
  const play = usePlay();
  const design = useDesign();
  const detail = useFeaturedDetail(featured);
  const meta = useMeta(featured, detail);
  const resume = resumeSeconds(detail?.watch);
  const { gutter } = design.layout;
  const image = featured.backdropUrl ?? detail?.backdropUrl;
  return (
    <View testID="home-hero" collapsable={false}>
      <View style={{ width: '100%', aspectRatio: 4 / 3.4 }}>
        <HeroFade left={false}>
          <Artwork uri={image} title={featured.title} />
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
          <SpecLabels spec={featured.spec} max={3} />
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
              onPress={() =>
                detail.playWorkId &&
                play({ workId: detail.playWorkId, title: detail.playTitle, startSeconds: resume })
              }
            />
          ) : null}
          <GlassButton
            testID="home-hero-info"
            icon={Info}
            tint={featured.tint}
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
        </View>
      </View>
    </View>
  );
}
