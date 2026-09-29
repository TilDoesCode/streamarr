import { useEffect, type ReactNode } from "react";
import { Controller, useForm, type Control, type FieldPath, type UseFormRegisterReturn } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Cpu, FolderCog, Gauge, Loader2, RotateCcw, Save, SlidersHorizontal, Waves } from "lucide-react";
import { toast } from "sonner";
import { errorMessage } from "@/api/client";
import { useTranscodingCapabilities, useTranscodingConfig, useUpdateTranscodingConfig } from "@/api/queries";
import type { TranscodingCapabilitiesResponse, TranscodingConfigResponse, TranscodingConfigWrite } from "@/api/types";
import { CheckMark } from "@/components/transcode-plan";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { acceleratorStatus, accelerationLabel, codecLabel, findAccelerator } from "@/lib/transcoding";
import { cn, formatBytes } from "@/lib/utils";
import { NvencDeviceField, VaapiDeviceField } from "./device-fields";
import { ErrorPanel, LoadingBlock, selectClassName } from "./shared";

const whole = (min: number, max: number) =>
  z.coerce
    .number({ invalid_type_error: "Enter a number" })
    .int("Must be a whole number")
    .min(min, `Must be at least ${min.toLocaleString("en-US")}`)
    .max(max, `Must not exceed ${max.toLocaleString("en-US")}`);

// Mirrors TranscodingSettings.Validate() on the server.
export const transcodingSettingsSchema = z.object({
  enabled: z.boolean(),
  acceleration: z.string().min(1, "Choose a backend"),
  vaapiDevice: z
    .string()
    .trim()
    .regex(/^\/dev\/dri\/(renderD|card)[0-9]{1,4}$/, "Must be a DRM node such as /dev/dri/renderD128"),
  nvencDevice: whole(0, 15),
  hardwareDecoding: z.boolean(),
  hardwareDecodingAuto: z.boolean(),
  hardwareDecodingCodecs: z.array(z.string()).max(16),
  hardwareEncoding: z.boolean(),
  toneMapping: z.boolean(),
  allowHevcOutput: z.boolean(),
  encoderPreset: z.string().min(1, "Choose a preset"),
  crf: whole(12, 40),
  maxBitrateKbps: whole(500, 200_000),
  maxHeight: whole(240, 4_320),
  audioBitrateKbps: whole(64, 640),
  allowSurroundAudio: z.boolean(),
  segmentLengthSeconds: whole(2, 10),
  throttleEnabled: z.boolean(),
  throttleBufferSeconds: whole(30, 3_600),
  maxConcurrentTranscodes: whole(1, 16),
  maxConcurrentRemuxes: whole(1, 64),
  jobIdleTimeoutSeconds: whole(10, 3_600),
  sessionIdleTimeoutSeconds: whole(60, 86_400),
  segmentRetentionSeconds: whole(60, 86_400),
  threads: whole(0, 64),
});

type Values = z.input<typeof transcodingSettingsSchema>;

function toValues(config: TranscodingConfigResponse): Values {
  return {
    enabled: config.enabled,
    acceleration: config.acceleration ?? "none",
    vaapiDevice: config.vaapiDevice ?? "/dev/dri/renderD128",
    nvencDevice: config.nvencDevice ?? 0,
    hardwareDecoding: config.hardwareDecoding,
    hardwareDecodingAuto: config.hardwareDecodingAuto,
    hardwareDecodingCodecs: config.hardwareDecodingCodecs ?? [],
    hardwareEncoding: config.hardwareEncoding,
    toneMapping: config.toneMapping,
    allowHevcOutput: config.allowHevcOutput,
    encoderPreset: config.encoderPreset ?? "veryfast",
    crf: config.crf,
    maxBitrateKbps: config.maxBitrateKbps,
    maxHeight: config.maxHeight,
    audioBitrateKbps: config.audioBitrateKbps,
    allowSurroundAudio: config.allowSurroundAudio,
    segmentLengthSeconds: config.segmentLengthSeconds,
    throttleEnabled: config.throttleEnabled,
    throttleBufferSeconds: config.throttleBufferSeconds,
    maxConcurrentTranscodes: config.maxConcurrentTranscodes,
    maxConcurrentRemuxes: config.maxConcurrentRemuxes ?? 8,
    jobIdleTimeoutSeconds: config.jobIdleTimeoutSeconds,
    sessionIdleTimeoutSeconds: config.sessionIdleTimeoutSeconds,
    segmentRetentionSeconds: config.segmentRetentionSeconds,
    threads: config.threads,
  };
}

