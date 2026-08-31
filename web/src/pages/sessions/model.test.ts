import { describe, expect, it } from "vitest";
import type { PlaybackRangeResponse, SessionResponse, StreamRecordSummaryResponse } from "@/api/types";
import {
  buildWorkGroups,
  collapseIntoLanes,
  derivePhase,
  deriveFailureModes,
  laneThroughput,
  transferRateBetween,
  watchProgressForToken,
  type StreamAttempt,
} from "./model";

const now = Date.now();

function ago(milliseconds: number) {
  return new Date(now - milliseconds).toISOString();
}

function session(overrides: Partial<SessionResponse>): SessionResponse {
  return {
    token: "tok",
    releaseId: "rel",
    workId: "work",
    title: "Release",
    fileName: "release.mkv",
    state: "ready",
    container: "mkv",
    sizeBytes: 1_000_000,
    bytesServed: 0,
    isStreaming: false,
    runTimeTicks: null,
    requiredBytesPerSecond: null,
    downloadBytesPerSecond: null,
    failedArticles: 0,
    missingArticles: 0,
    activeArticles: 0,
    nntpConnectionsInFlight: 0,
    nntpCommandsTotal: 0,
    client: "jellyfin",
    requestedById: "user-1",
    requestedByName: "Mara",
    createdAt: ago(60_000),
    lastAccessedAt: ago(1_000),
    expiresAt: new Date(now + 3_600_000).toISOString(),
    retentionPriority: "normal",
    preDownloadJobId: null,
    preDownloadKind: null,
    preDownloadReason: null,
    preDownloadSourceToken: null,
    preDownloadState: null,
    preDownloadedBytes: 0,
    preDownloadTotalBytes: 0,
    preDownloadPercent: 0,
    localCacheReady: false,
    timelineStartedAt: null,
    timeline: [],
    ...overrides,
  } as SessionResponse;
}

function record(overrides: Partial<StreamRecordSummaryResponse>): StreamRecordSummaryResponse {
  return {
    token: "attempt",
    releaseId: "rel",
    workId: "work",
    title: "Release",
    resolvedReleaseId: null,
    resolvedTitle: null,
    container: null,
    sizeBytes: 1_000_000,
    bytesServed: 0,
    nntpCommandsTotal: 0,
    client: "jellyfin",
    requestedById: "user-1",
    requestedByName: "Mara",
    createdAt: ago(120_000),
    closedAt: null,
    finalState: null,
    closeReason: null,
    failureKind: null,
    failureReason: null,
    ...overrides,
  } as StreamRecordSummaryResponse;
}

function attemptOf(groups: ReturnType<typeof buildWorkGroups>): StreamAttempt {
  return groups[0].lanes[0].latest;
}

describe("release lanes", () => {
  it("collapses repeated attempts on the same release into one lane, newest first", () => {
    const groups = buildWorkGroups(
      [],
      [],
      [
        record({ token: "a1", createdAt: ago(10 * 60_000), finalState: "error", failureKind: "resolve", failureReason: "first failure" }),
        record({ token: "a2", createdAt: ago(5 * 60_000), finalState: "error", failureKind: "resolve", failureReason: "second failure" }),
        record({ token: "a3", createdAt: ago(60_000), finalState: "closed", closeReason: "client done" }),
      ],
      [],
    );

    expect(groups).toHaveLength(1);
    expect(groups[0].lanes).toHaveLength(1);
    const lane = groups[0].lanes[0];
    expect(lane.attempts).toHaveLength(3);
    expect(lane.latest.token).toBe("a3");
    expect(lane.phase).toBe("completed");
    expect(lane.attempts[2].failureReason).toBe("first failure");
  });

  it("lets a live session drive the lane even when a newer reused record exists", () => {
    const groups = buildWorkGroups(
      [session({ token: "tok-live", isStreaming: true, createdAt: ago(20 * 60_000) })],
      [],
      [record({ token: "attempt-reused", createdAt: ago(30_000), finalState: "reused", closeReason: "attempt reused an existing capability" })],
      [],
    );

    expect(groups[0].lanes).toHaveLength(1);
    const lane = groups[0].lanes[0];
    expect(lane.latest.token).toBe("tok-live");
    expect(lane.phase).toBe("playing");
    expect(lane.attempts[1].token).toBe("attempt-reused");
  });

  it("keeps different releases of the same work as separate lanes", () => {
    const groups = buildWorkGroups(
      [],
      [],
      [
        record({ token: "a1", releaseId: "rel-a", title: "Release A", createdAt: ago(60_000) }),
        record({ token: "a2", releaseId: "rel-b", title: "Release B", createdAt: ago(30_000), finalState: "failed", failureKind: "article" }),
      ],
      [],
    );

    expect(groups).toHaveLength(1);
    expect(groups[0].lanes).toHaveLength(2);
    expect(groups[0].lanes[0].releaseId).toBe("rel-b");
    expect(groups[0].lanes[0].phase).toBe("failed");
    expect(groups[0].lanes[1].releaseId).toBe("rel-a");
  });
});

