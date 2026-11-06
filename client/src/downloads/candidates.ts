import type { DeviceProfile } from '@modules/media-caps';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useMemo, useSyncExternalStore } from 'react';

import { useActiveAccount } from '@/accounts/accounts-provider';
import { unwrap } from '@/api/client';
import { useAudioLanguages } from '@/browse/queries';
import { preferredEngine, subscribeCapabilityOverrides } from '@/player/capability-overrides';
import { useDeviceProfile, versionHints } from '@/player/device-profile';
import { accountKey } from '@/query/keys';

import { useDownloadStorage } from './hooks';
import { spaceVerdict } from './library';
import type {
  DownloadCandidate,
  DownloadCandidatesResponse,
  DownloadPack,
  DownloadPlanItem,
  DownloadPlanResponse,
  DownloadSeasonCandidatesResponse,
  DownloadSeasonEpisode,
  SpaceVerdict,
} from './types';

export type CandidateWithSpace = DownloadCandidate & { space: SpaceVerdict };
export type PackWithSpace = DownloadPack & { space: SpaceVerdict };

export type DownloadCandidatesView = Omit<DownloadCandidatesResponse, 'candidates'> & {
  candidates: CandidateWithSpace[];
  /** `offline.playable` ones (direct or VLC), in the download order. */
  downloadable: CandidateWithSpace[];
};

export type SeasonCandidatesView = Omit<DownloadSeasonCandidatesResponse, 'packs' | 'episodes'> & {
  packs: PackWithSpace[];
  episodes: (Omit<DownloadSeasonEpisode, 'candidates'> & { candidates: CandidateWithSpace[] })[];
};

export type DownloadPlanView = Omit<DownloadPlanResponse, 'items'> & {
  items: (DownloadPlanItem & { space: SpaceVerdict | null })[];
  /** The whole plan against the free space. */
  space: SpaceVerdict;
};

export type SpaceCheck = {
  /** Free − queued − reserve; null until the engine answered (or where downloads do not exist). */
  availableBytes: number | null;
  verdict(neededBytes: number, estimate?: boolean): SpaceVerdict;
};

/** Verdicts against the device's free space, taking what queued downloads still need into account. */
export function useDownloadSpace(): SpaceCheck {
  const storage = useDownloadStorage();
  const available = storage?.availableBytes ?? null;
  const verdict = useCallback(
    (neededBytes: number, estimate = false) =>
      spaceVerdict(neededBytes, available ?? Number.MAX_SAFE_INTEGER, estimate),
    [available]
  );
  return useMemo(() => ({ availableBytes: available, verdict }), [available, verdict]);
}

const withSpace = (candidate: DownloadCandidate, check: SpaceCheck): CandidateWithSpace => ({
  ...candidate,
  space: check.verdict(candidate.sizeBytes, !candidate.sizeExact),
});

function useRequestContext() {
  const { account, client } = useActiveAccount();
  const profile = useDeviceProfile();
  const audioLanguages = useAudioLanguages();
  const engine = useSyncExternalStore(
    subscribeCapabilityOverrides,
    () => preferredEngine()?.engine ?? 'auto'
  );
  const device: DeviceProfile | undefined = profile.data;
  return {
    account,
    client,
    device,
    // A failed capability probe still asks (the server falls back to its conservative profile).
    ready: profile.data !== undefined || profile.isError,
    hints: device ? versionHints(device) : null,
    audioLanguages: [audioLanguages],
    engine,
  };
}