export function toWrite(values: z.output<typeof transcodingSettingsSchema>): TranscodingConfigWrite {
  const { hardwareDecodingCodecs, ...rest } = values;
  return values.hardwareDecodingAuto ? rest : { ...rest, hardwareDecodingCodecs };
}

export function SettingsTab() {
  const query = useTranscodingConfig();
  if (query.isLoading) return <LoadingBlock label="Loading transcoding settings" className="h-96" />;
  if (query.isError || !query.data) return <ErrorPanel message={errorMessage(query.error)} />;
  return <SettingsForm config={query.data} />;
}

function SettingsForm({ config }: { config: TranscodingConfigResponse }) {
  const caps = useTranscodingCapabilities();
  const update = useUpdateTranscodingConfig();
  const form = useForm<Values>({
    resolver: zodResolver(transcodingSettingsSchema),
    defaultValues: toValues(config),
  });

  useEffect(() => {
    form.reset(toValues(config), { keepDirtyValues: true });
  }, [form, config]);

  async function save(raw: Values) {
    const body = toWrite(transcodingSettingsSchema.parse(raw));
    try {
      const saved = await update.mutateAsync(body);
      form.reset(toValues(saved));
      toast.success("Transcoding settings saved.");
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  const errors = form.formState.errors;
  const acceleration = form.watch("acceleration");
  const enabled = form.watch("enabled");
  const hardwareDecoding = form.watch("hardwareDecoding");
  const decodeAuto = form.watch("hardwareDecodingAuto");
  const throttle = form.watch("throttleEnabled");
  const hardware = acceleration !== "none";
  const selected = findAccelerator(caps.data, acceleration);
  const selectedStatus = selected ? acceleratorStatus(selected.status) : null;

  return (
    <form onSubmit={form.handleSubmit(save)} className="space-y-4" noValidate aria-label="Transcoding settings">
      <div className="grid gap-4 xl:grid-cols-2">
        <SettingsCard icon={<SlidersHorizontal />} title="General" description="Whether the server may transcode at all, and which backend does the heavy lifting.">
          <SwitchRow
            control={form.control}
            name="enabled"
            label="Enable server transcoding"
            description="When off, transcode requests are refused and clients must direct-play."
          />
          <div className="space-y-2">
            <Label htmlFor="acceleration">Acceleration</Label>
            <select id="acceleration" className={selectClassName} aria-describedby="acceleration-hint" {...form.register("acceleration")}>
              {(config.accelerations ?? ["none"]).map((id) => (
                <option key={id} value={id}>
                  {accelerationOption(id, caps.data)}
                </option>
              ))}
            </select>
            <p id="acceleration-hint" className="text-xs leading-5 text-muted-foreground">
              {!hardware
                ? "Every stream is decoded and encoded by ffmpeg on the CPU."
                : selected && selected.status !== "ready"
                  ? `${accelerationLabel(acceleration)}: ${selectedStatus?.label.toLowerCase()} — streams fall back to software until it passes the self-tests.`
                  : `Hardware work runs on ${accelerationLabel(acceleration)}; anything it cannot do falls back to software.`}
            </p>
            {selected && selected.status !== "ready" && (selected.notes ?? []).length > 0 && (
              <ul className="list-disc space-y-0.5 rounded-md border border-amber-500/30 bg-amber-500/10 py-2 pl-7 pr-3 text-xs text-amber-900 dark:text-amber-200">
                {(selected.notes ?? []).map((note) => <li key={note}>{note}</li>)}
              </ul>
            )}
          </div>
          {(acceleration === "vaapi" || acceleration === "qsv") && (
            <Controller
              control={form.control}
              name="vaapiDevice"
              render={({ field }) => (
                <VaapiDeviceField
                  value={field.value}
                  onChange={field.onChange}
                  onBlur={field.onBlur}
                  devices={caps.data?.devices ?? []}
                  backend={acceleration}
                  error={errors.vaapiDevice?.message}
                />
              )}
            />
          )}
          {acceleration === "nvenc" && (
            <Controller
              control={form.control}
              name="nvencDevice"
              render={({ field }) => (
                <NvencDeviceField
                  value={Number(field.value)}
                  onChange={field.onChange}
                  onBlur={field.onBlur}
                  devices={caps.data?.devices ?? []}
                  error={errors.nvencDevice?.message}
                />
              )}
            />
          )}
          {!enabled && (
            <p className="rounded-md bg-muted/60 p-2 text-xs text-muted-foreground" role="status">
              Transcoding is disabled. The remaining values stay saved for when you enable it again.
            </p>
          )}
        </SettingsCard>

        <SettingsCard icon={<Cpu />} title="Hardware pipeline" description={hardware ? `Which stages run on ${accelerationLabel(acceleration)}.` : "Only applies when a hardware backend is selected."}>
          <SwitchRow control={form.control} name="hardwareDecoding" label="Hardware decoding" description="Decode the source on the GPU when the codec passed the self-test." disabled={!hardware} />
          <fieldset className={cn("space-y-2", (!hardware || !hardwareDecoding) && "opacity-60")} disabled={!hardware || !hardwareDecoding}>
            <legend className="text-sm font-medium">Hardware-decoded codecs</legend>
            <Controller
              control={form.control}
              name="hardwareDecodingAuto"
              render={({ field }) => (
                <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Codec selection">
                  <RadioOption name="decode-mode" checked={field.value} onChange={() => field.onChange(true)} label="Every validated codec" description="Follows the latest self-test results automatically." />
                  <RadioOption name="decode-mode" checked={!field.value} onChange={() => field.onChange(false)} label="Choose codecs manually" description="Pin an explicit list, e.g. to avoid a buggy driver." />
                </div>
              )}
            />
            {!decodeAuto && (
              <Controller
                control={form.control}
                name="hardwareDecodingCodecs"
                render={({ field }) => (
                  <ul className="grid grid-cols-2 gap-1.5 sm:grid-cols-4" aria-label="Hardware-decoded codecs">
                    {(config.decodeCodecs ?? []).map((codec) => {
                      const check = selected?.decode?.find((d) => d.codec === codec);
                      const checked = field.value.includes(codec);
                      return (
                        <li key={codec}>
                          <label className="flex cursor-pointer items-center gap-2 rounded-md border px-2 py-1.5 text-xs has-[:checked]:border-lime-500/50 has-[:checked]:bg-lime-500/10" title={check?.detail ?? undefined}>
                            <input
                              type="checkbox"
                              className="size-3.5 accent-lime-600"
                              checked={checked}
                              onChange={(event) =>
                                field.onChange(event.target.checked
                                  ? [...field.value, codec]
                                  : field.value.filter((value) => value !== codec))}
                            />
                            <span className="min-w-0 flex-1 truncate">{codecLabel(codec)}</span>
                            <CheckMark passed={check?.passed} className="[&_svg]:size-3" />
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                )}
              />
            )}
            {decodeAuto && hardware && selected && (
              <p className="text-xs text-muted-foreground">
                Currently validated: {(selected.decode ?? []).filter((d) => d.passed).map((d) => codecLabel(d.codec)).join(", ") || "none"}.
              </p>
            )}
          </fieldset>
          <SwitchRow control={form.control} name="hardwareEncoding" label="Hardware encoding" description="Encode with the GPU encoder; faster but slightly larger files at equal quality." disabled={!hardware} />
          <SwitchRow control={form.control} name="toneMapping" label="HDR tone mapping" description="Convert HDR10/HLG to SDR so non-HDR screens show correct colors." />
          <SwitchRow control={form.control} name="allowHevcOutput" label="Allow HEVC output" description="Send HEVC to clients that declare support; saves bandwidth, costs compatibility." />
        </SettingsCard>

        <SettingsCard icon={<Gauge />} title="Quality" description="Output limits for every transcode. Clients may ask for less, never more.">
          <div className="space-y-2">
            <Label htmlFor="encoderPreset">Encoder preset</Label>
            <select id="encoderPreset" className={selectClassName} aria-describedby="encoderPreset-hint" {...form.register("encoderPreset")}>
              {(config.encoderPresets ?? []).map((preset) => <option key={preset} value={preset}>{preset}</option>)}
            </select>
            <p id="encoderPreset-hint" className="text-xs leading-5 text-muted-foreground">x264/x265 speed–quality trade-off; ignored by hardware encoders.</p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <NumberField id="crf" label="CRF (quality)" unit="crf" min={12} max={40} hint="Lower is better quality; 23 is the x264 default." error={errors.crf?.message} input={form.register("crf")} />
            <NumberField id="maxHeight" label="Max height" unit="px" min={240} max={4_320} hint="2160 = 4K, 1080, 720 …" error={errors.maxHeight?.message} input={form.register("maxHeight")} />
            <NumberField id="maxBitrateKbps" label="Max bitrate" unit="kbps" min={500} max={200_000} hint="Video + audio ceiling per stream." error={errors.maxBitrateKbps?.message} input={form.register("maxBitrateKbps")} />
            <NumberField id="audioBitrateKbps" label="Audio bitrate" unit="kbps" min={64} max={640} hint="AAC bitrate for transcoded audio." error={errors.audioBitrateKbps?.message} input={form.register("audioBitrateKbps")} />
          </div>
          <SwitchRow control={form.control} name="allowSurroundAudio" label="Allow surround audio" description="Keep 5.1 channels for clients that accept them instead of down-mixing to stereo." />
        </SettingsCard>

        <SettingsCard icon={<Waves />} title="Streaming & resources" description="Segmenting, how far ffmpeg may run ahead, and how long idle work is kept.">
          <div className="grid gap-4 sm:grid-cols-2">
            <NumberField id="segmentLengthSeconds" label="Segment length" unit="s" min={2} max={10} hint="Shorter segments start and seek faster." error={errors.segmentLengthSeconds?.message} input={form.register("segmentLengthSeconds")} />
            <NumberField id="maxConcurrentTranscodes" label="Concurrent transcodes" unit="jobs" min={1} max={16} hint="Running ffmpeg processes across all users." error={errors.maxConcurrentTranscodes?.message} input={form.register("maxConcurrentTranscodes")} />
            <NumberField id="maxConcurrentRemuxes" label="Concurrent remuxes" unit="jobs" min={1} max={64} hint="Stream copies (video not re-encoded); counted separately, they need little CPU." error={errors.maxConcurrentRemuxes?.message} input={form.register("maxConcurrentRemuxes")} />
          </div>
          <SwitchRow
            control={form.control}
            name="throttleEnabled"
            label="Throttle ffmpeg ahead of the player"
            description={config.throttleSupported ? "Pause ffmpeg once enough is buffered ahead of the player; saves CPU and disk." : "This platform cannot pause processes; ffmpeg always runs to the end."}
            disabled={!config.throttleSupported}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <NumberField id="throttleBufferSeconds" label="Throttle buffer" unit="s" min={30} max={3_600} hint="Media kept ready ahead of the playhead." error={errors.throttleBufferSeconds?.message} disabled={!throttle || !config.throttleSupported} input={form.register("throttleBufferSeconds")} />
            <NumberField id="threads" label="ffmpeg threads" unit="threads" min={0} max={64} hint="0 lets ffmpeg decide." error={errors.threads?.message} input={form.register("threads")} />
            <NumberField id="jobIdleTimeoutSeconds" label="Job idle timeout" unit="s" min={10} max={3_600} hint="Stop ffmpeg when no segment was requested for this long." error={errors.jobIdleTimeoutSeconds?.message} input={form.register("jobIdleTimeoutSeconds")} />
            <NumberField id="sessionIdleTimeoutSeconds" label="Session idle timeout" unit="s" min={60} max={86_400} hint="Forget an abandoned session and its segments." error={errors.sessionIdleTimeoutSeconds?.message} input={form.register("sessionIdleTimeoutSeconds")} />
            <NumberField id="segmentRetentionSeconds" label="Segment retention" unit="s" min={60} max={86_400} hint="Keep produced segments behind the playhead this long for rewinds." error={errors.segmentRetentionSeconds?.message} input={form.register("segmentRetentionSeconds")} />
          </div>
        </SettingsCard>
      </div>

      <section className="rounded-xl border bg-card p-4" aria-labelledby="host-heading">
        <h3 id="host-heading" className="flex items-center gap-2 text-sm font-semibold">
          <FolderCog className="size-4 text-lime-600 dark:text-lime-400" />
          Host paths
        </h3>
        <p className="mt-0.5 text-xs text-muted-foreground">Read-only — set through <code className="font-mono">Streamarr:Transcoding:*</code> in appsettings or environment variables.</p>
        <dl className="mt-3 grid gap-x-6 gap-y-2 text-xs md:grid-cols-2">
          <HostRow label="ffmpeg" value={config.ffmpegPath} />
          <HostRow label="ffprobe" value={config.ffprobePath} />
          <HostRow label="Workspace" value={config.workspacePath} detail={`${formatBytes(config.workspaceBytes)} of live segments`} />
          <HostRow label="Test samples" value={config.samplesPath} />
        </dl>
      </section>

      <div className="sticky bottom-0 z-10 -mx-1 flex flex-wrap items-center justify-end gap-2 rounded-xl border bg-background/95 p-3 backdrop-blur supports-[backdrop-filter]:bg-background/75">
        <p className="mr-auto text-xs text-muted-foreground" aria-live="polite">
          {form.formState.isDirty ? "Unsaved changes" : "All changes saved"}
        </p>
        <Button type="button" variant="outline" disabled={!form.formState.isDirty || update.isPending} onClick={() => form.reset(toValues(config))}>
          <RotateCcw />Reset
        </Button>
        <Button type="submit" disabled={update.isPending || !form.formState.isDirty}>
          {update.isPending ? <Loader2 className="animate-spin" /> : <Save />}
          Save transcoding settings
        </Button>
      </div>
    </form>
  );
}

function accelerationOption(id: string, caps?: TranscodingCapabilitiesResponse): string {
  if (id === "none") return "Software (CPU) — always available";
  const accelerator = findAccelerator(caps, id);
  return accelerator ? `${accelerationLabel(id)} — ${acceleratorStatus(accelerator.status).label.toLowerCase()}` : accelerationLabel(id);
}

function SettingsCard({ icon, title, description, children }: { icon: ReactNode; title: string; description: string; children: ReactNode }) {
  return (
    <section className="min-w-0 rounded-xl border bg-card" aria-label={title}>
      <header className="border-b bg-muted/20 px-4 py-3 dark:bg-zinc-900/40">
        <h3 className="flex items-center gap-2 text-sm font-semibold [&_svg]:size-4 [&_svg]:text-lime-600 dark:[&_svg]:text-lime-400">
          {icon}
          {title}
        </h3>
        <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{description}</p>
      </header>
      <div className="space-y-5 p-4">{children}</div>
    </section>
  );
}

function SwitchRow({
  control,
  name,
  label,
  description,
  disabled = false,
}: {
  control: Control<Values>;
  name: FieldPath<Values>;
  label: string;
  description: string;
  disabled?: boolean;
}) {
  const id = `switch-${name}`;
  return (
    <div className={cn("flex items-start justify-between gap-4", disabled && "opacity-60")}>
      <div className="min-w-0 space-y-1">
        <Label htmlFor={id}>{label}</Label>
        <p className="text-xs leading-5 text-muted-foreground">{description}</p>
      </div>
      <Controller
        control={control}
        name={name}
        render={({ field }) => (
          <Switch id={id} checked={field.value === true} onCheckedChange={field.onChange} disabled={disabled} aria-label={label} />
        )}
      />
    </div>
  );
}

function RadioOption({
  name,
  checked,
  onChange,
  label,
  description,
}: {
  name: string;
  checked: boolean;
  onChange: () => void;
  label: string;
  description: string;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2 rounded-lg border p-2.5 text-sm has-[:checked]:border-lime-500/50 has-[:checked]:bg-lime-500/10">
      <input type="radio" name={name} className="mt-0.5 accent-lime-600" checked={checked} onChange={onChange} />
      <span>
        <span className="font-medium">{label}</span>
        <span className="block text-xs leading-5 text-muted-foreground">{description}</span>
      </span>
    </label>
  );
}

function NumberField({
  id,
  label,
  unit,
  hint,
  error,
  min,
  max,
  disabled = false,
  input,
}: {
  id: string;
  label: string;
  unit: string;
  hint: string;
  error?: string;
  min: number;
  max: number;
  disabled?: boolean;
  input: UseFormRegisterReturn;
}) {
  const descriptionId = `${id}-${error ? "error" : "hint"}`;
  return (
    <div className="min-w-0 space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <div className="relative">
        <Input
          id={id}
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          readOnly={disabled}
          aria-disabled={disabled}
          aria-invalid={!!error}
          aria-describedby={descriptionId}
          className="pr-16 aria-[disabled=true]:cursor-not-allowed aria-[disabled=true]:opacity-50"
          {...input}
        />
        <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-muted-foreground">{unit}</span>
      </div>
      <p id={descriptionId} className={error ? "text-xs text-destructive" : "text-xs leading-5 text-muted-foreground"}>
        {error ?? hint}
      </p>
    </div>
  );
}

function HostRow({ label, value, detail }: { label: string; value?: string | null; detail?: string }) {
  return (
    <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0">
        <span className="break-all font-mono text-[11px]">{value || "—"}</span>
        {detail && <span className="block text-muted-foreground">{detail}</span>}
      </dd>
    </div>
  );
}
