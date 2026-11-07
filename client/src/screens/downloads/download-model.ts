import type {
  DownloadCandidate,
  DownloadPack,
  DownloadPlanItem,
  DownloadRequestItem,
  DownloadSeasonEpisode,
  OfflineDownload,
  SpaceVerdict,
} from '@/downloads';
import { isRemovingDownload } from '@/downloads';
import { blockedBy } from '@/downloads/library';
import { parseWorkId } from '@/lib/work-id';

type Fitting = { space?: SpaceVerdict | null };

/** What the sheet selects first: the recommended version when it fits, else the first one that fits, else nothing. */
export function defaultCandidate<T extends DownloadCandidate & Fitting>(
  list: readonly T[]
): T | undefined {
  const playable = list.filter((item) => item.offline.playable);
  const fits = (item: T) => item.space?.fits !== false;
  return playable.find((item) => item.recommended && fits(item)) ?? playable.find(fits);
}

export const releaseOf = (candidate: Pick<DownloadCandidate, 'version'>) =>
  candidate.version.releaseId ?? '';

/** The season work id of an episode work id (`tmdb-tv-1396-s02e03` → `tmdb-tv-1396-s02`). */
export function seasonWorkIdOf(workId: string | null | undefined): string | null {
  const ref = parseWorkId(workId);
  if (ref?.kind === 'season') return workId ?? null;
  if (ref?.kind !== 'episode') return null;
  return `tmdb-tv-${ref.tmdbId}-s${String(ref.season).padStart(2, '0')}`;
}

export type SeasonMode = 'pack' | 'similar' | 'each';

/** `same_release` … `none` from the plan, the viewer's own pick, or the recommendation ("each yourself"). */
export type RowMatch =
  | 'same_release'
  | 'same_variant'
  | 'same_group'
  | 'best_available'
  | 'none'
  | 'manual'
  | 'recommended';

const PLAN_MATCHES = new Set<string>([
  'same_release',
  'same_variant',
  'same_group',
  'best_available',
  'none',
]);

export type RowStatus =
  /** A finished download of this episode exists: skipped. */
  | 'on_device'
  /** Queued … verifying: already in the Downloads list, skipped. */
  | 'in_progress'
  /** Being removed: no new download of it until the old one is gone. */
  | 'removing'
  /** Not aired, or no version plays as it is here. */
  | 'unavailable'
  /** The plan is still being asked. */
  | 'loading'
  | 'ready';

export type ReviewRow = {
  workId: string;
  episodeNumber: number;
  title: string | null;
  aired: boolean;
  status: RowStatus;
  candidate: DownloadCandidate | null;
  match: RowMatch | null;
  selected: boolean;
  /** Downloadable versions of the episode (the row's "change" list). */
  choices: DownloadCandidate[];
  /** An earlier download of it failed (with its reason): downloading again replaces it. */
  failedBefore?: boolean;
  failedError?: OfflineDownload['error'];
  /** The plan chose a version in another language than the picked one: its languages ([] = untagged). */
  languageDiffers?: string[];
};

export type RowInput = {
  episodes: readonly (Omit<DownloadSeasonEpisode, 'candidates'> & {
    candidates: DownloadCandidate[];
  })[];
  /** The profile's downloads of this season (any state). */
  existing: readonly (Pick<OfflineDownload, 'workId' | 'state'> & {
    error?: OfflineDownload['error'];
  })[];
  /** Picks the viewer made per episode (release ids). */
  overrides: Readonly<Record<string, string>>;
  /** Episodes the viewer deselected. */
  deselected: ReadonlySet<string>;
};

function existingStatus(
  workId: string,
  existing: RowInput['existing']
): 'on_device' | 'in_progress' | 'removing' | 'failed' | null {
  const download = existing.find((item) => item.workId === workId);
  if (!download) return null;
  if (isRemovingDownload(download)) return 'removing';
  if (download.state === 'failed') return 'failed';
  return download.state === 'done' ? 'on_device' : 'in_progress';
}

const playableOf = (episode: RowInput['episodes'][number]) =>
  episode.candidates.filter((item) => item.offline.playable);