describe("phase derivation", () => {
  it("prefers failed over everything", () => {
    const groups = buildWorkGroups(
      [session({ isStreaming: true })],
      [],
      [record({ token: "tok", finalState: "failed", failureKind: "repair", failureReason: "parity exhausted" })],
      [],
    );
    expect(derivePhase(attemptOf(groups)).phase).toBe("failed");
  });

  it("reports playing while an HTTP stream is open", () => {
    const groups = buildWorkGroups([session({ isStreaming: true, activeArticles: 4 })], [], [], []);
    expect(derivePhase(attemptOf(groups)).phase).toBe("playing");
  });

  it("reports pre-downloading, then downloading, then idle", () => {
    const preDownloading = buildWorkGroups(
      [session({ preDownloadState: "downloading", preDownloadJobId: "job", preDownloadTotalBytes: 10, preDownloadPercent: 10 })],
      [], [], [],
    );
    expect(derivePhase(attemptOf(preDownloading)).phase).toBe("pre-downloading");

    const downloading = buildWorkGroups([session({ activeArticles: 2, nntpConnectionsInFlight: 2 })], [], [], []);
    expect(derivePhase(attemptOf(downloading)).phase).toBe("downloading");

    const idle = buildWorkGroups([session({})], [], [], []);
    expect(derivePhase(attemptOf(idle)).phase).toBe("idle");
  });

  it("reports terminal states as completed with the state as detail", () => {
    const groups = buildWorkGroups([], [], [record({ finalState: "evicted", closeReason: "ephemeral-cache byte budget" })], []);
    const { phase, detail } = derivePhase(attemptOf(groups));
    expect(phase).toBe("completed");
    expect(detail).toBe("evicted");
  });
});

