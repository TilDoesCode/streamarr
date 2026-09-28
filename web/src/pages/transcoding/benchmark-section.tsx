import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Clock3,
  Cpu,
  Film,
  FlaskConical,
  Gauge,
  History,
  KeyRound,
  Loader2,
  Play,
  Timer,
  Zap,
} from "lucide-react";
import { toast } from "sonner";
import { errorMessage } from "@/api/client";
import {
  isBenchmarkActive,
  queryKeys,
  useStartBenchmark,
  useTranscodingBenchmark,
  useTranscodingBenchmarks,
} from "@/api/queries";
import type {
  BenchmarkResponse,
  BenchmarkResultResponse,
  TranscodingCapabilitiesResponse,
  TranscodingConfigResponse,
  TranscodingSampleResponse,
} from "@/api/types";
import { CodeDisclosure } from "@/components/code-disclosure";
import { CheckMark, PlanExplanation } from "@/components/transcode-plan";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  HEIGHT_OPTIONS,
  acceleratorStatus,
  accelerationLabel,
  benchmarkStateLabel,
  formatBitrate,
  formatSpeed,
  shellCommand,
  verdictMeta,
  type Tone,
} from "@/lib/transcoding";
import { cn, formatMs, timeAgo } from "@/lib/utils";
import { ErrorPanel, ProgressBar, SectionHeading, ToneBadge, selectClassName } from "./shared";

