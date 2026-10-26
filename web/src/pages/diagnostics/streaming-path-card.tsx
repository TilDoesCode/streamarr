import { useEffect, useState } from "react";
import { AlertTriangle, Cloud, Gauge, Loader2, Monitor, Route, Server, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useRunUsenetSpeedTest, useUsenetSpeedTest } from "@/api/queries";
import { ApiError, errorMessage } from "@/api/client";
import type { UsenetSpeedProviderDto, UsenetSpeedTestResponse } from "@/api/types";
import { cn, timeAgo } from "@/lib/utils";
import {
  formatMbit,
  streamingPathVerdict,
  usenetCodeLabel,
  usenetProviderLabel,
} from "@/lib/streaming-path";
import type { BrowserSpeedTest } from "./speed-test-card";

export const USENET_BUSY_CODE = "usenet_speedtest_no_free_connections";

export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** Usenet → Server → This browser: both measured legs and what the slower one lets play smoothly. */
export function StreamingPathCard({ browser }: { browser: BrowserSpeedTest }) {
  const state = useUsenetSpeedTest();
  const run = useRunUsenetSpeedTest();
  const [sequence, setSequence] = useState(false);
  const now = useNow(1_000);

  const latest = state.data?.latest ?? null;
  const usenetRunning = run.isPending || !!state.data?.running;
  const busy = usenetRunning || browser.running || sequence;
  const allowed = state.data?.allowed ?? true;
  const usenetMbps = latest?.status === "ok" ? latest.megabitsPerSecond : null;
  const verdict = streamingPathVerdict(usenetMbps, browser.stored?.downloadMbps);

  async function testUsenet() {
    try {
      await run.mutateAsync();
    } catch {
      // shown from run.error
    }
  }

  async function measureAll() {
    setSequence(true);
    try {
      // Sequential, so neither measurement competes with the other for bandwidth.
      await testUsenet();
      await browser.start();
    } finally {
      setSequence(false);
    }
  }

  return (
    <Card data-testid="streaming-path-card">
      <CardHeader className="flex-row flex-wrap items-start justify-between gap-4 space-y-0">
        <div className="space-y-1.5">
          <CardTitle className="flex items-center gap-2 text-base">
            <Route className="size-4" />
            Streaming path
          </CardTitle>
          <CardDescription>
            Playback is limited by the slower leg: Usenet → this server, then this server → this browser.
          </CardDescription>
        </div>
        <Button onClick={() => void measureAll()} disabled={busy || !allowed}>
          {sequence ? <Loader2 className="animate-spin" /> : <Gauge />}
          Measure all
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid items-stretch gap-3 md:grid-cols-[auto_minmax(0,1fr)_auto_minmax(0,1fr)_auto]">
          <Stop icon={<Cloud className="size-4" />} label="Usenet" />
          <LegPanel
            title="Usenet → Server"
            testId="streaming-path-usenet"
            bottleneck={verdict.bottleneck === "usenet"}
            action={
              <Button size="sm" variant="outline" onClick={() => void testUsenet()} disabled={busy || !allowed}>
                Test Usenet
              </Button>
            }
          >
            <UsenetLeg latest={latest} running={usenetRunning} error={run.error} loadError={state.error} now={now} />
          </LegPanel>
          <Stop icon={<Server className="size-4" />} label="Server" />
          <LegPanel
            title="Server → This browser"
            testId="streaming-path-browser"
            bottleneck={verdict.bottleneck === "browser"}
            action={
              <Button size="sm" variant="outline" onClick={() => void browser.start()} disabled={busy}>
                Test browser
              </Button>
            }
          >
            <BrowserLeg browser={browser} waiting={sequence && !browser.running && usenetRunning} now={now} />
          </LegPanel>
          <Stop icon={<Monitor className="size-4" />} label="This browser" />
        </div>

        <p
          className={cn(
            "rounded-md border bg-muted/20 px-4 py-3 text-sm font-medium",
            verdict.limitMbps == null && "text-muted-foreground",
          )}
          data-testid="streaming-path-verdict"
          data-bottleneck={verdict.bottleneck ?? undefined}
        >
          {verdict.text}
        </p>
        <p className="text-xs text-muted-foreground">
          Assumed bitrates: 4K remux ≈ 80 Mbit/s, 4K WEB ≈ 25, 1080p ≈ 10, 720p ≈ 5; each needs 1.3× that
          for bitrate peaks. Usenet results are shared by everyone for 2 minutes.
        </p>
      </CardContent>
    </Card>
  );
}

function Stop({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <div className="flex items-center justify-center gap-2 md:flex-col md:justify-center md:px-1">
      <span className="flex size-9 items-center justify-center rounded-full border bg-muted/40 text-foreground">
        {icon}
      </span>
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
    </div>
  );
}

