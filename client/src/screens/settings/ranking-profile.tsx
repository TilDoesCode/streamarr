import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { TFunction } from 'i18next';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { useActiveAccount } from '@/accounts/accounts-provider';
import type { components } from '@/api/schema';
import { unwrap } from '@/api/client';
import { languageName } from '@/browse/version-format';
import { SlidersHorizontal } from '@/components/icons';
import { SettingsRow } from '@/components/settings';
import { Sheet, SheetItem } from '@/components/ui/sheet';
import { SkeletonText } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { useToast } from '@/components/ui/toast';
import { accountKey } from '@/query/keys';
import { useDesign } from '@/theme';

export type RankingProfileState = components['schemas']['ViewerRankingProfileResponse'];
export type RankingProfileOption = components['schemas']['ViewerRankingProfileDto'];

export const rankingProfileKey = (accountId: string) =>
  accountKey(accountId, 'me', 'ranking-profile');

/** Everything ranked by the profile: version lists (detail, Versions sheet, Play), season version counts, next-episode and My List availability. */
export function invalidateRankings(queryClient: QueryClient, accountId: string) {
  void queryClient.invalidateQueries({ queryKey: accountKey(accountId, 'catalog', 'versions') });
  void queryClient.invalidateQueries({ queryKey: accountKey(accountId, 'catalog', 'series') });
  void queryClient.invalidateQueries({ queryKey: accountKey(accountId, 'watch', 'list') });
}

export function useRankingProfile() {
  const { account, client } = useActiveAccount();
  return useQuery({
    queryKey: rankingProfileKey(account.id),
    queryFn: ({ signal }) => unwrap(client.GET('/api/v1/viewer/me/ranking-profile', { signal })),
    refetchOnMount: 'always',
  });
}

export function useSetRankingProfile() {
  const { account, client } = useActiveAccount();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (profileId: string | null) =>
      unwrap(client.PUT('/api/v1/viewer/me/ranking-profile', { body: { profileId } })),
    onSuccess: (state) => {
      queryClient.setQueryData(rankingProfileKey(account.id), state);
      invalidateRankings(queryClient, account.id);
    },
    onError: () => void queryClient.invalidateQueries({ queryKey: rankingProfileKey(account.id) }),
  });
}

/** What a profile prefers, in the viewer's language: the operator's description first, then the derived traits. */
export function profileSummary(
  profile: RankingProfileOption,
  t: TFunction,
  locale: string
): string {
  const traits = profile.traits;
  const parts: string[] = [];
  if (profile.description) parts.push(profile.description);
  const resolution = traits.preferredResolution;
  if (resolution === '2160p') parts.push(t('settings.rankingProfile.trait.prefers4k'));
  else if (resolution) parts.push(t('settings.rankingProfile.trait.prefers', { resolution }));
  if (traits.savesBandwidth) parts.push(t('settings.rankingProfile.trait.savesBandwidth'));
  if (traits.hdr === 'prefer') parts.push(t('settings.rankingProfile.trait.prefersHdr'));
  else if (traits.hdr === 'avoid') parts.push(t('settings.rankingProfile.trait.avoidsHdr'));
  if (traits.codec === 'hevc' || traits.codec === 'av1')
    parts.push(
      t('settings.rankingProfile.trait.efficientCodec', {
        codec: traits.codec === 'av1' ? 'AV1' : 'HEVC',
      })
    );
  if (traits.languages?.length)
    parts.push(
      t('settings.rankingProfile.trait.languages', {
        languages: traits.languages.map((code) => languageName(code, locale, t)).join(', '),
      })
    );
  const types = profile.mediaTypes ?? [];
  if (types.length === 1)
    parts.push(
      t(
        types[0] === 'movie'
          ? 'settings.rankingProfile.onlyMovies'
          : 'settings.rankingProfile.onlySeries'
      )
    );
  return parts.join(' · ');
}

