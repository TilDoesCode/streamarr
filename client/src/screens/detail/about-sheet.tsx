import { useLocalSearchParams, useRouter } from 'expo-router';
import type { TFunction } from 'i18next';
import { X } from 'lucide-react-native';
import { useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal, Platform, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { toAppError } from '@/api/errors';
import {
  useMovieDetail,
  useSeriesDetail,
  type MovieDetail,
  type SeriesDetail,
} from '@/browse/queries';
import { SheetPanel, versionSheetFrame, type VersionSheetFrame } from '@/browse/version-sheet';
import { useInitialFocus } from '@/components/focus';
import { GlassButton } from '@/components/glass';
import { ErrorState } from '@/components/states/error-state';
import { IconButton } from '@/components/ui/icon-button';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useFormat } from '@/i18n/format';
import { META_SEPARATOR } from '@/lib/media-labels';
import { aboutHref, type AboutRequest } from '@/navigation/routes';
import { useShell } from '@/shell/use-shell';
import { colors, fonts, useDesign } from '@/theme';

import { peopleCredits } from './large-detail';

/** "2010 – 2017 · 4 seasons · 13 episodes": first to last aired regular season, counts. */
export function seriesFacts(series: SeriesDetail, t: TFunction): string[] {
  const years = (series.seasons ?? [])
    .filter((item) => item.seasonNumber > 0 && item.airDate)
    .map((item) => new Date(item.airDate!).getFullYear())
    .filter((year) => !Number.isNaN(year));
  const from = years.length ? Math.min(...years) : series.year;
  const to = years.length ? Math.max(...years) : undefined;
  const span = from
    ? to && to !== from
      ? t('detail.yearSpan', { from, to })
      : String(from)
    : null;
  return [
    span,
    series.seasonCount ? t('media.seasons', { count: series.seasonCount }) : null,
    series.episodeCount ? t('media.episodes', { count: series.episodeCount }) : null,
  ].filter((part): part is string => !!part);
}

type AboutProps = AboutRequest & { onClose: () => void };

/** Header and body of the About sheet ("About the series" / movie "Details") in every state. */
function useAboutParts({ kind, tmdbId, title, onClose }: AboutProps, frame: VersionSheetFrame) {
  const { t } = useTranslation();
  const format = useFormat();
  const design = useDesign();
  const { s, font } = useShell();
  const movie = useMovieDetail(tmdbId, kind === 'movie');
  const series = useSeriesDetail(tmdbId, kind === 'series');
  const query = kind === 'movie' ? movie : series;
  const data = query.data as (MovieDetail | SeriesDetail) | undefined;
  const form = frame === 'form';
  // Web drawer: focus moves into the dialog (Esc returns it to the opener).
  const closeRef = useRef<View>(null);
  useInitialFocus(closeRef, frame === 'drawer');
  const size = (value: number) => (form ? design.px(value * 0.8) : font(value, 13));
  const body = (value: number, color: string = colors.foreground.DEFAULT) => ({
    fontSize: size(value),
    lineHeight: size(value) * 1.45,
    color,
  });

  const header = (
    <View style={{ gap: s(6), paddingBottom: s(8) }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: s(16) }}>
        <Text
          role="heading"
          style={{
            flex: 1,
            fontFamily: fonts.displayBold,
            fontSize: form ? design.px(28) : s(44),
            lineHeight: form ? design.px(34) : s(52),
            color: colors.foreground.DEFAULT,
          }}>
          {t(kind === 'series' ? 'detail.aboutSeries' : 'detail.details')}
        </Text>
        {frame === 'drawer' || (form && design.formFactor !== 'phone') ? (
          <IconButton
            ref={closeRef}
            testID="about-sheet-close"
            icon={X}
            variant="ghost"
            size="sm"
            accessibilityLabel={t('common.close')}
            onPress={onClose}
          />
        ) : null}
      </View>
      <Text tone="muted" numberOfLines={2} style={{ fontSize: s(20), lineHeight: s(28) }}>
        {data?.title ?? title}
      </Text>
    </View>
  );

  let content: ReactNode;
  if (query.error && !data)
    content = (
      <ErrorState
        testID="about-error"
        code={toAppError(query.error).code}
        actions={['retry']}
        autoFocus
        onAction={() => void query.refetch()}
      />
    );
  else if (!data)
    content = (
      <View testID="about-loading" style={{ gap: s(14) }}>
        <Skeleton height={s(140)} radius={s(12)} />
        <Skeleton width={s(320)} height={s(24)} radius={s(8)} />
        <Skeleton width={s(420)} height={s(24)} radius={s(8)} />
      </View>
    );
  else {
    const facts =
      kind === 'series'
        ? seriesFacts(data as SeriesDetail, t)
        : [
            data.year ? String(data.year) : null,
            data.runtimeMinutes ? format.duration(data.runtimeMinutes * 60) : null,
          ].filter((part): part is string => !!part);
    const rows: { label: string; value: string }[] = [
      ...(data.genres?.length
        ? [{ label: t('detail.genres'), value: data.genres.join(', ') }]
        : []),
      ...peopleCredits(data.people, t, 8),
      ...(data.originalTitle && data.originalTitle !== data.title
        ? [{ label: t('detail.originalTitle'), value: data.originalTitle }]
        : []),
    ];
    const watch = kind === 'series' ? (data as SeriesDetail).watch : undefined;
    content = (
      <View testID="about-body" style={{ gap: s(20) }}>
        {data.tagline ? (
          <Text style={[body(22, colors.foreground.muted), { fontStyle: 'italic' }]}>
            {data.tagline}
          </Text>
        ) : null}
        {data.overview ? (
          <Text testID="about-overview" style={body(22)}>
            {data.overview}
          </Text>
        ) : null}
        <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: s(12) }}>
          {facts.length ? (
            <Text testID="about-facts" style={body(20, colors.foreground.muted)}>
              {facts.join(META_SEPARATOR)}
            </Text>
          ) : null}
          {data.voteAverage ? (
            <Text style={[body(20), { fontFamily: fonts.bodySemiBold }]}>
              <Text style={{ color: colors.warning.DEFAULT }}>
                {`★ ${format.decimal(data.voteAverage)}`}
              </Text>
              {t('detail.ratingSource')}
            </Text>
          ) : null}
          {data.certification ? (
            <View
              style={{
                borderWidth: s(1.5),
                borderColor: colors.foreground.muted,
                borderRadius: s(6),
                paddingHorizontal: s(8),
              }}>
              <Text style={[body(18, colors.foreground.muted), { fontFamily: fonts.bodySemiBold }]}>
                {data.certification}
              </Text>
            </View>
          ) : null}
        </View>
        {watch?.totalEpisodes ? (
          <Text style={body(20, colors.foreground.muted)}>
            {t('detail.watchedCount', {
              played: watch.playedEpisodes ?? 0,
              total: watch.totalEpisodes,
            })}
          </Text>
        ) : null}
        {rows.map((row) => (
          <View key={row.label} testID="about-row" style={{ flexDirection: 'row', gap: s(20) }}>
            <Text style={[body(18, colors.foreground.muted), { width: s(150) }]}>{row.label}</Text>
            <Text style={[body(20), { flex: 1, fontFamily: fonts.bodyMedium }]}>{row.value}</Text>
          </View>
        ))}
      </View>
    );
  }
  return { header, content };
}