describe("failure modes", () => {
  it("flags live missing articles with the count", () => {
    const groups = buildWorkGroups([session({ missingArticles: 214, failedArticles: 230 })], [], [], []);
    const modes = deriveFailureModes(attemptOf(groups));
    expect(modes.some((mode) => mode.kind === "missing-articles" && mode.label.includes("214"))).toBe(true);
  });

  it("flags historical article failures from the failure kind", () => {
    const groups = buildWorkGroups([], [], [record({ finalState: "invalidated", failureKind: "article", failureReason: "Release became unavailable while streaming." })], []);
    const modes = deriveFailureModes(attemptOf(groups));
    expect(modes.some((mode) => mode.kind === "missing-articles")).toBe(true);
  });

  it("flags a too-slow provider only while articles are actively downloading", () => {
    const slow = buildWorkGroups(
      [session({ activeArticles: 5, downloadBytesPerSecond: 375_000, requiredBytesPerSecond: 2_500_000 })],
      [], [], [],
    );
    const slowModes = deriveFailureModes(attemptOf(slow));
    const slowMode = slowModes.find((mode) => mode.kind === "provider-slow");
    expect(slowMode).toBeDefined();
    expect(slowMode!.detail).toContain("needed");

    const cachedPlayback = buildWorkGroups(
      [session({ activeArticles: 0, downloadBytesPerSecond: null, requiredBytesPerSecond: 2_500_000, isStreaming: true })],
      [], [], [],
    );
    expect(deriveFailureModes(attemptOf(cachedPlayback)).some((mode) => mode.kind === "provider-slow")).toBe(false);
  });

  it("flags repair outcomes and fallback resolves", () => {
    const groups = buildWorkGroups(
      [],
      [],
      [record({
        releaseId: "rel-requested",
        title: "Requested Release",
        resolvedReleaseId: "rel-actual",
        resolvedTitle: "Actual Release",
        finalState: "failed",
        failureKind: "repair",
        failureReason: "Parity reconstruction exhausted the available recovery blocks.",
      })],
      [],
    );
    const modes = deriveFailureModes(attemptOf(groups));
    expect(modes.some((mode) => mode.kind === "repair" && mode.severity === "bad")).toBe(true);
    expect(modes.some((mode) => mode.kind === "fallback")).toBe(true);
  });
});

describe("lane throughput", () => {
  it("exposes required vs actual rates and a ratio while downloading", () => {
    const groups = buildWorkGroups(
      [session({ activeArticles: 1, downloadBytesPerSecond: 5_000_000, requiredBytesPerSecond: 2_000_000 })],
      [], [], [],
    );
    const throughput = laneThroughput(attemptOf(groups));
    expect(throughput).not.toBeNull();
    expect(throughput!.ratio).toBeCloseTo(2.5);
  });

  it("suppresses the ratio when nothing is downloading", () => {
    const groups = buildWorkGroups(
      [session({ activeArticles: 0, downloadBytesPerSecond: null, requiredBytesPerSecond: 2_000_000 })],
      [], [], [],
    );
    expect(laneThroughput(attemptOf(groups))!.ratio).toBeNull();
  });
});

