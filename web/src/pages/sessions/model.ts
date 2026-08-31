import type {
  EphemeralFileResponse,
  PlaybackRangeResponse,
  SessionResponse,
  StreamingHistoryResponse,
  StreamRecordSummaryResponse,
} from "@/api/types";
import { mergeTimelineRanges, rangeCoverage, type TimelineRange } from "@/components/timeline-rail";
import { formatBytes } from "@/lib/utils";

export type StatusFilter = "all" | "live" | "failed" | "completed";

export type LanePhase =
  | "failed"
  | "playing"
  | "pre-downloading"
  | "downloading"
  | "idle"
  | "completed";

/** Which parts of the media timeline were actually watched (Jellyfin time, not payload). */
export interface WatchProgress {
  /** Merged watched intervals as timeline fractions. */
  ranges: TimelineRange[];
  /** Total watched share of the timeline, 0..1. */
  coverage: number;
  /** Latest playhead position as a timeline fraction. */
  playhead?: number;
  durationTicks: number;
}

export interface FailureMode {
  kind: "provider-slow" | "missing-articles" | "repair" | "fallback";
  severity: "bad" | "warn" | "info";
  label: string;
  detail?: string;
}

export interface PlaybackVisit {
  key: string;
  sessionToken?: string;
  releaseId?: string;
  workId?: string;
  title?: string;
  source?: string;
  userId?: string;
  userName?: string;
  device?: string;
  startedAt?: string;
  updatedAt?: string;
  positionTicks: number;
  durationTicks: number;
  state: string;
  eventCount: number;
}

export interface StreamAttempt {
  key: string;
  token?: string;
  workId?: string;
  title: string;
  releaseId?: string;
  fileName?: string;
  container?: string;
  requestedTitle?: string;
  requestedReleaseId?: string;
  state: string;
  isLive: boolean;
  isFailed: boolean;
  isCompleted: boolean;
  failureKind?: string;
  failureReason?: string;
  requester: string;
  source: string;
  device?: string;
  createdAt?: string;
  bytesServed: number;
  sizeBytes: number;
  payloadPercent: number;
  diskPercent?: number;
  diskState?: string;
  retentionPriority?: string;
  purgeAt?: string;
  playbackPositionTicks?: number;
  playbackDurationTicks?: number;
  visits: PlaybackVisit[];
  live?: SessionResponse;
  file?: EphemeralFileResponse;
  record?: StreamRecordSummaryResponse;
}

/** One release inside a work group: every attempt on the same release collapses here. */
export interface ReleaseLane {
  key: string;
  releaseId?: string;
  workId?: string;
  title: string;
  fileName?: string;
  container?: string;
  requestedTitle?: string;
  requestedReleaseId?: string;
  /** Newest first. `latest` === `attempts[0]` and drives status + diagnosis. */
  attempts: StreamAttempt[];
  latest: StreamAttempt;
  phase: LanePhase;
  /** Extra status wording, e.g. the terminal state for completed lanes. */
  phaseDetail?: string;
  failureModes: FailureMode[];
  /** Timeline sections watched through THIS release — release switches stay visible. */
  watched?: WatchProgress;
  updatedAt: number;
}

export interface WorkGroup {
  key: string;
  workId?: string;
  title: string;
  lanes: ReleaseLane[];
  unmatchedVisits: PlaybackVisit[];
  requester?: string;
  device?: string;
  /** Union of every release's watched sections — overall progress through the work. */
  watched?: WatchProgress;
  updatedAt: number;
}

interface AttemptSeed {
  key: string;
  token?: string;
  live?: SessionResponse;
  file?: EphemeralFileResponse;
  record?: StreamRecordSummaryResponse;
  visits: PlaybackVisit[];
}

const FAILURE_STATES = new Set(["dead", "error", "failed", "invalidated"]);
const COMPLETED_STATES = new Set(["closed", "expired", "evicted", "purged", "reused"]);