/** "Serverstandard (Standard)" or the chosen profile; both media types when they differ. */
export function currentRankingLabel(state: RankingProfileState, t: TFunction): string {
  const name = (ref: RankingProfileState['movie']) =>
    ref.source === 'viewer'
      ? (ref.name ?? '')
      : t('settings.rankingProfile.serverDefaultNamed', { name: ref.name });
  const movie = name(state.movie);
  const series = name(state.series);
  return movie === series ? movie : t('settings.rankingProfile.perMediaType', { movie, series });
}

function serverDefaultDescription(state: RankingProfileState, t: TFunction): string {
  const { movie, series } = state.serverDefault;
  return movie.id === series.id
    ? t('settings.rankingProfile.serverDefaultFollows', { name: movie.name })
    : t('settings.rankingProfile.perMediaType', { movie: movie.name, series: series.name });
}

/** Settings entry: the ranking profile in use and, when the operator allows it, a picker sheet. */
export function RankingProfileEntry() {
  const { t, i18n } = useTranslation();
  const design = useDesign();
  const toast = useToast();
  const state = useRankingProfile();
  const save = useSetRankingProfile();
  const [open, setOpen] = useState(false);

  const choose = (profileId: string | null) => {
    setOpen(false);
    if (profileId === (state.data?.profileId ?? null)) return;
    save.mutate(profileId, {
      onSuccess: (next) =>
        toast.show({
          tone: 'success',
          message: t('settings.rankingProfile.saved', { name: currentRankingLabel(next, t) }),
        }),
      onError: () =>
        toast.show({ tone: 'error', message: t('settings.rankingProfile.saveFailed') }),
    });
  };

  const label = t('settings.rankingProfile.title');
  if (!state.data)
    return state.isError ? (
      <SettingsRow
        icon={SlidersHorizontal}
        label={label}
        description={t('settings.rankingProfile.loadFailed')}
        descriptionTestID="ranking-profile-error"
      />
    ) : (
      <SettingsRow icon={SlidersHorizontal} label={label}>
        <View testID="ranking-profile-loading" style={{ gap: design.space.xs }}>
          <SkeletonText width="40%" />
        </View>
      </SettingsRow>
    );

  const data = state.data;
  const selected = data.profileId ?? null;
  const current = t('settings.rankingProfile.current', { name: currentRankingLabel(data, t) });
  const hint = (
    <Text variant="caption" tone="subtle">
      {t('settings.rankingProfile.hint')}
    </Text>
  );
  return (
    <>
      {data.canChoose ? (
        <SettingsRow
          testID="ranking-profile-choose"
          icon={SlidersHorizontal}
          label={label}
          description={current}
          descriptionTestID="ranking-profile-current"
          busy={save.isPending}
          onPress={() => setOpen(true)}>
          {hint}
        </SettingsRow>
      ) : (
        <SettingsRow
          icon={SlidersHorizontal}
          label={label}
          description={current}
          descriptionTestID="ranking-profile-current">
          {hint}
          <Text testID="ranking-profile-locked" variant="callout" tone="subtle">
            {t('settings.rankingProfile.locked')}
          </Text>
        </SettingsRow>
      )}
      <Sheet
        testID="ranking-profile-sheet"
        open={open && data.canChoose}
        onClose={() => setOpen(false)}
        title={t('settings.rankingProfile.title')}
        subtitle={t('settings.rankingProfile.sheetSubtitle')}
        wide>
        <SheetItem
          label={t('settings.rankingProfile.serverDefault')}
          description={serverDefaultDescription(data, t)}
          selected={selected === null}
          preferred={selected === null}
          onPress={() => choose(null)}
        />
        {(data.profiles ?? []).map((profile) => (
          <SheetItem
            key={profile.id}
            label={profile.name ?? ''}
            description={profileSummary(profile, t, i18n.language) || undefined}
            selected={selected === profile.id}
            preferred={selected === profile.id}
            onPress={() => choose(profile.id)}
          />
        ))}
      </Sheet>
    </>
  );
}