describe("watched-time attribution", () => {
  const DURATION = 24_000_000_000; // 40 min in ticks

  function scope(overrides: Partial<PlaybackRangeResponse>): PlaybackRangeResponse {
    return {
      workId: "work",
      title: "Example Work",
      source: "jellyfin",
      playbackSessionId: "play-1",
      externalUserId: "user-1",
      externalUserName: "Mara",
      deviceName: "Living Room TV",
      durationTicks: DURATION,
      positionTicks: DURATION,
      lastSessionToken: "tok-b",
      lastReleaseId: "rel-b",
      startedAt: ago(60_000),
      updatedAt: ago(1_000),
      ranges: [],
      ...overrides,
    } as PlaybackRangeResponse;
  }

  it("unions the work bar and splits release lanes at the switch point", () => {
    const groups = buildWorkGroups(
      [session({ token: "tok-live" })],
      [],
      [record({ token: "tok-b", releaseId: "rel-b", title: "Other.Release-GRP", finalState: "invalidated", failureKind: "article" })],
      [],
      [scope({
        ranges: [
          // Entered at 50%, watched to 75% via the live release, then switched and finished.
          { startTicks: DURATION / 2, endTicks: DURATION * 0.75, sessionToken: "tok-live", releaseId: "rel" },
          { startTicks: DURATION * 0.75, endTicks: DURATION, sessionToken: "tok-b", releaseId: "rel-b" },
        ],
      })],
    );

    const group = groups[0];
    expect(group.watched).toBeDefined();
    // Adjacent spans union into one bar starting at 50% — the first half stays empty.
    expect(group.watched!.ranges).toEqual([{ start: 0.5, end: 1 }]);
    expect(group.watched!.coverage).toBeCloseTo(0.5);
    expect(group.watched!.playhead).toBeCloseTo(1);

    const liveLane = group.lanes.find((lane) => lane.releaseId === "rel")!;
    expect(liveLane.watched!.ranges).toEqual([{ start: 0.5, end: 0.75 }]);
    const otherLane = group.lanes.find((lane) => lane.releaseId === "rel-b")!;
    expect(otherLane.watched!.ranges).toEqual([{ start: 0.75, end: 1 }]);
    // The newest scope points at rel-b, so only that lane carries the playhead.
    expect(otherLane.watched!.playhead).toBeCloseTo(1);
    expect(liveLane.watched!.playhead).toBeUndefined();
  });

  it("attributes tokenless spans by release id and skips zero-duration scopes", () => {
    const groups = buildWorkGroups(
      [session({ token: "tok-live" })],
      [],
      [],
      [],
      [
        scope({
          lastSessionToken: null,
          lastReleaseId: "rel",
          ranges: [{ startTicks: 0, endTicks: DURATION / 4, sessionToken: null, releaseId: "rel" }],
        }),
        scope({ playbackSessionId: "play-broken", durationTicks: 0, ranges: [{ startTicks: 0, endTicks: 100, sessionToken: null, releaseId: "rel" }] }),
      ],
    );

    const lane = groups[0].lanes[0];
    expect(lane.watched!.ranges).toEqual([{ start: 0, end: 0.25 }]);
  });

  it("collects spans for one token across scopes for the detail console", () => {
    const scopes = [
      scope({
        ranges: [
          { startTicks: 0, endTicks: DURATION / 4, sessionToken: "tok-live", releaseId: "rel" },
          { startTicks: DURATION / 2, endTicks: DURATION * 0.6, sessionToken: "tok-other", releaseId: "rel-x" },
        ],
        lastSessionToken: "tok-live",
        positionTicks: DURATION / 4,
      }),
      scope({
        playbackSessionId: "play-2",
        updatedAt: ago(30_000),
        ranges: [{ startTicks: DURATION * 0.2, endTicks: DURATION * 0.3, sessionToken: "tok-live", releaseId: "rel" }],
      }),
    ];

    const progress = watchProgressForToken(scopes, "tok-live");
    expect(progress).toBeDefined();
    expect(progress!.ranges).toEqual([
      { start: 0, end: 0.3 },
    ]);
    expect(progress!.coverage).toBeCloseTo(0.3);
    expect(progress!.playhead).toBeCloseTo(0.25);
    expect(watchProgressForToken(scopes, "tok-unknown")).toBeUndefined();
  });
});

describe("collapseIntoLanes", () => {
  it("falls back to the title when no release id exists", () => {
    const base: StreamAttempt = {
      key: "k", title: "Same Title", state: "closed", isLive: false, isFailed: false, isCompleted: true,
      requester: "Unknown requester", source: "unknown", bytesServed: 0, sizeBytes: 0, payloadPercent: 0,
      visits: [], createdAt: ago(1_000),
    };
    const lanes = collapseIntoLanes([base, { ...base, key: "k2", createdAt: ago(2_000) }]);
    expect(lanes).toHaveLength(1);
    expect(lanes[0].attempts).toHaveLength(2);
  });
});

describe("transferRateBetween", () => {
  it("derives current output from consecutive monotonic counter samples", () => {
    expect(transferRateBetween({ bytes: 1_000, at: 2_000 }, { bytes: 5_000, at: 4_000 })).toBe(2_000);
    expect(transferRateBetween({ bytes: 5_000, at: 4_000 }, { bytes: 5_000, at: 6_000 })).toBe(0);
    expect(transferRateBetween({ bytes: 5_000, at: 6_000 }, { bytes: 200, at: 8_000 })).toBeNull();
    expect(transferRateBetween({ bytes: 200, at: 8_000 }, { bytes: 1_200, at: 30_000 })).toBeNull();
  });
});