/** Versions of a movie or episode with offline playability and a space verdict each (`POST …/candidates`). */
export function useDownloadCandidates(
  workId: string | null | undefined,
  { enabled = true, refresh = false }: { enabled?: boolean; refresh?: boolean } = {}
) {
  const context = useRequestContext();
  const check = useDownloadSpace();
  const query = useQuery({
    queryKey: accountKey(
      context.account.id,
      'downloads',
      'candidates',
      workId,
      context.hints,
      context.audioLanguages,
      context.engine,
      refresh
    ),
    queryFn: ({ signal }) =>
      unwrap(
        context.client.POST('/api/v1/viewer/downloads/candidates', {
          body: {
            workId,
            device: context.device ?? null,
            audioLanguages: context.audioLanguages,
            engine: context.engine,
            refresh,
          },
          signal,
        })
      ),
    enabled: enabled && !!workId && context.ready,
    staleTime: 5 * 60_000,
  });
  const data = useMemo((): DownloadCandidatesView | undefined => {
    if (!query.data) return undefined;
    const candidates = (query.data.candidates ?? []).map((item) => withSpace(item, check));
    return {
      ...query.data,
      candidates,
      downloadable: candidates.filter((item) => item.offline.playable),
    };
  }, [query.data, check]);
  return { query, data, space: check };
}

/** A season's packs and per-episode candidates, each with a space verdict (`POST …/candidates/season`). */
export function useSeasonDownloadCandidates(
  seasonWorkId: string | null | undefined,
  { enabled = true, includeEpisodes = true }: { enabled?: boolean; includeEpisodes?: boolean } = {}
) {
  const context = useRequestContext();
  const check = useDownloadSpace();
  const query = useQuery({
    queryKey: accountKey(
      context.account.id,
      'downloads',
      'season',
      seasonWorkId,
      context.hints,
      context.audioLanguages,
      context.engine,
      includeEpisodes
    ),
    queryFn: ({ signal }) =>
      unwrap(
        context.client.POST('/api/v1/viewer/downloads/candidates/season', {
          body: {
            workId: seasonWorkId,
            device: context.device ?? null,
            audioLanguages: context.audioLanguages,
            engine: context.engine,
            includeEpisodes,
          },
          signal,
        })
      ),
    enabled: enabled && !!seasonWorkId && context.ready,
    staleTime: 5 * 60_000,
  });
  const data = useMemo((): SeasonCandidatesView | undefined => {
    if (!query.data) return undefined;
    return {
      ...query.data,
      packs: (query.data.packs ?? []).map((pack) => ({
        ...pack,
        space: check.verdict(pack.sizeBytes, !pack.sizeExact),
      })),
      episodes: (query.data.episodes ?? []).map((episode) => ({
        ...episode,
        candidates: (episode.candidates ?? []).map((item) => withSpace(item, check)),
      })),
    };
  }, [query.data, check]);
  return { query, data, space: check };
}

/** "Pick one, the rest by similarity" (`POST …/plan`); null anchor = not asked yet. */
export function useDownloadPlan(
  anchor: { workId: string; releaseId: string } | null,
  workIds: readonly string[],
  { enabled = true }: { enabled?: boolean } = {}
) {
  const context = useRequestContext();
  const check = useDownloadSpace();
  const query = useQuery({
    queryKey: accountKey(
      context.account.id,
      'downloads',
      'plan',
      anchor?.workId,
      anchor?.releaseId,
      [...workIds],
      context.hints,
      context.audioLanguages,
      context.engine
    ),
    queryFn: ({ signal }) =>
      unwrap(
        context.client.POST('/api/v1/viewer/downloads/plan', {
          body: {
            anchorWorkId: anchor?.workId,
            anchorReleaseId: anchor?.releaseId,
            workIds: [...workIds],
            device: context.device ?? null,
            audioLanguages: context.audioLanguages,
            engine: context.engine,
          },
          signal,
        })
      ),
    enabled: enabled && !!anchor && workIds.length > 0 && context.ready,
    staleTime: 5 * 60_000,
  });
  const data = useMemo((): DownloadPlanView | undefined => {
    if (!query.data) return undefined;
    return {
      ...query.data,
      items: (query.data.items ?? []).map((item) => ({
        ...item,
        space: item.candidate
          ? check.verdict(item.candidate.sizeBytes, !item.candidate.sizeExact)
          : null,
      })),
      space: check.verdict(query.data.totalSizeBytes, !query.data.totalSizeExact),
    };
  }, [query.data, check]);
  return { query, data, space: check };
}