function LegPanel({
  title,
  testId,
  bottleneck,
  action,
  children,
}: {
  title: string;
  testId: string;
  bottleneck: boolean;
  action: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section
      aria-label={title}
      data-testid={testId}
      className={cn(
        "flex min-w-0 flex-col gap-2 rounded-md border p-3",
        bottleneck ? "border-amber-500/40 bg-amber-500/10" : "bg-background",
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium uppercase text-muted-foreground">{title}</span>
        {bottleneck && (
          <Badge className="border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-300">Bottleneck</Badge>
        )}
        <span className="ml-auto">{action}</span>
      </div>
      {children}
    </section>
  );
}

function Running({ text }: { text: string }) {
  return (
    <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
      <Loader2 className="size-4 animate-spin" />
      {text}
    </p>
  );
}

function Value({ mbps }: { mbps: number }) {
  return <p className="text-2xl font-semibold tabular-nums">{formatMbit(mbps)}</p>;
}

function roleLabel(provider: UsenetSpeedProviderDto): string {
  return provider.role === "primary" ? "Primary" : `Backup #${provider.index}`;
}

function failureText(provider: UsenetSpeedProviderDto): string {
  return `${provider.code ?? "error"}${provider.error ? `: ${provider.error}` : ""}`;
}

function UsenetLeg({
  latest,
  running,
  error,
  loadError,
  now,
}: {
  latest: UsenetSpeedTestResponse | null;
  running: boolean;
  error: Error | null;
  loadError: Error | null;
  now: number;
}) {
  const busyError = error instanceof ApiError && error.code === USENET_BUSY_CODE;
  const notes: React.ReactNode[] = [];
  if (latest?.status === "ok" && latest.fallbackUsed) {
    const failed = (latest.attempts ?? []).filter((attempt) => attempt.code !== "ok");
    if (failed.length > 0) {
      notes.push(
        <span key="fallback">
          {failed.map((attempt) => `${roleLabel(attempt)} failed (${failureText(attempt)})`).join("; ")} — measured the
          backup
        </span>,
      );
    }
  }
  if (latest?.status === "ok" && (latest.activeStreams ?? 0) > 0) {
    const n = latest.activeStreams ?? 0;
    notes.push(
      <span key="streams">
        Measured while {n} stream{n === 1 ? " was" : "s were"} playing — a lower bound
      </span>,
    );
  }

  return (
    <div className="space-y-1.5 text-sm">
      {running && <Running text="Measuring Usenet… up to ~20 s" />}
      {busyError ? (
        <p className="flex items-start gap-2 text-amber-700 dark:text-amber-300" role="alert" data-testid="usenet-busy">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          All provider connections are busy with streams — try again when fewer streams are playing.
        </p>
      ) : (
        error && (
          <p className="flex items-start gap-2 text-destructive" role="alert">
            <XCircle className="mt-0.5 size-4 shrink-0" />
            {errorMessage(error)}
          </p>
        )
      )}

      {!latest ? (
        !running && (
          <p className="text-muted-foreground">
            {loadError ? `Could not load the last result: ${errorMessage(loadError)}` : "Not measured yet."}
          </p>
        )
      ) : latest.status === "ok" && latest.megabitsPerSecond != null ? (
        <>
          <Value mbps={latest.megabitsPerSecond} />
          <p className="text-xs text-muted-foreground">
            measured {timeAgo(latest.measuredAt, now)}
            {latest.provider && <> · {usenetProviderLabel(latest.provider)}</>}
          </p>
        </>
      ) : (
        <div className="space-y-1" data-testid="usenet-failed">
          <p className="font-medium text-destructive">
            Failed: {usenetCodeLabel(latest.code)}
            {latest.code && <span className="font-mono text-xs font-normal"> ({latest.code})</span>}
          </p>
          {(latest.attempts ?? []).length > 0 ? (
            <ul className="space-y-0.5 text-xs text-muted-foreground">
              {(latest.attempts ?? []).map((attempt) => (
                <li key={attempt.index} className="break-words">
                  {usenetProviderLabel(attempt)}: <span className="font-mono">{failureText(attempt)}</span>
                </li>
              ))}
            </ul>
          ) : (
            latest.provider?.error && <p className="break-words font-mono text-xs text-muted-foreground">{latest.provider.error}</p>
          )}
          <p className="text-xs text-muted-foreground">measured {timeAgo(latest.measuredAt, now)}</p>
        </div>
      )}

      {latest && (latest.connectionsMax ?? 0) > 0 && (
        <p className="text-xs text-muted-foreground tabular-nums">
          {latest.connectionsUsed ?? 0}/{latest.connectionsMax} connections used
        </p>
      )}
      {notes.length > 0 && (
        <ul className="space-y-0.5 text-xs text-amber-700 dark:text-amber-300" data-testid="usenet-notes">
          {notes.map((note, index) => (
            <li key={index}>{note}</li>
          ))}
        </ul>
      )}
      {latest?.reused && (
        <p className="text-xs text-muted-foreground">
          Recent shared result from {new Date(latest.measuredAt).toLocaleTimeString()} (tests are shared for 2 minutes)
        </p>
      )}
      {latest?.joined && !latest.reused && (
        <p className="text-xs text-muted-foreground">Joined a test that was already running.</p>
      )}
    </div>
  );
}

function BrowserLeg({ browser, waiting, now }: { browser: BrowserSpeedTest; waiting: boolean; now: number }) {
  const { stored, progress } = browser;
  const live = progress?.downloadMbps ?? (progress?.phase === "download" ? progress.liveMbps : undefined);
  return (
    <div className="space-y-1.5 text-sm">
      {browser.running && (
        <Running text={live != null ? `Measuring this browser… ${formatMbit(live)}` : "Measuring this browser… about 20 s"} />
      )}
      {waiting && <p className="text-muted-foreground">Runs after the Usenet test.</p>}
      {browser.error && !browser.running && (
        <p className="flex items-start gap-2 text-destructive" role="alert">
          <XCircle className="mt-0.5 size-4 shrink-0" />
          {browser.error}
        </p>
      )}
      {stored ? (
        <>
          <Value mbps={stored.downloadMbps} />
          <p className="text-xs text-muted-foreground">
            download · measured {timeAgo(stored.measuredAt, now)}
            {stored.uploadMbps != null && <> · upload {formatMbit(stored.uploadMbps)}</>}
            {stored.pingMs != null && <> · ping {Math.round(stored.pingMs)} ms</>}
          </p>
        </>
      ) : (
        !browser.running && <p className="text-muted-foreground">Not measured yet.</p>
      )}
    </div>
  );
}
