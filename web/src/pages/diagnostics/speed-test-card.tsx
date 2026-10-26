import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, CheckCircle2, Gauge, Loader2, Timer, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import {
  bestTier,
  browserClock,
  HEADROOM,
  isAbortError,
  DEFAULT_OPTIONS,
  runSpeedTest,
  tierVerdicts,
  type Clock,
  type SpeedTestOptions,
  type SpeedTestProgress,
  type SpeedTestResult,
  type SpeedTestTransport,
} from "@/lib/speedtest";
import { browserSpeedTestTransport } from "@/lib/speedtest-transport";
import { loadBrowserResult, saveBrowserResult, type StoredBrowserResult } from "@/lib/streaming-path";

const PHASE_LABEL: Record<string, string> = {
  ping: "Measuring ping…",
  download: "Measuring download…",
  upload: "Measuring upload…",
};

export interface BrowserSpeedTest {
  progress: SpeedTestProgress | null;
  result: SpeedTestResult | null;
  error: string | null;
  running: boolean;
  /** Last finished result, persisted in localStorage so it survives reloads. */
  stored: StoredBrowserResult | null;
  start(): Promise<SpeedTestResult | null>;
  cancel(): void;
}

export function useBrowserSpeedTest({
  transport = browserSpeedTestTransport,
  clock = browserClock,
  options = DEFAULT_OPTIONS,
}: {
  transport?: SpeedTestTransport;
  clock?: Clock;
  options?: SpeedTestOptions;
} = {}): BrowserSpeedTest {
  const [progress, setProgress] = useState<SpeedTestProgress | null>(null);
  const [result, setResult] = useState<SpeedTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [stored, setStored] = useState<StoredBrowserResult | null>(() => loadBrowserResult());
  const controller = useRef<AbortController | null>(null);

  useEffect(() => () => controller.current?.abort(), []);

  async function start(): Promise<SpeedTestResult | null> {
    const abort = new AbortController();
    controller.current = abort;
    setResult(null);
    setError(null);
    setProgress({ phase: "ping", phaseProgress: 0 });
    setRunning(true);
    try {
      const final = await runSpeedTest(transport, clock, abort.signal, setProgress, options);
      if (controller.current !== abort) return null;
      setResult(final);
      const entry: StoredBrowserResult = {
        downloadMbps: final.downloadMbps,
        uploadMbps: final.uploadMbps,
        pingMs: final.pingMs,
        measuredAt: new Date().toISOString(),
      };
      saveBrowserResult(entry);
      setStored(entry);
      return final;
    } catch (err) {
      if (controller.current !== abort) return null;
      setProgress(null);
      setError(isAbortError(err) ? "Speed test cancelled." : err instanceof Error ? err.message : "Speed test failed.");
      return null;
    } finally {
      if (controller.current === abort) {
        controller.current = null;
        setRunning(false);
      }
    }
  }

  function cancel() {
    controller.current?.abort();
  }

  return { progress, result, error, running, stored, start, cancel };
}