export function BenchmarkLab({
  samples,
  caps,
  config,
}: {
  samples: TranscodingSampleResponse[];
  caps?: TranscodingCapabilitiesResponse;
  config?: TranscodingConfigResponse;
}) {
  const qc = useQueryClient();
  const history = useTranscodingBenchmarks();
  const start = useStartBenchmark();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const shownId = selectedId ?? history.data?.[0]?.id ?? null;
  const detail = useTranscodingBenchmark(shownId);
  const run = detail.data ?? history.data?.find((item) => item.id === shownId);

  const usable = samples.filter((sample) => sample.state !== "unsupported");
  const [sampleId, setSampleId] = useState("");
  const [maxHeight, setMaxHeight] = useState(1080);
  const [bitrate, setBitrate] = useState("");
  const [acceleration, setAcceleration] = useState("");
  const chosenSample = sampleId || usable.find((sample) => sample.state === "ready")?.id || usable[0]?.id || "";
  const bitrateValue = bitrate.trim() === "" ? undefined : Number(bitrate);
  const bitrateError = bitrateValue !== undefined && (!Number.isInteger(bitrateValue) || bitrateValue < 500 || bitrateValue > 200_000)
    ? "Between 500 and 200,000 kbps"
    : null;
  const busy = start.isPending || (history.data ?? []).some((item) => isBenchmarkActive(item.state));

  // A benchmark may have generated its sample; refresh the library once a run settles.
  const lastState = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const state = run?.state;
    if (lastState.current !== undefined && lastState.current !== state && !isBenchmarkActive(state)) {
      void qc.invalidateQueries({ queryKey: queryKeys.transcodingSamples });
      void qc.invalidateQueries({ queryKey: queryKeys.transcodingBenchmarks });
    }
    lastState.current = state;
  }, [qc, run?.state]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!chosenSample || bitrateError) return;
    try {
      const created = await start.mutateAsync({
        sampleId: chosenSample,
        maxHeight,
        bitrateKbps: bitrateValue,
        acceleration: acceleration || undefined,
      });
      setSelectedId(created.id);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  const configured = config?.acceleration ?? "none";

  return (
    <section aria-labelledby="benchmark-heading" className="space-y-3">
      <SectionHeading
        id="benchmark-heading"
        icon={<FlaskConical />}
        title="Benchmark"
        detail="Transcodes a sample flat-out with the live pipeline, then grades speed, CPU use, time to first segment, seek latency and keyframe alignment. Runs execute one at a time."
      />

      <form onSubmit={submit} className="grid gap-3 rounded-xl border bg-card p-4 sm:grid-cols-2 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.4fr)_auto] xl:items-end" aria-label="Benchmark settings">
        <div className="space-y-1.5">
          <Label htmlFor="benchmark-sample">Sample</Label>
          <select id="benchmark-sample" className={selectClassName} value={chosenSample} onChange={(event) => setSampleId(event.target.value)}>
            {usable.map((sample) => (
              <option key={sample.id} value={sample.id ?? ""}>
                {sample.title}{sample.state === "ready" ? "" : " (will be generated)"}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="benchmark-height">Max height</Label>
          <select id="benchmark-height" className={selectClassName} value={maxHeight} onChange={(event) => setMaxHeight(Number(event.target.value))}>
            {HEIGHT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="benchmark-bitrate">Bitrate (kbps)</Label>
          <Input
            id="benchmark-bitrate"
            type="number"
            inputMode="numeric"
            min={500}
            max={200_000}
            placeholder={`auto (${Math.min(config?.maxBitrateKbps ?? 8_000, 8_000)})`}
            value={bitrate}
            onChange={(event) => setBitrate(event.target.value)}
            aria-invalid={!!bitrateError}
            aria-describedby={bitrateError ? "benchmark-bitrate-error" : undefined}
          />
          {bitrateError && <p id="benchmark-bitrate-error" className="text-xs text-destructive">{bitrateError}</p>}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="benchmark-acceleration">Acceleration</Label>
          <select id="benchmark-acceleration" className={selectClassName} value={acceleration} onChange={(event) => setAcceleration(event.target.value)}>
            <option value="">Configured ({accelerationLabel(configured)})</option>
            <option value="none">Software (CPU)</option>
            {(caps?.accelerators ?? [])
              .filter((accelerator) => accelerator.status !== "not-applicable")
              .map((accelerator) => (
                <option key={accelerator.id} value={accelerator.id ?? ""}>
                  {accelerator.label} — {acceleratorStatus(accelerator.status).label.toLowerCase()}
                </option>
              ))}
          </select>
        </div>
        <Button type="submit" disabled={!chosenSample || !!bitrateError || start.isPending} className="sm:col-span-2 xl:col-span-1">
          {start.isPending ? <Loader2 className="animate-spin" /> : <Play />}
          {busy && !start.isPending ? "Queue benchmark" : "Run benchmark"}
        </Button>
      </form>

      {run ? (
        <BenchmarkRun run={run} />
      ) : history.isError ? (
        <ErrorPanel message={errorMessage(history.error)} />
      ) : (
        <p className="rounded-xl border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
          No benchmark has run yet. Pick a sample and run one — the smallest (720p H.264) takes a few seconds.
        </p>
      )}

      {(history.data?.length ?? 0) > 0 && (
        <BenchmarkHistory runs={history.data ?? []} selectedId={shownId} onSelect={setSelectedId} />
      )}
    </section>
  );
}

export function BenchmarkRun({ run }: { run: BenchmarkResponse }) {
  const active = isBenchmarkActive(run.state);
  const result = run.result;
  return (
    <article className="space-y-4 rounded-xl border bg-card p-4 sm:p-5" aria-label="Benchmark result" aria-busy={active}>
      <header className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <h4 className="font-semibold">{run.sampleTitle}</h4>
          <p className="font-mono text-[11px] text-muted-foreground">
            ≤{run.maxHeight >= 4320 ? "source" : `${run.maxHeight}p`} · {formatBitrate(run.bitrateKbps)} · {accelerationLabel(run.acceleration)} · {timeAgo(run.createdAt)}
          </p>
        </div>
        {result ? (
          <VerdictBadge verdict={result.verdict} />
        ) : (
          <ToneBadge tone={run.state === "failed" ? "danger" : "info"}>{benchmarkStateLabel(run.state)}</ToneBadge>
        )}
      </header>

      {active && (
        <div className="space-y-1.5" aria-live="polite">
          <div className="flex items-center justify-between text-xs">
            <span className="inline-flex items-center gap-1.5"><Loader2 className="size-3.5 animate-spin" />{benchmarkStateLabel(run.state)}…</span>
            <span className="font-mono tabular-nums text-muted-foreground">{Math.round(run.progress * 100)}%</span>
          </div>
          <ProgressBar value={run.state === "running" ? run.progress : 0.02} label="Benchmark progress" />
        </div>
      )}

      {!result && run.error && <ErrorPanel message={run.error} />}

      {result && <BenchmarkResultView result={result} />}

      {run.plan && (
        <details className="group rounded-lg border" open={!!result}>
          <summary className="cursor-pointer px-3 py-2 text-xs font-medium hover:bg-muted/40">How the pipeline was planned</summary>
          <div className="border-t p-3">
            <PlanExplanation plan={run.plan} />
          </div>
        </details>
      )}

      {result && (
        <div className="space-y-2">
          <CodeDisclosure title="ffmpeg command" text={result.command?.length ? shellCommand(result.command) : ""} meta={`${result.command?.length ?? 0} arguments`} />
          <CodeDisclosure title="ffmpeg log" text={result.log ?? ""} emptyText="ffmpeg wrote no warnings." />
        </div>
      )}
    </article>
  );
}

function BenchmarkResultView({ result }: { result: BenchmarkResultResponse }) {
  const checks = result.segmentChecks ?? [];
  const warnings = result.warnings ?? [];
  const speed = result.speed ?? 0;
  return (
    <div className="space-y-4">
      <p className="text-base font-medium leading-snug">{result.summary}</p>
      {(result.verdict ?? "").toLowerCase() !== "failed" && <SpeedMeter speed={speed} />}

      {result.hardwareFallbackDetected && (
        <div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-800 dark:text-red-200" role="alert">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>
            <strong className="font-semibold">Hardware fallback detected.</strong> ffmpeg reported a hardware initialisation
            failure, so part of the pipeline ran on the CPU. Check the log and the accelerator setup hints.
          </span>
        </div>
      )}

      <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border md:grid-cols-4">
        <Stat icon={<Film />} label="Encode rate" value={`${(result.fps ?? 0).toFixed(0)} fps`} detail={`${(result.mediaSeconds ?? 0).toFixed(0)} s of media in ${(result.wallSeconds ?? 0).toFixed(1)} s`} />
        <Stat
          icon={<Cpu />}
          label="CPU"
          value={`${(result.averageCpuCores ?? 0).toFixed(1)} cores`}
          detail={result.cpuSharePercent != null ? `${result.cpuSharePercent.toFixed(0)}% of the machine · ${(result.cpuSeconds ?? 0).toFixed(1)} CPU-s` : `${(result.cpuSeconds ?? 0).toFixed(1)} CPU-s`}
        />
        <Stat icon={<Timer />} label="First segment" value={formatMs(result.timeToFirstSegmentMs)} detail="from ffmpeg start" />
        <Stat icon={<Clock3 />} label="Seek → segment" value={formatMs(result.seekTimeToFirstSegmentMs)} detail="restart mid-file" />
        <Stat
          icon={<Gauge />}
          label="Output"
          value={result.outputWidth ? `${result.outputWidth}×${result.outputHeight}` : "—"}
          detail={result.outputBitrateKbps ? `${formatBitrate(result.outputBitrateKbps)} measured` : undefined}
        />
        <Stat icon={<Zap />} label="Segments" value={`${result.segments ?? 0} / ${result.expectedSegments ?? 0}`} detail={(result.segments ?? 0) >= (result.expectedSegments ?? 0) ? "all produced" : "some missing"} tone={(result.segments ?? 0) >= (result.expectedSegments ?? 0) ? undefined : "danger"} />
        <Stat
          icon={<KeyRound />}
          label="Keyframes"
          value={result.keyframesAligned ? "Aligned" : "Misaligned"}
          detail={`max drift ${(result.maxDriftMs ?? 0).toFixed(0)} ms`}
          tone={result.keyframesAligned ? "success" : "danger"}
        />
        <Stat
          icon={<AlertTriangle />}
          label="HW fallback"
          value={result.hardwareFallbackDetected ? "Detected" : "None"}
          detail={result.hardwareFallbackDetected ? "see the ffmpeg log" : "no hardware init errors"}
          tone={result.hardwareFallbackDetected ? "danger" : undefined}
        />
      </dl>

      {warnings.length > 0 && (
        <ul className="space-y-1 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-900 dark:text-amber-200" aria-label="Benchmark warnings">
          {warnings.map((warning) => (
            <li key={warning} className="flex gap-2"><AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />{warning}</li>
          ))}
        </ul>
      )}

      {checks.length > 0 && (
        <div className="overflow-hidden rounded-lg border">
          <div className="max-h-72 overflow-auto">
            <table className="w-full min-w-[26rem] text-xs" aria-label="Segment checks">
              <thead className="sticky top-0 bg-muted/80 text-left text-muted-foreground backdrop-blur">
                <tr>
                  <th scope="col" className="px-3 py-2 font-medium">Segment</th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">Start</th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">Duration</th>
                  <th scope="col" className="px-3 py-2 text-center font-medium">Keyframe start</th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">Drift</th>
                </tr>
              </thead>
              <tbody className="divide-y font-mono tabular-nums">
                {checks.map((check) => {
                  const off = !check.startsWithKeyframe || Math.abs(check.driftMs ?? 0) > 200;
                  return (
                    <tr key={check.index} className={cn(off && "bg-red-500/5")}>
                      <td className="px-3 py-1.5">#{check.index}</td>
                      <td className="px-3 py-1.5 text-right">{(check.startSeconds ?? 0).toFixed(3)} s</td>
                      <td className="px-3 py-1.5 text-right">{(check.durationSeconds ?? 0).toFixed(3)} s</td>
                      <td className="px-3 py-1.5"><span className="flex justify-center"><CheckMark passed={check.startsWithKeyframe} className="[&_svg]:size-3.5" /></span></td>
                      <td className={cn("px-3 py-1.5 text-right", Math.abs(check.driftMs ?? 0) > 200 && "text-red-600 dark:text-red-400")}>{(check.driftMs ?? 0).toFixed(1)} ms</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

/** Speed as ×realtime; the tick marks 1× — anything left of it cannot keep up with playback. */
export function SpeedMeter({ speed }: { speed: number }) {
  const max = Math.max(3, Math.ceil(speed * 1.15));
  const fill = Math.min(1, Math.max(0, speed / max));
  const realtime = 1 / max;
  const ramp = speed >= 1.25
    ? { fill: "bg-emerald-500", track: "bg-emerald-500/15" }
    : speed >= 1
      ? { fill: "bg-amber-500", track: "bg-amber-500/15" }
      : { fill: "bg-red-500", track: "bg-red-500/15" };
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs text-muted-foreground">Transcode speed</span>
        <span className="text-2xl font-semibold">{formatSpeed(speed)} <span className="text-xs font-normal text-muted-foreground">realtime</span></span>
      </div>
      <div
        className={cn("relative h-3 rounded-full", ramp.track)}
        role="meter"
        aria-label="Transcode speed relative to realtime"
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={Number(speed.toFixed(2))}
        aria-valuetext={`${formatSpeed(speed)} realtime`}
      >
        <div className={cn("h-full rounded-full", ramp.fill)} style={{ width: `${fill * 100}%` }} />
        <div className="absolute -bottom-1 -top-1 w-0.5 rounded bg-foreground/70" style={{ left: `calc(${realtime * 100}% - 1px)` }} aria-hidden />
      </div>
      <div className="relative h-4 font-mono text-[10px] text-muted-foreground" aria-hidden>
        <span className="absolute left-0">0×</span>
        <span className="absolute -translate-x-1/2 whitespace-nowrap font-semibold text-foreground" style={{ left: `${realtime * 100}%` }}>1× realtime</span>
        <span className="absolute right-0">{max}×</span>
      </div>
    </div>
  );
}

function VerdictBadge({ verdict }: { verdict?: string | null }) {
  const meta = verdictMeta(verdict);
  return <ToneBadge tone={meta.tone} className="px-3 py-1 text-sm">{meta.label}</ToneBadge>;
}

function Stat({ icon, label, value, detail, tone }: { icon: ReactNode; label: string; value: string; detail?: string; tone?: Tone }) {
  return (
    <div className="min-w-0 bg-card px-3 py-2.5">
      <dt className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground [&_svg]:size-3">
        {icon}
        {label}
      </dt>
      <dd className={cn("mt-0.5 truncate text-base font-semibold", tone === "danger" && "text-red-600 dark:text-red-400", tone === "success" && "text-emerald-700 dark:text-emerald-400")} title={value}>
        {value}
      </dd>
      {detail && <dd className="truncate text-[10px] text-muted-foreground" title={detail}>{detail}</dd>}
    </div>
  );
}

function BenchmarkHistory({
  runs,
  selectedId,
  onSelect,
}: {
  runs: BenchmarkResponse[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="space-y-2">
      <p className="flex items-center gap-1.5 px-1 text-xs font-medium text-muted-foreground"><History className="size-3.5" />Recent benchmarks</p>
      <div className="overflow-x-auto rounded-xl border bg-card">
        <table className="w-full min-w-[40rem] text-xs" aria-label="Benchmark history">
          <thead className="border-b bg-muted/40 text-left text-muted-foreground">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">When</th>
              <th scope="col" className="px-3 py-2 font-medium">Sample</th>
              <th scope="col" className="px-3 py-2 font-medium">Target</th>
              <th scope="col" className="px-3 py-2 font-medium">Backend</th>
              <th scope="col" className="px-3 py-2 font-medium">Result</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Speed</th>
              <th scope="col" className="px-3 py-2"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {runs.map((item) => {
              const verdict = item.result ? verdictMeta(item.result.verdict) : null;
              const selected = item.id === selectedId;
              return (
                <tr key={item.id} className={cn(selected && "bg-lime-500/10")}>
                  <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">{timeAgo(item.createdAt)}</td>
                  <td className="max-w-[16rem] truncate px-3 py-2" title={item.sampleTitle ?? undefined}>{item.sampleTitle}</td>
                  <td className="whitespace-nowrap px-3 py-2 font-mono">{item.maxHeight >= 4320 ? "source" : `${item.maxHeight}p`} · {formatBitrate(item.bitrateKbps)}</td>
                  <td className="whitespace-nowrap px-3 py-2">{accelerationLabel(item.acceleration)}</td>
                  <td className="px-3 py-2">
                    {verdict ? <ToneBadge tone={verdict.tone}>{verdict.label}</ToneBadge> : <ToneBadge tone={item.state === "failed" ? "danger" : "info"}>{benchmarkStateLabel(item.state)}</ToneBadge>}
                  </td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">{item.result ? formatSpeed(item.result.speed) : "—"}</td>
                  <td className="px-3 py-2 text-right">
                    <Button type="button" size="sm" variant="ghost" className="h-7" onClick={() => item.id && onSelect(item.id)} aria-label={`Show benchmark of ${item.sampleTitle} from ${timeAgo(item.createdAt)}`} disabled={selected}>
                      {selected ? "Shown" : "Show"}
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