export function buildWorkGroups(
  sessions: SessionResponse[],
  files: EphemeralFileResponse[],
  records: StreamRecordSummaryResponse[],
  events: StreamingHistoryResponse[],
  playbackRanges: PlaybackRangeResponse[] = [],
): WorkGroup[] {
  const seeds = new Map<string, AttemptSeed>();
  const byToken = new Map<string, AttemptSeed>();
  const ensure = (source: string, token: string | null | undefined, identity: string) => {
    if (token && byToken.has(token)) return byToken.get(token)!;
    const key = token ? `token:${token}` : `${source}:${identity}`;
    const seed = seeds.get(key) ?? { key, token: token || undefined, visits: [] };
    seeds.set(key, seed);
    if (token) byToken.set(token, seed);
    return seed;
  };

  for (const record of records) {
    ensure("record", record.token, `${record.releaseId}:${record.createdAt}`).record = record;
  }
  for (const session of sessions) {
    ensure("session", session.token, `${session.releaseId}:${session.createdAt}`).live = session;
  }
  for (const file of files) {
    ensure("file", file.token, `${file.releaseId}:${file.createdAt}`).file = file;
  }

  const unmatched: PlaybackVisit[] = [];
  for (const visit of aggregatePlaybackEvents(events)) {
    if (visit.sessionToken) {
      ensure("playback", visit.sessionToken, visit.key).visits.push(visit);
    } else {
      unmatched.push(visit);
    }
  }

  const groups = new Map<string, { key: string; workId?: string; title: string; attempts: StreamAttempt[]; unmatchedVisits: PlaybackVisit[]; updatedAt: number }>();
  const ensureGroup = (workId?: string, releaseId?: string, title?: string) => {
    const key = workId ? `work:${workId}` : `unmatched:${releaseId || "unknown"}`;
    const group = groups.get(key) ?? {
      key,
      workId,
      title: title || "Release name unavailable",
      attempts: [],
      unmatchedVisits: [],
      updatedAt: 0,
    };
    if (group.title === "Release name unavailable" && title) group.title = title;
    groups.set(key, group);
    return group;
  };

  for (const seed of seeds.values()) {
    const attempt = normalizeAttempt(seed);
    const group = ensureGroup(attempt.workId, attempt.releaseId, attempt.title);
    group.attempts.push(attempt);
    group.updatedAt = Math.max(group.updatedAt, timestamp(attempt.createdAt));
  }
  for (const visit of unmatched) {
    const group = ensureGroup(visit.workId, visit.releaseId, visit.title);
    group.unmatchedVisits.push(visit);
    group.updatedAt = Math.max(group.updatedAt, timestamp(visit.updatedAt));
  }

  const built = [...groups.values()]
    .map((group) => {
      group.attempts.sort((a, b) => timestamp(b.createdAt) - timestamp(a.createdAt));
      group.unmatchedVisits.sort((a, b) => timestamp(b.updatedAt) - timestamp(a.updatedAt));
      const lanes = collapseIntoLanes(group.attempts);
      const primary = lanes[0]?.latest;
      return {
        key: group.key,
        workId: group.workId,
        title: primary?.title || group.unmatchedVisits[0]?.title || group.title,
        lanes,
        unmatchedVisits: group.unmatchedVisits,
        requester: firstKnown(lanes.map((lane) => lane.latest.requester), "Unknown requester")
          ?? group.unmatchedVisits.map((visit) => visit.userName || visit.userId).find(Boolean),
        device: lanes.map((lane) => lane.latest.device).find(Boolean)
          ?? group.unmatchedVisits.map((visit) => visit.device).find(Boolean),
        updatedAt: group.updatedAt,
      } satisfies WorkGroup;
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
  attachWatchProgress(built, playbackRanges);
  return built;
}

/**
 * Join watched-time scopes onto works and their release lanes. A span is attributed to the
 * lane owning its session token (fallback: its release id); the group gets the union.
 */
function attachWatchProgress(groups: WorkGroup[], scopes: PlaybackRangeResponse[]) {
  if (!scopes.length) return;
  const byWork = new Map<string, PlaybackRangeResponse[]>();
  for (const scope of scopes) {
    if (!scope.workId) continue;
    byWork.set(scope.workId, [...(byWork.get(scope.workId) ?? []), scope]);
  }

  for (const group of groups) {
    const workScopes = group.workId ? byWork.get(group.workId) : undefined;
    if (!workScopes?.length) continue;
    const durationTicks = Math.max(...workScopes.map((scope) => scope.durationTicks ?? 0));
    if (durationTicks <= 0) continue;

    const laneByToken = new Map<string, ReleaseLane>();
    const laneByRelease = new Map<string, ReleaseLane>();
    for (const lane of group.lanes) {
      for (const attempt of lane.attempts) {
        if (attempt.token) laneByToken.set(attempt.token, lane);
      }
      if (lane.releaseId) laneByRelease.set(lane.releaseId, lane);
    }

    const groupRanges: TimelineRange[] = [];
    const perLane = new Map<ReleaseLane, TimelineRange[]>();
    for (const scope of workScopes) {
      for (const span of scope.ranges ?? []) {
        const range = toFractionRange(span.startTicks ?? 0, span.endTicks ?? 0, durationTicks);
        if (!range) continue;
        groupRanges.push(range);
        const lane = (span.sessionToken ? laneByToken.get(span.sessionToken) : undefined)
          ?? (span.releaseId ? laneByRelease.get(span.releaseId) : undefined);
        if (lane) perLane.set(lane, [...(perLane.get(lane) ?? []), range]);
      }
    }
    if (!groupRanges.length) continue;

    const newestFirst = [...workScopes].sort((a, b) => timestamp(b.updatedAt) - timestamp(a.updatedAt));
    const merged = mergeTimelineRanges(groupRanges);
    group.watched = {
      ranges: merged,
      coverage: rangeCoverage(merged),
      playhead: playheadFraction(newestFirst[0], durationTicks),
      durationTicks,
    };
    for (const [lane, ranges] of perLane) {
      const laneMerged = mergeTimelineRanges(ranges);
      const laneScope = newestFirst.find((scope) =>
        (scope.lastSessionToken != null && laneByToken.get(scope.lastSessionToken) === lane)
        || (scope.lastReleaseId != null && laneByRelease.get(scope.lastReleaseId) === lane));
      lane.watched = {
        ranges: laneMerged,
        coverage: rangeCoverage(laneMerged),
        playhead: laneScope ? playheadFraction(laneScope, durationTicks) : undefined,
        durationTicks,
      };
    }
  }
}

/** Watched sections attributed to one stream token — the detail console's view. */
export function watchProgressForToken(
  scopes: PlaybackRangeResponse[],
  token: string,
  releaseId?: string,
): WatchProgress | undefined {
  const ranges: TimelineRange[] = [];
  let durationTicks = 0;
  let playhead: number | undefined;
  let newestAt = -1;
  for (const scope of scopes) {
    const scopeDuration = scope.durationTicks ?? 0;
    if (scopeDuration <= 0) continue;
    const spans = (scope.ranges ?? []).filter((span) =>
      span.sessionToken === token || (!span.sessionToken && releaseId != null && span.releaseId === releaseId));
    if (!spans.length) continue;
    durationTicks = Math.max(durationTicks, scopeDuration);
    for (const span of spans) {
      const range = toFractionRange(span.startTicks ?? 0, span.endTicks ?? 0, scopeDuration);
      if (range) ranges.push(range);
    }
    const at = timestamp(scope.updatedAt);
    if (scope.lastSessionToken === token && at > newestAt) {
      newestAt = at;
      playhead = playheadFraction(scope, scopeDuration);
    }
  }
  if (!ranges.length) return undefined;
  const merged = mergeTimelineRanges(ranges);
  return { ranges: merged, coverage: rangeCoverage(merged), playhead, durationTicks };
}

/** Buffered payload intervals (byte-fraction ≈ timeline-fraction) for a live attempt. */
export function laneBufferedRanges(attempt: StreamAttempt): TimelineRange[] {
  return (attempt.live?.bufferedRanges ?? [])
    .map((range) => ({ start: range.start ?? 0, end: range.end ?? 0 }))
    .filter((range) => range.end > range.start);
}

function toFractionRange(startTicks: number, endTicks: number, durationTicks: number): TimelineRange | undefined {
  if (durationTicks <= 0 || endTicks <= startTicks) return undefined;
  return {
    start: Math.max(0, Math.min(1, startTicks / durationTicks)),
    end: Math.max(0, Math.min(1, endTicks / durationTicks)),
  };
}

function playheadFraction(scope: PlaybackRangeResponse | undefined, durationTicks: number): number | undefined {
  if (!scope || durationTicks <= 0) return undefined;
  const position = scope.positionTicks ?? 0;
  return position > 0 ? Math.max(0, Math.min(1, position / durationTicks)) : undefined;
}

/** Attempts on the same release collapse into one lane; the newest attempt drives the lane. */
export function collapseIntoLanes(attempts: StreamAttempt[]): ReleaseLane[] {
  const lanes = new Map<string, StreamAttempt[]>();
  for (const attempt of attempts) {
    const key = attempt.releaseId || `title:${attempt.title}`;
    lanes.set(key, [...(lanes.get(key) ?? []), attempt]);
  }
  return [...lanes.entries()]
    .map(([key, laneAttempts]) => {
      // A live session IS the lane's current reality, even when a newer bookkeeping record
      // (e.g. a "reused" resolve that re-attached to it) exists for the same release.
      const latest = laneAttempts.find((attempt) => attempt.isLive) ?? laneAttempts[0];
      const ordered = [latest, ...laneAttempts.filter((attempt) => attempt !== latest)];
      const { phase, detail } = derivePhase(latest);
      return {
        key,
        releaseId: latest.releaseId,
        workId: latest.workId,
        title: latest.title,
        fileName: latest.fileName,
        container: latest.container,
        requestedTitle: latest.requestedTitle,
        requestedReleaseId: latest.requestedReleaseId,
        attempts: ordered,
        latest,
        phase,
        phaseDetail: detail,
        failureModes: deriveFailureModes(latest),
        updatedAt: Math.max(...laneAttempts.map((attempt) => timestamp(attempt.createdAt))),
      } satisfies ReleaseLane;
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** The single "last state" statement per lane, in priority order. */
export function derivePhase(attempt: StreamAttempt): { phase: LanePhase; detail?: string } {
  if (attempt.isFailed) return { phase: "failed", detail: attempt.failureKind };
  if (attempt.isLive) {
    if (attempt.live?.isStreaming || attempt.file?.isStreaming) return { phase: "playing" };
    if (attempt.diskState === "downloading") return { phase: "pre-downloading" };
    if ((attempt.live?.activeArticles ?? 0) > 0 || (attempt.live?.nntpConnectionsInFlight ?? 0) > 0) {
      return { phase: "downloading" };
    }
    return { phase: "idle", detail: "capability retained" };
  }
  const state = attempt.state.toLowerCase();
  return {
    phase: "completed",
    detail: COMPLETED_STATES.has(state) || state === "playback" ? attempt.state : undefined,
  };
}

/** Typical failure modes, surfaced as badges directly on the lane. */
export function deriveFailureModes(attempt: StreamAttempt): FailureMode[] {
  const modes: FailureMode[] = [];
  const kind = (attempt.failureKind ?? "").toLowerCase();
  const reason = attempt.failureReason ?? "";
  const live = attempt.live;

  const missingLive = live?.missingArticles ?? 0;
  const failedLive = live?.failedArticles ?? 0;
  if (missingLive > 0 || failedLive > 0) {
    modes.push({
      kind: "missing-articles",
      severity: "bad",
      label: missingLive > 0 ? `Missing articles (${missingLive})` : `Failed articles (${failedLive})`,
      detail: missingLive > 0 && failedLive > missingLive
        ? `${failedLive} failed in total`
        : undefined,
    });
  } else if (kind.includes("article") || kind === "invalidated" || /article|yenc/i.test(reason)) {
    modes.push({ kind: "missing-articles", severity: "bad", label: "Missing articles" });
  }

  if (kind.includes("repair") || /repair|parity|recovery block/i.test(reason)) {
    modes.push({
      kind: "repair",
      severity: attempt.isFailed ? "bad" : "info",
      label: attempt.isFailed ? "Repair failed" : "Repair involved",
    });
  }

  const throughput = laneThroughput(attempt);
  if (throughput && throughput.ratio != null && throughput.ratio < 1) {
    modes.push({
      kind: "provider-slow",
      severity: "warn",
      label: "Provider too slow",
      detail: `${formatRate(throughput.downloadBps!)} of ${formatRate(throughput.requiredBps!)} needed`,
    });
  }

  if (attempt.requestedReleaseId || attempt.requestedTitle) {
    modes.push({ kind: "fallback", severity: "info", label: "Fallback release" });
  }

  return modes;
}

/**
 * Live required-vs-actual byte rates. `ratio` compares them only while articles are actively
 * downloading — a fully cached playback legitimately downloads nothing.
 */
export function laneThroughput(attempt: StreamAttempt): {
  downloadBps: number | null;
  requiredBps: number | null;
  ratio: number | null;
} | null {
  const live = attempt.live;
  if (!live) return null;
  const downloadBps = live.downloadBytesPerSecond ?? null;
  const requiredBps = live.requiredBytesPerSecond ?? null;
  const activelyDownloading = (live.activeArticles ?? 0) > 0;
  const ratio = activelyDownloading && requiredBps != null && requiredBps > 0
    ? (downloadBps ?? 0) / requiredBps
    : null;
  if (downloadBps == null && requiredBps == null) return null;
  return { downloadBps, requiredBps, ratio };
}

function normalizeAttempt(seed: AttemptSeed): StreamAttempt {
  const { live, file, record, visits } = seed;
  const latestVisit = [...visits].sort((a, b) => timestamp(b.updatedAt) - timestamp(a.updatedAt))[0];
  const requestedTitle = clean(record?.title);
  const requestedReleaseId = clean(record?.releaseId);
  const title = clean(record?.resolvedTitle)
    || clean(file?.title)
    || clean(live?.title)
    || requestedTitle
    || clean(latestVisit?.title)
    || "Release name unavailable";
  const releaseId = clean(record?.resolvedReleaseId)
    || clean(live?.releaseId)
    || clean(file?.releaseId)
    || requestedReleaseId
    || clean(latestVisit?.releaseId);
  const workId = clean(live?.workId) || clean(file?.workId) || clean(record?.workId) || clean(latestVisit?.workId);
  const rawState = clean(live?.state) || clean(file?.state) || clean(record?.finalState) || (latestVisit?.state === "stop" ? "closed" : "playback");
  const preDownloadState = clean(file?.preDownloadState) || clean(live?.preDownloadState);
  const explicitFailureReason = clean(record?.failureReason);
  const closeReason = clean(record?.closeReason);
  const failureKind = clean(record?.failureKind)
    || (FAILURE_STATES.has(rawState.toLowerCase()) ? rawState : undefined)
    || ((preDownloadState ?? "").toLowerCase() === "failed" ? "pre-download failed" : undefined)
    || (explicitFailureReason || looksLikeFailure(closeReason) ? "stream failed" : undefined);
  const failureReason = explicitFailureReason
    || (failureKind ? closeReason : undefined)
    || (failureKind === "invalidated" ? "Release became unavailable while streaming." : undefined);
  const sizeBytes = live?.sizeBytes ?? file?.sizeBytes ?? record?.sizeBytes ?? 0;
  const bytesServed = live?.bytesServed ?? file?.bytesServed ?? record?.bytesServed ?? 0;
  const diskPercent = hasDiskProgress(live, file)
    ? clamp(file?.preDownloadPercent ?? live?.preDownloadPercent ?? 0)
    : undefined;
  const createdAt = clean(live?.createdAt) || clean(file?.createdAt) || clean(record?.createdAt) || clean(latestVisit?.startedAt);
  const isLive = Boolean(live);
  const isFailed = Boolean(failureKind);

  return {
    key: seed.key,
    token: seed.token,
    workId,
    title,
    releaseId,
    fileName: clean(file?.fileName),
    container: clean(live?.container) || clean(file?.container) || clean(record?.container),
    requestedTitle: requestedTitle && requestedTitle !== title ? requestedTitle : undefined,
    requestedReleaseId: requestedReleaseId && requestedReleaseId !== releaseId ? requestedReleaseId : undefined,
    state: rawState || "unknown",
    isLive,
    isFailed,
    isCompleted: !isLive && !isFailed && (COMPLETED_STATES.has(rawState.toLowerCase()) || latestVisit?.state === "stop"),
    failureKind,
    failureReason,
    requester: clean(live?.requestedByName) || clean(file?.requestedByName) || clean(record?.requestedByName) || clean(latestVisit?.userName) || clean(live?.requestedById) || clean(file?.requestedById) || clean(record?.requestedById) || clean(latestVisit?.userId) || "Unknown requester",
    source: clean(live?.client) || clean(file?.client) || clean(record?.client) || clean(latestVisit?.source) || "unknown",
    device: clean(latestVisit?.device),
    createdAt,
    bytesServed,
    sizeBytes,
    payloadPercent: percent(bytesServed, sizeBytes),
    diskPercent,
    diskState: preDownloadState || (file?.localCacheReady || live?.localCacheReady ? "completed" : undefined),
    retentionPriority: clean(file?.retentionPriority) || clean(live?.retentionPriority),
    purgeAt: clean(file?.purgeAt),
    playbackPositionTicks: visits.length ? Math.max(...visits.map((visit) => visit.positionTicks)) : undefined,
    playbackDurationTicks: visits.length ? Math.max(...visits.map((visit) => visit.durationTicks)) : undefined,
    visits,
    live,
    file,
    record,
  };
}

export function aggregatePlaybackEvents(events: StreamingHistoryResponse[]): PlaybackVisit[] {
  const grouped = new Map<string, StreamingHistoryResponse[]>();
  for (const event of events) {
    const key = event.playbackSessionId
      ? `playback:${event.playbackSessionId}`
      : event.sessionToken
        ? `token:${event.sessionToken}:${event.source ?? "unknown"}:${event.externalUserId ?? "unknown"}`
        : `event:${event.id ?? event.receivedAt ?? grouped.size}`;
    grouped.set(key, [...(grouped.get(key) ?? []), event]);
  }

  return [...grouped.entries()].map(([key, entries]) => {
    const ordered = [...entries].sort((a, b) => timestamp(a.receivedAt) - timestamp(b.receivedAt));
    const first = ordered[0];
    const last = ordered.at(-1)!;
    return {
      key,
      sessionToken: clean(last.sessionToken),
      releaseId: clean(last.releaseId),
      workId: clean(last.workId),
      title: clean(last.title),
      source: clean(last.source),
      userId: clean(last.externalUserId),
      userName: clean(last.externalUserName),
      device: clean(last.deviceName),
      startedAt: clean(first.receivedAt),
      updatedAt: clean(last.receivedAt),
      positionTicks: Math.max(...ordered.map((event) => event.positionTicks ?? 0)),
      durationTicks: Math.max(...ordered.map((event) => event.durationTicks ?? 0)),
      state: clean(last.event) || "progress",
      eventCount: ordered.length,
    };
  });
}

export function filterGroups(groups: WorkGroup[], filter: string, status: StatusFilter): WorkGroup[] {
  const needle = filter.trim().toLocaleLowerCase();
  return groups.flatMap((group) => {
    const groupMatches = !needle || [group.title, group.workId, group.requester, group.device]
      .some((value) => value?.toLocaleLowerCase().includes(needle));
    const lanes = group.lanes.filter((lane) => {
      const statusMatches = status === "all"
        || (status === "live" && lane.latest.isLive)
        || (status === "failed" && lane.attempts.some((attempt) => attempt.isFailed))
        || (status === "completed" && lane.latest.isCompleted);
      const textMatches = groupMatches || [
        lane.title,
        lane.requestedTitle,
        lane.releaseId,
        lane.requestedReleaseId,
        lane.workId,
        lane.latest.requester,
        lane.latest.device,
      ].some((value) => value?.toLocaleLowerCase().includes(needle));
      return statusMatches && textMatches;
    });
    const unmatchedVisits = status === "failed" || status === "live"
      ? []
      : group.unmatchedVisits.filter((visit) => groupMatches || [visit.title, visit.releaseId, visit.userName, visit.userId, visit.device].some((value) => value?.toLocaleLowerCase().includes(needle)));
    return lanes.length || unmatchedVisits.length ? [{ ...group, lanes, unmatchedVisits }] : [];
  });
}

export interface TransferCounterSample {
  bytes: number;
  at: number;
}

export function transferRateBetween(previous: TransferCounterSample, current: TransferCounterSample): number | null {
  const elapsedMilliseconds = current.at - previous.at;
  const byteDelta = current.bytes - previous.bytes;
  if (elapsedMilliseconds <= 0 || elapsedMilliseconds > 15_000 || byteDelta < 0) return null;
  return byteDelta / (elapsedMilliseconds / 1_000);
}

function hasDiskProgress(live?: SessionResponse, file?: EphemeralFileResponse) {
  return Boolean(
    file?.preDownloadJobId
      || live?.preDownloadJobId
      || file?.preDownloadState
      || live?.preDownloadState
      || file?.localCacheReady
      || live?.localCacheReady
      || (file?.preDownloadTotalBytes ?? live?.preDownloadTotalBytes ?? 0) > 0,
  );
}

function firstKnown(values: Array<string | undefined>, unknown: string) {
  return values.find((value) => value && value !== unknown) ?? values.find(Boolean);
}

export function clean(value?: string | null) {
  const result = value?.trim();
  return result || undefined;
}

export function timestamp(value?: string | null) {
  const result = Date.parse(value ?? "");
  return Number.isFinite(result) ? result : 0;
}

export function percent(value: number, total: number) {
  return total > 0 ? clamp(value * 100 / total) : 0;
}

export function clamp(value: number) {
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
}

export function formatPercent(value: number) {
  return `${value.toFixed(value > 0 && value < 10 ? 1 : 0)}%`;
}

export function formatRate(bytesPerSecond: number) {
  return `${formatBytes(Math.max(0, bytesPerSecond))}/s`;
}

/** Bits-per-second view of a byte rate, the unit operators reason about for stream health. */
export function formatMbps(bytesPerSecond: number) {
  const mbps = bytesPerSecond * 8 / 1_000_000;
  return `${mbps.toFixed(mbps > 0 && mbps < 10 ? 1 : 0)} Mbit/s`;
}

function looksLikeFailure(value?: string) {
  return Boolean(value && /(fail|error|invalid|missing|article|repair|corrupt|unavailable)/i.test(value));
}

export function humanize(value: string) {
  return value.replace(/[-_]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (character) => character.toUpperCase());
}
