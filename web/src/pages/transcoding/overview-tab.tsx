import type { ReactNode } from "react";
import {
  AlertTriangle,
  ArrowRightLeft,
  CheckCircle2,
  CircleSlash,
  Cpu,
  Info,
  Lightbulb,
  Loader2,
  MemoryStick,
  MonitorCog,
  RefreshCw,
  Server,
  Wrench,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { errorMessage } from "@/api/client";
import {
  useRefreshTranscodingCapabilities,
  useTranscodingCapabilities,
  useTranscodingConfig,
  useUpdateTranscodingConfig,
} from "@/api/queries";
import type {
  AcceleratorResponse,
  GpuDeviceResponse,
  TranscodingCapabilitiesResponse,
  TranscodingConfigResponse,
} from "@/api/types";
import { CheckMark } from "@/components/transcode-plan";
import { Button } from "@/components/ui/button";
import {
  acceleratorStatus,
  accelerationLabel,
  accelerationShortLabel,
  codecLabel,
  deviceBackends,
  deviceCheck,
  transcodingHealth,
  type HealthVerdict,
} from "@/lib/transcoding";
import { cn, timeAgo } from "@/lib/utils";
import { ErrorPanel, LoadingBlock, SectionHeading, ToneBadge } from "./shared";

export function OverviewTab() {
  const caps = useTranscodingCapabilities();
  const config = useTranscodingConfig();
  const refresh = useRefreshTranscodingCapabilities();
  const update = useUpdateTranscodingConfig();

  if (caps.isLoading) return <LoadingBlock label="Loading transcoding diagnostics" />;
  if (caps.isError || !caps.data) return <ErrorPanel message={errorMessage(caps.error)} />;

  const data = caps.data;
  const verdict = transcodingHealth(data, config.data);
  const detecting = data.detecting || refresh.isPending;
  const configured = (config.data?.acceleration ?? "none").toLowerCase();
  const recommended = (data.recommended ?? "none").toLowerCase();
  const showSwitch = data.detected && !data.detecting && data.usable && !!config.data && configured !== recommended;
  const accelerators = data.accelerators ?? [];
  const applicable = accelerators.filter((a) => a.status !== "not-applicable");
  const elsewhere = accelerators.filter((a) => a.status === "not-applicable");

  async function rerun() {
    try {
      await refresh.mutateAsync();
      toast.success("Hardware detection started.");
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  async function selectDevice(backend: string, device: GpuDeviceResponse) {
    const write = backend === "nvenc"
      ? { acceleration: "nvenc", nvencDevice: device.index ?? 0 }
      : { acceleration: backend, vaapiDevice: device.id ?? "" };
    try {
      await update.mutateAsync(write);
      toast.success(`${accelerationLabel(backend)} now uses ${device.label ?? device.id}. Re-running detection…`);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  async function switchAcceleration() {
    try {
      await update.mutateAsync({ acceleration: recommended });
      toast.success(`Acceleration set to ${accelerationLabel(recommended)}. Re-running detection…`);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  return (
    <div className="space-y-5">
      <VerdictPanel verdict={verdict} data={data} detecting={detecting} onRerun={rerun} />

      {showSwitch && (
        <div className="flex flex-col gap-3 rounded-xl border border-lime-500/40 bg-lime-500/10 p-4 sm:flex-row sm:items-center" role="note" aria-label="Recommended acceleration">
          <ArrowRightLeft className="size-5 shrink-0 text-lime-700 dark:text-lime-300" aria-hidden />
          <div className="min-w-0 flex-1 text-sm">
            <p className="font-medium">
              {recommended === "none"
                ? "Switch to software transcoding"
                : `Switch to ${accelerationLabel(recommended)}`}
            </p>
            <p className="text-xs leading-5 text-muted-foreground">
              {recommended === "none"
                ? `${accelerationLabel(configured)} is configured, but no hardware encoder passed the self-tests. Software avoids a failing hardware setup on every stream.`
                : `${accelerationLabel(recommended)} passed the hardware encode self-test; ${accelerationLabel(configured)} is configured right now.`}
            </p>
          </div>
          <Button type="button" onClick={switchAcceleration} disabled={update.isPending} className="sm:shrink-0">
            {update.isPending && <Loader2 className="animate-spin" />}
            Use {recommended === "none" ? "software" : accelerationLabel(recommended)}
          </Button>
        </div>
      )}

      {data.detected && data.ffmpegFound && (
        <div className="grid gap-4 lg:grid-cols-2">
          <FfmpegCard data={data} />
          <PlatformCard data={data} />
        </div>
      )}
      {data.detected && !data.ffmpegFound && data.platform && <PlatformCard data={data} />}

      {data.detected && data.ffmpegFound && (
        <section aria-labelledby="accelerators-heading" className="space-y-3">
          <SectionHeading
            id="accelerators-heading"
            icon={<Cpu />}
            title="Hardware accelerators"
            detail="Each backend ran a real 1-second encode, per-codec decode and tone-mapping test on this machine. Hover a decode cell for ffmpeg's answer."
          />
          {applicable.length === 0 ? (
            <p className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">
              No hardware backend applies to {data.platform?.os ?? "this platform"}; transcoding runs on the CPU.
            </p>
          ) : (
            <div className="grid gap-4 xl:grid-cols-2">
              {applicable.map((accelerator) => (
                <AcceleratorCard
                  key={accelerator.id}
                  accelerator={accelerator}
                  configured={accelerator.id === configured}
                  recommended={accelerator.id === recommended}
                  alternative={(data.devices ?? []).find((device) => device.id === accelerator.alternativeDevice)}
                  busy={update.isPending}
                  onSelectDevice={(device) => selectDevice(accelerator.id ?? "none", device)}
                />
              ))}
            </div>
          )}
          {(data.devices ?? []).length > 0 && config.data && (
            <DevicesSection devices={data.devices ?? []} config={config.data} busy={update.isPending} onSelect={selectDevice} />
          )}
          {elsewhere.length > 0 && (
            <div className="rounded-xl border bg-card/60 px-4 py-3 text-xs text-muted-foreground">
              <p className="font-medium text-foreground">Not applicable on {data.platform?.os ?? "this platform"}</p>
              <p className="mt-0.5">{elsewhere.map((a) => a.label).join(" · ")}</p>
            </div>
          )}
        </section>
      )}

      {data.detected && data.ffmpegFound && <BuildFeatures data={data} />}
    </div>
  );
}

function VerdictPanel({
  verdict,
  data,
  detecting,
  onRerun,
}: {
  verdict: HealthVerdict;
  data: TranscodingCapabilitiesResponse;
  detecting: boolean;
  onRerun: () => void;
}) {
  const icon = verdict.tone === "pending"
    ? <Loader2 className="size-6 animate-spin" />
    : verdict.tone === "success"
      ? <CheckCircle2 className="size-6" />
      : verdict.tone === "danger"
        ? <XCircle className="size-6" />
        : verdict.tone === "muted"
          ? <CircleSlash className="size-6" />
          : verdict.tone === "info"
            ? <Info className="size-6" />
            : <AlertTriangle className="size-6" />;
  const frame = {
    pending: "border-border",
    success: "border-emerald-500/40 bg-emerald-500/[0.06]",
    warning: "border-amber-500/40 bg-amber-500/[0.07]",
    danger: "border-red-500/40 bg-red-500/[0.06]",
    info: "border-sky-500/40 bg-sky-500/[0.06]",
    muted: "border-border",
  }[verdict.tone];
  const iconColor = {
    pending: "text-muted-foreground",
    success: "text-emerald-600 dark:text-emerald-400",
    warning: "text-amber-600 dark:text-amber-400",
    danger: "text-red-600 dark:text-red-400",
    info: "text-sky-600 dark:text-sky-400",
    muted: "text-muted-foreground",
  }[verdict.tone];

  return (
    <section className={cn("rounded-xl border bg-card p-4 sm:p-5", frame)} aria-labelledby="transcoding-verdict" aria-live="polite">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
        <span className={cn("shrink-0", iconColor)} aria-hidden>{icon}</span>
        <div className="min-w-0 flex-1">
          <h3 id="transcoding-verdict" className="text-lg font-semibold leading-tight tracking-tight">{verdict.title}</h3>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">{verdict.detail}</p>
          {data.detected && !data.ffmpegFound && (
            <p className="mt-2 text-xs leading-5 text-muted-foreground">
              Install ffmpeg 5 or newer (for example <code className="font-mono">brew install ffmpeg</code>,{" "}
              <code className="font-mono">apt install ffmpeg</code> or jellyfin-ffmpeg) and set{" "}
              <code className="font-mono">Streamarr:Transcoding:FfmpegPath</code> if it is not on the PATH, then re-run detection.
            </p>
          )}
          {data.detected && (
            <p className="mt-2 font-mono text-[11px] text-muted-foreground">
              {detecting
                ? "Re-running detection and hardware self-tests…"
                : `Detected ${timeAgo(data.detectedAt)}${data.durationSeconds ? ` in ${data.durationSeconds.toFixed(1)} s` : ""}`}
            </p>
          )}
        </div>
        <Button type="button" variant="outline" onClick={onRerun} disabled={detecting} className="sm:shrink-0">
          {detecting ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          {detecting ? "Detecting…" : "Re-run hardware detection"}
        </Button>
      </div>
    </section>
  );
}

function FfmpegCard({ data }: { data: TranscodingCapabilitiesResponse }) {
  return (
    <InfoCard icon={<Wrench />} title="ffmpeg">
      <InfoRow label="ffmpeg">
        <span className="inline-flex items-center gap-1.5">
          <CheckMark passed={data.meetsMinimumVersion} className="[&_svg]:size-3.5" />
          {data.version ?? "unknown version"}
          {!data.meetsMinimumVersion && <span className="text-destructive">(needs 5 or newer)</span>}
        </span>
      </InfoRow>
      <InfoRow label="Path" mono>{data.ffmpegPath || "ffmpeg"}</InfoRow>
      <InfoRow label="ffprobe">
        <span className="inline-flex items-center gap-1.5">
          <CheckMark passed={data.ffprobeFound} className="[&_svg]:size-3.5" />
          {data.ffprobeFound ? data.ffprobeVersion ?? "found" : "missing"}
        </span>
      </InfoRow>
      <InfoRow label="CPU tone mapping">
        <span className="inline-flex items-center gap-1.5">
          <CheckMark passed={data.softwareToneMapping} className="[&_svg]:size-3.5" />
          {data.softwareToneMapping ? "zscale + tonemap available" : "no zscale — HDR needs hardware tone mapping"}
        </span>
      </InfoRow>
      <InfoRow label="Keyframes">
        {data.relativeKeyframeExpressions ? "relative -force_key_frames (ffmpeg ≥ 6)" : "absolute -force_key_frames (legacy)"}
      </InfoRow>
      {data.error && <InfoRow label="Error"><span className="text-destructive">{data.error}</span></InfoRow>}
    </InfoCard>
  );
}

function PlatformCard({ data }: { data: TranscodingCapabilitiesResponse }) {
  const platform = data.platform;
  if (!platform) return null;
  return (
    <InfoCard icon={<Server />} title="Host">
      <InfoRow label="System">{platform.os} · {platform.architecture}</InfoRow>
      <InfoRow label="CPU">{platform.cpuModel ?? "unknown"}</InfoRow>
      <InfoRow label="Cores">{platform.logicalCores} logical</InfoRow>
      <InfoRow label="Container">{platform.inContainer ? "Yes (Docker / Podman)" : "No"}</InfoRow>
      {platform.inContainer && (
        <p className="mt-2 rounded-md bg-muted/50 p-2 text-[11px] leading-5 text-muted-foreground">
          GPUs must be passed into the container: <code className="font-mono">--device /dev/dri</code> for Intel/AMD, or the
          NVIDIA Container Toolkit with <code className="font-mono">--gpus all</code>.
        </p>
      )}
    </InfoCard>
  );
}

function AcceleratorCard({
  accelerator,
  configured,
  recommended,
  alternative,
  busy,
  onSelectDevice,
}: {
  accelerator: AcceleratorResponse;
  configured: boolean;
  recommended: boolean;
  alternative?: GpuDeviceResponse;
  busy: boolean;
  onSelectDevice: (device: GpuDeviceResponse) => void;
}) {
  const status = acceleratorStatus(accelerator.status);
  const decode = accelerator.decode ?? [];
  const notes = accelerator.notes ?? [];
  const ready = accelerator.status === "ready";
  const failures = [
    { name: "H.264 encode", check: accelerator.h264Encode },
    { name: "HEVC encode", check: accelerator.hevcEncode },
    { name: "Tone mapping", check: accelerator.toneMapping },
    ...decode.map((d) => ({ name: `${codecLabel(d.codec)} decode`, check: { passed: d.passed, detail: d.detail } })),
  ].filter(({ check }) => check.passed === false && check.detail);
  const headingId = `accelerator-${accelerator.id}`;

  return (
    <article className="min-w-0 rounded-xl border bg-card p-4" aria-labelledby={headingId}>
      <header className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <h4 id={headingId} className="font-semibold">{accelerator.label}</h4>
          <p className="font-mono text-[11px] text-muted-foreground">
            {accelerator.id}
            {accelerator.device ? ` · ${accelerator.device}` : ""}
            {accelerator.devicePresent === false ? " (missing)" : ""}
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {configured && <ToneBadge tone="info">Configured</ToneBadge>}
          {recommended && <ToneBadge tone="success">Recommended</ToneBadge>}
          <ToneBadge tone={status.tone}>{status.label}</ToneBadge>
        </div>
      </header>

      {notes.length > 0 && !ready && (
        <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs leading-5 text-amber-900 dark:text-amber-200" role="note" aria-label={`${accelerator.label} setup hints`}>
          <p className="flex items-center gap-1.5 font-semibold"><Lightbulb className="size-3.5" aria-hidden />Setup hints</p>
          <ul className="mt-1 list-disc space-y-1 pl-5">
            {notes.map((note) => <li key={note}>{note}</li>)}
          </ul>
          {alternative && (
            <Button type="button" size="sm" variant="outline" className="mt-2 h-7 bg-background/80" disabled={busy} onClick={() => onSelectDevice(alternative)}>
              Use {alternative.label}
            </Button>
          )}
        </div>
      )}

      <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-3">
        <CheckCell label="H.264 encode" passed={accelerator.h264Encode.passed} detail={accelerator.h264Encode.detail} />
        <CheckCell label="HEVC encode" passed={accelerator.hevcEncode.passed} detail={accelerator.hevcEncode.detail} />
        <CheckCell label="Tone mapping" passed={accelerator.toneMapping.passed} detail={accelerator.toneMapping.detail} />
      </dl>

      <div className="mt-3">
        <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Hardware decode</p>
        <ul className="mt-1.5 grid grid-cols-2 gap-1.5 sm:grid-cols-4" aria-label={`${accelerator.label} decode support`}>
          {decode.map((check) => (
            <li
              key={check.codec}
              className={cn(
                "flex items-center justify-between gap-1 rounded-md border px-2 py-1 text-xs",
                check.passed === true && "border-emerald-500/30 bg-emerald-500/5",
                check.passed === false && "border-red-500/25 bg-red-500/5",
              )}
              title={check.detail ?? (check.passed == null ? "Not tested" : undefined)}
            >
              <span className="truncate">{codecLabel(check.codec)}</span>
              <CheckMark passed={check.passed} className="[&_svg]:size-3.5" />
            </li>
          ))}
        </ul>
      </div>

      {failures.length > 0 && (
        <details className="group mt-3 text-xs">
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
            Why {failures.length} {failures.length === 1 ? "check" : "checks"} failed
          </summary>
          <ul className="mt-2 space-y-2">
            {failures.map(({ name, check }) => (
              <li key={name}>
                <p className="font-medium">{name}</p>
                <pre className="mt-0.5 whitespace-pre-wrap break-words rounded-md bg-muted/50 p-2 font-mono text-[10px] leading-4 text-muted-foreground">{check.detail}</pre>
              </li>
            ))}
          </ul>
        </details>
      )}

      {notes.length > 0 && ready && (
        <ul className="mt-3 space-y-1 text-xs text-muted-foreground">
          {notes.map((note) => <li key={note}>{note}</li>)}
        </ul>
      )}
    </article>
  );
}

function CheckCell({ label, passed, detail }: { label: string; passed?: boolean | null; detail?: string | null }) {
  const summary = passed === true ? detail ?? "passed" : passed === false ? "failed" : detail ?? "not tested";
  return (
    <div className="min-w-0 rounded-md border bg-background/60 px-2.5 py-2 dark:bg-zinc-900/40" title={detail ?? undefined}>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 flex items-center gap-1.5">
        <CheckMark passed={passed} className="[&_svg]:size-3.5" />
        <span className="truncate">{summary}</span>
      </dd>
    </div>
  );
}

function BuildFeatures({ data }: { data: TranscodingCapabilitiesResponse }) {
  return (
    <section aria-labelledby="build-heading" className="space-y-3">
      <SectionHeading id="build-heading" icon={<MonitorCog />} title="ffmpeg build" detail="Encoders, hardware accelerators and filters relevant to the transcoding pipeline." />
      <div className="grid gap-3 rounded-xl border bg-card p-4 md:grid-cols-2">
        <ChipList label="Video encoders" items={data.videoEncoders ?? []} />
        <ChipList label="Audio encoders" items={data.audioEncoders ?? []} />
        <ChipList label="Hardware accelerators" items={data.hwAccels ?? []} />
        <ChipList label="Filters" items={data.filters ?? []} />
      </div>
    </section>
  );
}

function ChipList({ label, items }: { label: string; items: string[] }) {
  return (
    <div className="min-w-0">
      <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">{label}</p>
      {items.length === 0 ? (
        <p className="mt-1 text-xs text-muted-foreground">none</p>
      ) : (
        <ul className="mt-1.5 flex flex-wrap gap-1" aria-label={label}>
          {items.map((item) => (
            <li key={item} className="rounded border bg-muted/40 px-1.5 py-0.5 font-mono text-[10px]">{item}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function InfoCard({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <section className="min-w-0 rounded-xl border bg-card p-4" aria-label={title}>
      <h3 className="flex items-center gap-2 text-sm font-semibold [&_svg]:size-4 [&_svg]:text-lime-600 dark:[&_svg]:text-lime-400">
        {icon}
        {title}
      </h3>
      <dl className="mt-3 space-y-1.5 text-xs">{children}</dl>
    </section>
  );
}

function InfoRow({ label, children, mono = false }: { label: string; children: ReactNode; mono?: boolean }) {
  return (
    <div className="grid grid-cols-[7.5rem_minmax(0,1fr)] gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn("break-words", mono && "break-all font-mono text-[11px]")}>{children}</dd>
    </div>
  );
}

function DevicesSection({
  devices,
  config,
  busy,
  onSelect,
}: {
  devices: GpuDeviceResponse[];
  config: TranscodingConfigResponse;
  busy: boolean;
  onSelect: (backend: string, device: GpuDeviceResponse) => void;
}) {
  const configured = (config.acceleration ?? "none").toLowerCase();
  return (
    <section aria-labelledby="devices-heading" className="space-y-3 pt-2">
      <SectionHeading
        id="devices-heading"
        icon={<MemoryStick />}
        title="Graphics devices"
        detail="Every GPU the server can see, with a quick encode test per backend. On multi-GPU hosts pick the one that should transcode."
      />
      <ul className="grid gap-3 lg:grid-cols-2" aria-label="Graphics devices">
        {devices.map((device) => {
          const backends = deviceBackends(device);
          return (
            <li key={device.id} className="min-w-0 rounded-xl border bg-card p-3">
              <div className="flex flex-wrap items-start gap-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium" title={device.label ?? undefined}>{device.name ?? device.vendor ?? "Unknown GPU"}</p>
                  <p className="font-mono text-[11px] text-muted-foreground">
                    {device.kind === "cuda" ? `GPU ${device.index}` : device.id}
                    {device.driver ? ` · ${device.driver}` : ""}
                    {device.pciSlot ? ` · ${device.pciSlot}` : ""}
                  </p>
                </div>
              </div>
              {backends.length === 0 ? (
                <p className="mt-2 text-xs text-muted-foreground">NVIDIA driver render node — VA-API does not work here; this GPU is listed under NVENC.</p>
              ) : (
                <ul className="mt-2 space-y-1.5">
                  {backends.map((backend) => {
                    const check = deviceCheck(device, backend);
                    const selected = backend === "nvenc" ? config.nvencDevice === device.index : config.vaapiDevice === device.id;
                    const active = selected && configured === backend;
                    return (
                      <li key={backend} className="flex flex-wrap items-center gap-2 text-xs">
                        <CheckMark passed={check?.passed} className="[&_svg]:size-3.5" />
                        <span className="min-w-0 flex-1" title={check?.detail ?? undefined}>
                          {accelerationLabel(backend)}
                          <span className="text-muted-foreground">
                            {check?.passed === true ? ` · encode ${check.detail ?? "ok"}` : check?.passed === false ? " · encode failed" : " · not tested"}
                          </span>
                        </span>
                        {active ? (
                          <ToneBadge tone="info">In use</ToneBadge>
                        ) : selected ? (
                          <ToneBadge tone="muted">Selected for {accelerationShortLabel(backend)}</ToneBadge>
                        ) : check?.passed === true ? (
                          <Button type="button" size="sm" variant="outline" className="h-7" disabled={busy} onClick={() => onSelect(backend, device)}
                            aria-label={`Use ${device.label ?? device.id} for ${accelerationLabel(backend)}`}>
                            Use for {accelerationShortLabel(backend)}
                          </Button>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