function row(
  episode: RowInput['episodes'][number],
  input: RowInput,
  pick: (choices: DownloadCandidate[]) => {
    candidate: DownloadCandidate | null;
    match: RowMatch | null;
    loading?: boolean;
    languageDiffers?: string[];
  }
): ReviewRow {
  const workId = episode.workId ?? '';
  const choices = playableOf(episode);
  const held = existingStatus(workId, input.existing);
  const failedError =
    held === 'failed' ? input.existing.find((item) => item.workId === workId)?.error : undefined;
  const base = {
    workId,
    episodeNumber: episode.episodeNumber,
    title: episode.title ?? null,
    aired: episode.aired,
    choices,
    ...(held === 'failed' ? { failedBefore: true, failedError: failedError ?? null } : null),
  };
  if (held && held !== 'failed')
    return { ...base, status: held, candidate: null, match: null, selected: false };
  const override = input.overrides[workId];
  const manual = override ? choices.find((item) => releaseOf(item) === override) : undefined;
  const chosen = manual ? { candidate: manual, match: 'manual' as const } : pick(choices);
  if (chosen.loading)
    return { ...base, status: 'loading', candidate: null, match: null, selected: false };
  if (!chosen.candidate || !workId)
    return {
      ...base,
      status: 'unavailable',
      candidate: null,
      match: chosen.match,
      selected: false,
    };
  return {
    ...base,
    status: 'ready',
    candidate: chosen.candidate,
    match: chosen.match,
    selected: !input.deselected.has(workId),
    ...('languageDiffers' in chosen && chosen.languageDiffers
      ? { languageDiffers: chosen.languageDiffers }
      : null),
  };
}

/** "Pick every episode yourself": each episode's recommended version unless the viewer picked another. */
export function eachRows(input: RowInput): ReviewRow[] {
  return input.episodes.map((episode) =>
    row(episode, input, (choices) => {
      const candidate = defaultCandidate(choices) ?? choices[0] ?? null;
      return { candidate, match: candidate ? 'recommended' : null };
    })
  );
}

/** "Pick one, the rest by similarity": the plan's release per episode (the anchor's own pick for the anchor). */
export function similarRows(
  input: RowInput,
  plan: readonly DownloadPlanItem[] | undefined,
  anchor: { workId: string; releaseId: string } | null
): ReviewRow[] {
  return input.episodes.map((episode) =>
    row(episode, input, (choices) => {
      if (!choices.length) return { candidate: null, match: null };
      if (anchor && episode.workId === anchor.workId) {
        const own = choices.find((item) => releaseOf(item) === anchor.releaseId) ?? null;
        return { candidate: own, match: own ? 'same_release' : null };
      }
      if (!plan) return { candidate: null, match: null, loading: !!anchor };
      const item = plan.find((entry) => entry.workId === episode.workId);
      if (!item?.candidate) return { candidate: null, match: 'none' };
      const listed = choices.find((choice) => releaseOf(choice) === releaseOf(item.candidate!));
      const match = PLAN_MATCHES.has(item.match ?? '') ? (item.match as RowMatch) : null;
      const candidate = listed ?? item.candidate;
      return { candidate, match, languageDiffers: languageDiffers(item, candidate) };
    })
  );
}

/** `language_differs` on a plan item: the chosen version's languages (`params.languages`, else the version's own). */
function languageDiffers(item: DownloadPlanItem, chosen: DownloadCandidate): string[] | undefined {
  const note = item.notes?.find((entry) => entry.code === 'language_differs');
  if (!note) return undefined;
  const listed = note.params?.languages;
  if (listed === undefined) return [...(chosen.version.languages ?? [])];
  return listed === 'untagged'
    ? []
    : listed
        .split(',')
        .map((code) => code.trim())
        .filter(Boolean);
}

