import type { TFunction } from 'i18next';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import type { Account } from '@/accounts/types';
import { unwrap, type ApiClient } from '@/api/client';
import { useConnectivity } from '@/connectivity/provider';
import { downloadAccountKey } from '@/downloads/keys';
import {
  nextDownloadedEpisode,
  resolveLocalPlayTarget,
  resumeSecondsOf,
} from '@/downloads/local-play';
import type { DownloadManager } from '@/downloads/manager';
import {
  getDownloadEngine,
  getDownloadManager,
  useOptionalDownloadsContext,
} from '@/downloads/provider';
import type { OfflineDownload } from '@/downloads/types';
import type { LocalSource } from '@/player/controller-types';
import { TICKS_PER_SECOND } from '@/player/playback-api';

import type { NextEpisode } from './up-next';

/** The server's position of a work and when it was saved (null when it cannot be asked within `timeoutMs`). */
async function serverPosition(
  client: ApiClient,
  workId: string,
  timeoutMs = 2_500
): Promise<{ seconds: number; at: number | null } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const [state] = await unwrap(
      client.POST('/api/v1/viewer/watch/state', {
        body: { workIds: [workId] },
        signal: controller.signal,
      })
    );
    if (!state) return null;
    const at = state.lastPlayedAt ? Date.parse(state.lastPlayedAt) : NaN;
    return {
      seconds: state.played ? 0 : (state.positionTicks ?? 0) / TICKS_PER_SECOND,
      at: Number.isFinite(at) ? at : null,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The download this start plays from the device, or null to stream: a finished download of the work is the default
 * (also online); a version the viewer picked explicitly streams unless the server cannot be reached.
 */
export async function prepareLocalSource(input: {
  workId: string;
  releaseId?: string;
  account: Account;
  client: ApiClient;
  offline: () => boolean;
  manager?: DownloadManager | null;
}): Promise<LocalSource | null> {
  const manager = input.manager ?? getDownloadManager();
  const accountKey = downloadAccountKey(input.account);
  const offline = input.offline();
  const target = resolveLocalPlayTarget(
    input.workId,
    accountKey,
    manager,
    getDownloadEngine(),
    offline ? undefined : input.releaseId
  );
  if (!target) return null;
  const local = target.position;
  const server = offline ? null : await serverPosition(input.client, input.workId);
  return {
    downloadId: target.download.id,
    uri: target.uri,
    engine: target.engine,
    mediaInfo: target.mediaInfo,
    version: target.download.version,
    releaseId: target.download.sourceReleaseId ?? target.download.releaseId,
    resumeSeconds: resumeSecondsOf(local, server),
    offline: input.offline,
  };
}

/** Saves the position of a work this profile downloaded (the local position store, also for streamed plays). */
export function recordDownloadedPosition(
  account: Account,
  workId: string,
  seconds: number,
  durationSeconds: number
): void {
  const manager = getDownloadManager();
  const accountKey = downloadAccountKey(account);
  if (!manager?.store.forAccount(accountKey).some((download) => download.workId === workId)) return;
  manager.recordPosition(accountKey, workId, seconds, durationSeconds || null);
}

function nextOf(t: TFunction, download: OfflineDownload): NextEpisode {
  const code: string = t('media.episodeCode', {
    season: download.seasonNumber ?? 0,
    episode: download.episodeNumber ?? 0,
  });
  const title =
    download.meta.title || t('media.episodeNumber', { episode: download.episodeNumber ?? 0 });
  return {
    workId: download.workId,
    title: download.meta.title ? `${code} · ${download.meta.title}` : code,
    playTitle: t('detail.episodeTitle', { series: download.meta.seriesTitle ?? '', code, title }),
  };
}

/** Offline up-next: the next downloaded episode of the series (the catalog cannot be asked). */
export function useOfflineNextEpisode(workId: string, account: Account): NextEpisode | null {
  const { t } = useTranslation();
  const { offline } = useConnectivity();
  const downloads = useOptionalDownloadsContext();
  return useMemo(() => {
    if (!offline || !downloads) return null;
    const next = nextDownloadedEpisode(workId, downloadAccountKey(account), downloads.manager);
    return next ? nextOf(t, next) : null;
  }, [offline, downloads, workId, account, t]);
}