export function SpeedTestCard({
  test,
  transport,
  clock,
  options,
}: {
  /** Shared state (e.g. with the streaming path card); otherwise the card runs its own test. */
  test?: BrowserSpeedTest;
  transport?: SpeedTestTransport;
  clock?: Clock;
  options?: SpeedTestOptions;
}) {
  const own = useBrowserSpeedTest({ transport, clock, options });
  const { progress, result, error, running, start, cancel } = test ?? own;

  const best = result ? bestTier(result.downloadMbps) : null;

  return (
    <Card data-testid="browser-speed-test-card">
      <CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
        <div className="space-y-1.5">
          <CardTitle className="flex items-center gap-2 text-base">
            <Gauge className="size-4" />
            Browser ↔ server speed test
          </CardTitle>
          <CardDescription>
            Measures the link between this browser and the Streamarr server — the Streaming path card
            measures the Usenet side. Takes about 20 seconds and can transfer several GB on fast links.
          </CardDescription>
        </div>
        {running ? (
          <Button variant="outline" onClick={cancel}>
            <XCircle />
            Cancel
          </Button>
        ) : (
          <Button onClick={() => void start()}>
            <Gauge />
            {result ? "Run again" : "Start test"}
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        <dl className="grid gap-3 sm:grid-cols-4">
          <Metric icon={<Timer className="size-3.5" />} label="Ping" value={fmtMs(progress?.pingMs)} />
          <Metric icon={<Timer className="size-3.5" />} label="Jitter" value={fmtMs(progress?.jitterMs)} />
          <Metric
            icon={<ArrowDown className="size-3.5" />}
            label="Download"
            value={fmtMbps(progress?.downloadMbps ?? (progress?.phase === "download" ? progress.liveMbps : undefined))}
            live={running && progress?.phase === "download"}
          />
          <Metric
            icon={<ArrowUp className="size-3.5" />}
            label="Upload"
            value={fmtMbps(progress?.uploadMbps ?? (progress?.phase === "upload" ? progress.liveMbps : undefined))}
            live={running && progress?.phase === "upload"}
          />
        </dl>

        {running && progress && (
          <div className="space-y-1.5" role="status" aria-live="polite">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              {PHASE_LABEL[progress.phase] ?? "Working…"}
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
              <div
                className="h-full rounded-full bg-primary transition-[width] duration-200"
                style={{ width: `${Math.round(progress.phaseProgress * 100)}%` }}
              />
            </div>
          </div>
        )}

        {error && (
          <p role="alert" className="flex items-center gap-2 text-sm text-destructive">
            <XCircle className="size-4 shrink-0" />
            {error}
          </p>
        )}

        {result && (
          <div className="space-y-3 rounded-md border bg-muted/20 p-4" role="status">
            <p className="text-sm font-medium">
              {best
                ? `This browser can comfortably stream up to ${best.label} from the server.`
                : "This connection is too slow for smooth 720p streaming from the server."}
            </p>
            <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              {tierVerdicts(result.downloadMbps).map((tier) => (
                <li
                  key={tier.id}
                  className={cn(
                    "flex items-center gap-2 rounded-md border px-3 py-2 text-sm",
                    tier.passes ? "border-success/30 bg-success/10" : "bg-background",
                  )}
                >
                  {tier.passes ? (
                    <CheckCircle2 className="size-4 shrink-0 text-success" aria-label="passes" />
                  ) : (
                    <XCircle className="size-4 shrink-0 text-muted-foreground" aria-label="too slow" />
                  )}
                  <span className="min-w-0">
                    <span className="block font-medium">{tier.label}</span>
                    <span className="block text-xs text-muted-foreground">
                      needs {tier.requiredMbps.toFixed(0)} Mbit/s
                    </span>
                  </span>
                </li>
              ))}
            </ul>
            <p className="text-xs text-muted-foreground">
              Assumed bitrates: 4K HDR remux ≈ 80 Mbit/s, 4K streaming ≈ 25, 1080p ≈ 10, 720p ≈ 5. A tier
              passes when the download speed is at least {HEADROOM}× its bitrate, leaving headroom for
              bitrate peaks. Ping uses the median of 6 samples (one more is a warm-up); jitter is the mean
              difference between consecutive pings. Download and upload each run 4 parallel streams for 8 s
              (one long request per stream) and ignore the first 1.5 s.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Metric({
  icon,
  label,
  value,
  live = false,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  live?: boolean;
}) {
  return (
    <div className="rounded-md border px-3 py-2">
      <dt className="flex items-center gap-1.5 text-xs font-medium uppercase text-muted-foreground">
        {icon}
        {label}
        {live && <span className="ml-auto size-1.5 animate-pulse rounded-full bg-primary" aria-hidden />}
      </dt>
      <dd className="mt-1 text-xl font-semibold tabular-nums" data-testid={`speed-${label.toLowerCase()}`}>
        {value}
      </dd>
    </div>
  );
}

function fmtMs(ms?: number): string {
  if (ms == null) return "—";
  return ms < 10 ? `${ms.toFixed(1)} ms` : `${Math.round(ms)} ms`;
}

function fmtMbps(mbps?: number): string {
  if (mbps == null) return "—";
  return mbps < 100 ? `${mbps.toFixed(1)} Mbit/s` : `${Math.round(mbps)} Mbit/s`;
}