/** A pack, episode by episode: each covered episode's file from that pack (unless picked otherwise). */
export function packRows(input: RowInput, pack: DownloadPack | undefined): ReviewRow[] {
  if (!pack) return [];
  const covered = new Set(pack.episodes ?? []);
  return input.episodes
    .filter((episode) => covered.has(episode.episodeNumber))
    .map((episode) =>
      row(episode, input, () => {
        const own = episode.candidates.find((item) => releaseOf(item) === releaseOf(pack));
        return {
          candidate: own ?? {
            version: pack.version,
            offline: pack.offline,
            sizeBytes: pack.perEpisodeSizeBytes,
            sizeExact: false,
            sizeSource: 'estimate',
            seasonPack: true,
            packEpisodes: pack.episodes,
            recommended: false,
          },
          match: null,
        };
      })
    );
}

type AnchorEpisode = Pick<RowInput['episodes'][number], 'workId'> & {
  candidates: readonly (DownloadCandidate & Fitting)[];
};

/** The default anchor: from the episode the viewer started at onwards (then the ones before), the first one not on the device whose best version fits. */
export function defaultAnchor(
  episodes: readonly AnchorEpisode[],
  startedFrom: string | null,
  held: ReadonlySet<string>
): { workId: string; releaseId: string } | undefined {
  const start = Math.max(
    0,
    episodes.findIndex((episode) => episode.workId === startedFrom)
  );
  const ordered = [...episodes.slice(start), ...episodes.slice(0, start)];
  for (const episode of ordered) {
    if (!episode.workId || held.has(episode.workId)) continue;
    const candidate = defaultCandidate(episode.candidates);
    if (candidate) return { workId: episode.workId, releaseId: releaseOf(candidate) };
  }
  return undefined;
}

/** Each pack judged by what it would download now: its episodes minus those on the device or deselected. */
export function packSelections(
  input: RowInput,
  packs: readonly DownloadPack[]
): Map<DownloadPack, Selection> {
  return new Map(packs.map((pack) => [pack, selectionOf(packRows(input, pack))]));
}

export type Selection = {
  rows: ReviewRow[];
  count: number;
  bytes: number;
  /** Some size is an estimate (indexer or pack share). */
  estimate: boolean;
};

export function selectionOf(rows: ReviewRow[]): Selection {
  const chosen = rows.filter((item) => item.selected && item.candidate);
  return {
    rows: chosen,
    count: chosen.length,
    bytes: chosen.reduce((sum, item) => sum + (item.candidate?.sizeBytes ?? 0), 0),
    estimate: chosen.some((item) => !item.candidate?.sizeExact),
  };
}

/** `start(items)` for the chosen versions (the snapshot completes the rest of the metadata). */
export function requestItems(
  rows: readonly Pick<ReviewRow, 'workId' | 'title' | 'candidate'>[],
  meta: { seriesTitle?: string | null } = {}
): DownloadRequestItem[] {
  return rows.flatMap((item) =>
    item.candidate
      ? [
          {
            workId: item.workId,
            releaseId: releaseOf(item.candidate),
            candidate: { sizeBytes: item.candidate.sizeBytes, version: item.candidate.version },
            meta: {
              ...(item.title ? { title: item.title } : null),
              ...(meta.seriesTitle ? { seriesTitle: meta.seriesTitle } : null),
            },
          },
        ]
      : []
  );
}

/** Reasons a download card names (subtitle hint first); `vlc_fallback` is left out: here VLC is how it plays, no fault. */
const NOTE_ORDER = [
  'image_subtitle_vlc',
  'subtitle_not_deliverable',
  'hdr_tone_mapped',
  'dolby_vision_base_layer',
];

export function candidateNotes(candidate: Pick<DownloadCandidate, 'offline'>) {
  const reasons = candidate.offline.reasons ?? [];
  return NOTE_ORDER.flatMap((code) => reasons.filter((reason) => reason.code === code));
}

/** What a failed download offers (`error.actions` of the server or the core); none listed means retry, held back nothing. */
export function failureActions(download: Pick<OfflineDownload, 'state' | 'error'>): {
  retry: boolean;
  otherVersion: boolean;
} {
  if (download.state !== 'failed' || blockedBy(download))
    return { retry: false, otherVersion: false };
  const offered = download.error?.actions;
  return {
    retry: !offered?.length || offered.includes('retry'),
    otherVersion: !!offered?.includes('otherVersion'),
  };
}