/** TV: the sheet's only focus target (Back/Menu close it too), so focus never falls through to the page. */
function TvClose({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const { s } = useShell();
  const ref = useRef<View>(null);
  useInitialFocus(ref, true);
  return (
    <View style={{ alignItems: 'flex-start', marginTop: s(28) }}>
      <GlassButton
        ref={ref}
        testID="about-sheet-close"
        icon={X}
        label={t('common.close')}
        hasTVPreferredFocus
        onPress={onClose}
      />
    </View>
  );
}

/** The About sheet as the glass side panel (TV) or drawer (web, Android tablets). */
function AboutPanel(props: AboutProps & { frame: 'tv' | 'drawer' }) {
  const { header, content } = useAboutParts(props, props.frame);
  return (
    <SheetPanel
      frame={props.frame}
      testID="about-sheet"
      title={props.title}
      onClose={props.onClose}
      header={header}>
      {content}
      {props.frame === 'tv' ? <TvClose onClose={props.onClose} /> : null}
    </SheetPanel>
  );
}

/** `about/[kind]/[id]`: TV side sheet, Android tablet drawer, iOS formSheet (web opens it in the page). */
export function AboutSheetScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ kind: string; id: string; title?: string }>();
  const props: AboutProps = {
    kind: params.kind === 'series' ? 'series' : 'movie',
    tmdbId: Number(params.id),
    title: params.title ?? '',
    onClose: () => router.back(),
  };
  const frame = versionSheetFrame();
  if (frame === 'form') return <AboutForm {...props} />;
  return <AboutPanel {...props} frame={frame} />;
}

/** iOS: native formSheet with transparent content (Liquid Glass), like the version sheet. */
function AboutForm(props: AboutProps) {
  const design = useDesign();
  const insets = useSafeAreaInsets();
  const { header, content } = useAboutParts(props, 'form');
  return (
    <ScrollView
      testID="about-sheet"
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{
        padding: design.layout.gutter,
        paddingBottom: insets.bottom + design.space.xl,
        gap: design.space.md,
      }}>
      {header}
      {content}
    </ScrollView>
  );
}

/** Web shows the sheet in the page: a route push would add a browser history entry. */
export const aboutSheetHost = { inPage: () => Platform.OS === 'web' };

/** Large detail pages: the info column opens the About sheet (web: in-page drawer, elsewhere the route). */
export function useAboutSheet(request: AboutRequest | null) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const inPage = aboutSheetHost.inPage();
  const show = () => {
    if (!request) return;
    if (inPage) setOpen(true);
    else router.push(aboutHref(request));
  };
  const close = () => setOpen(false);
  const drawer =
    inPage && request ? (
      <Modal visible={open} transparent animationType="none" onRequestClose={close}>
        {open ? <AboutPanel {...request} frame="drawer" onClose={close} /> : null}
      </Modal>
    ) : null;
  return { open: show, drawer };
}
