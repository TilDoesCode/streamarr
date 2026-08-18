import { useEffect } from "react";
import {
  Controller,
  useForm,
  type Control,
  type UseFormRegisterReturn,
} from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Clock3, Download, Film, Gauge, Loader2, ShieldCheck, Tv } from "lucide-react";
import { toast } from "sonner";
import { errorMessage } from "@/api/client";
import { usePreDownloadConfig, useUpdatePreDownloadConfig } from "@/api/queries";
import type { PreDownloadConfigWrite } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

const schema = z.object({
  enabled: z.boolean(),
  downloadCurrentFile: z.boolean(),
  currentFileThresholdSeconds: z.coerce
    .number()
    .int("Must be a whole number")
    .min(0, "Cannot be negative")
    .max(3_600, "Must not exceed 3600 seconds"),
  downloadNextEpisode: z.boolean(),
  nextEpisodeThresholdPercent: z.coerce
    .number()
    .int("Must be a whole number")
    .min(1, "Must be at least 1 percent")
    .max(100, "Must not exceed 100 percent"),
  maxConcurrentDownloads: z.coerce
    .number()
    .int("Must be a whole number")
    .min(1, "Must be at least 1")
    .max(8, "Must not exceed 8"),
});

type Values = z.input<typeof schema>;

const defaults: Values = {
  enabled: false,
  downloadCurrentFile: true,
  currentFileThresholdSeconds: 10,
  downloadNextEpisode: true,
  nextEpisodeThresholdPercent: 75,
  maxConcurrentDownloads: 1,
};

export function PreDownloadSettings() {
  const query = usePreDownloadConfig();
  const update = useUpdatePreDownloadConfig();
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: defaults,
  });

  useEffect(() => {
    if (!query.data) return;
    form.reset({
      enabled: query.data.enabled ?? defaults.enabled,
      downloadCurrentFile: query.data.downloadCurrentFile ?? defaults.downloadCurrentFile,
      currentFileThresholdSeconds:
        query.data.currentFileThresholdSeconds ?? defaults.currentFileThresholdSeconds,
      downloadNextEpisode: query.data.downloadNextEpisode ?? defaults.downloadNextEpisode,
      nextEpisodeThresholdPercent:
        query.data.nextEpisodeThresholdPercent ?? defaults.nextEpisodeThresholdPercent,
      maxConcurrentDownloads:
        query.data.maxConcurrentDownloads ?? defaults.maxConcurrentDownloads,
    });
  }, [form, query.data]);

  const enabled = form.watch("enabled");
  const downloadCurrentFile = form.watch("downloadCurrentFile");
  const downloadNextEpisode = form.watch("downloadNextEpisode");

  async function save(raw: Values) {
    const parsed = schema.parse(raw);
    const body: PreDownloadConfigWrite = parsed;
    try {
      await update.mutateAsync(body);
      toast.success("Pre-download settings saved.");
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  if (query.isLoading) return <PreDownloadSettingsSkeleton />;
  if (query.isError) {
    return (
      <Card>
        <CardContent className="flex items-start gap-2 pt-6 text-sm text-destructive" role="alert">
          <Download className="mt-0.5 size-4 shrink-0" />
          {errorMessage(query.error)}
        </CardContent>
      </Card>
    );
  }

  return (
    <form onSubmit={form.handleSubmit(save)} className="space-y-4" noValidate>
      <Card className="overflow-hidden">
        <CardHeader className="border-b bg-muted/20">
          <div className="flex items-start justify-between gap-5">
            <div className="space-y-1.5">
              <CardTitle className="flex items-center gap-2">
                <Download className="size-5 text-primary" />
                Pre-download
              </CardTitle>
              <CardDescription className="max-w-2xl leading-6">
                Fill the ephemeral cache in the background after playback demonstrates real intent.
                Playback position controls the episode trigger; download progress never does.
              </CardDescription>
            </div>
            <Controller
              name="enabled"
              control={form.control}
              render={({ field }) => (
                <Switch
                  id="preDownloadEnabled"
                  checked={field.value}
                  onCheckedChange={field.onChange}
                  aria-label="Enable pre-download"
                />
              )}
            />
          </div>
        </CardHeader>
        <CardContent className="pt-6">
          <div
            className="flex items-start gap-3 rounded-lg border bg-background/70 p-4"
            role="status"
          >
            <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
              {enabled ? <ShieldCheck className="size-4" /> : <Clock3 className="size-4" />}
            </span>
            <div>
              <p className="text-sm font-medium">
                {enabled ? "Background caching is active" : "Background caching is paused"}
              </p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                {enabled
                  ? "Enabled rules may create low-priority cache fills when their playback trigger is reached."
                  : "No new pre-download work will be scheduled. Your rule values remain saved for the next time you enable it."}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        <RuleCard
          icon={<Film />}
          title="Finish the current file"
          description="Once playback has remained active beyond the grace period, continue filling the current movie or episode."
          enabled={downloadCurrentFile}
          globallyEnabled={enabled}
          switchId="downloadCurrentFile"
          switchLabel="Download the current file"
          control={form.control}
          name="downloadCurrentFile"
        >
          <NumberField
            id="currentFileThresholdSeconds"
            label="Playback grace period"
            unit="seconds"
            hint="0 starts immediately; 10 seconds avoids treating a quick playback test as intent."
            error={form.formState.errors.currentFileThresholdSeconds?.message}
            disabled={!enabled || !downloadCurrentFile}
            min={0}
            max={3_600}
            input={form.register("currentFileThresholdSeconds")}
          />
        </RuleCard>

        <RuleCard
          icon={<Tv />}
          title="Prepare the next episode"
          description="For shows, resolve and cache the immediate next episode after watched playback crosses the threshold."
          enabled={downloadNextEpisode}
          globallyEnabled={enabled}
          switchId="downloadNextEpisode"
          switchLabel="Download the next episode"
          control={form.control}
          name="downloadNextEpisode"
        >
          <NumberField
            id="nextEpisodeThresholdPercent"
            label="Watch-progress trigger"
            unit="percent"
            hint="Uses client-reported watch position and runtime, not bytes downloaded or cached."
            error={form.formState.errors.nextEpisodeThresholdPercent?.message}
            disabled={!enabled || !downloadNextEpisode}
            min={1}
            max={100}
            input={form.register("nextEpisodeThresholdPercent")}
          />
        </RuleCard>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Gauge className="size-5 text-primary" />
            Background resource policy
          </CardTitle>
          <CardDescription className="max-w-3xl leading-6">
            Pre-download work stays below active playback in transport priority. Implicit files
            also have lower retention priority, while still sharing the hard expiry and total
            ephemeral-cache budget configured under General.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-5 md:grid-cols-[minmax(0,18rem)_minmax(0,1fr)] md:items-end">
          <NumberField
            id="maxConcurrentDownloads"
            label="Concurrent pre-downloads"
            unit="jobs"
            hint="A small limit protects active streams and the shared NNTP connection budget."
            error={form.formState.errors.maxConcurrentDownloads?.message}
            disabled={!enabled}
            min={1}
            max={8}
            input={form.register("maxConcurrentDownloads")}
          />
          <div className="grid gap-2 rounded-lg border bg-muted/20 p-4 text-xs text-muted-foreground sm:grid-cols-2">
            <PolicyLine label="Transport priority" value="Background" />
            <PolicyLine label="Retention priority" value="Lower than explicit playback" />
            <PolicyLine label="Expiry" value="Shared ephemeral hard TTL" />
            <PolicyLine label="Storage ceiling" value="Shared ephemeral byte budget" />
          </div>
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button type="submit" disabled={update.isPending || !form.formState.isDirty}>
          {update.isPending && <Loader2 className="size-4 animate-spin" />}
          Save pre-download settings
        </Button>
      </div>
    </form>
  );
}

function RuleCard({
  icon,
  title,
  description,
  enabled,
  globallyEnabled,
  switchId,
  switchLabel,
  control,
  name,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  enabled: boolean;
  globallyEnabled: boolean;
  switchId: string;
  switchLabel: string;
  control: Control<Values>;
  name: "downloadCurrentFile" | "downloadNextEpisode";
  children: React.ReactNode;
}) {
  return (
    <Card className={!globallyEnabled ? "bg-muted/10" : undefined}>
      <CardHeader>
        <div className="flex items-start justify-between gap-5">
          <div className="space-y-1.5">
            <CardTitle className="flex items-center gap-2 [&_svg]:size-5 [&_svg]:text-primary">
              {icon}
              {title}
            </CardTitle>
            <CardDescription className="leading-6">{description}</CardDescription>
          </div>
          <Controller
            name={name}
            control={control}
            render={({ field }) => (
              <Switch
                id={switchId}
                checked={field.value}
                onCheckedChange={field.onChange}
                disabled={!globallyEnabled}
                aria-label={switchLabel}
              />
            )}
          />
        </div>
      </CardHeader>
      <CardContent className={!enabled || !globallyEnabled ? "opacity-65" : undefined}>
        {children}
      </CardContent>
    </Card>
  );
}

function NumberField({
  id,
  label,
  unit,
  hint,
  error,
  disabled,
  min,
  max,
  input,
}: {
  id: string;
  label: string;
  unit: string;
  hint: string;
  error?: string;
  disabled: boolean;
  min: number;
  max: number;
  input: UseFormRegisterReturn;
}) {
  const descriptionId = `${id}-${error ? "error" : "hint"}`;
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <div className="relative">
        <Input
          id={id}
          type="number"
          min={min}
          max={max}
          readOnly={disabled}
          aria-disabled={disabled}
          aria-invalid={!!error}
          aria-describedby={descriptionId}
          className="pr-20 aria-[disabled=true]:cursor-not-allowed aria-[disabled=true]:opacity-50"
          {...input}
        />
        <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-muted-foreground">
          {unit}
        </span>
      </div>
      <p
        id={descriptionId}
        className={error ? "text-xs text-destructive" : "text-xs leading-5 text-muted-foreground"}
      >
        {error ?? hint}
      </p>
    </div>
  );
}

function PolicyLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border/70 pb-2 last:border-b-0 sm:block sm:border-b-0 sm:pb-0">
      <span>{label}</span>
      <span className="text-right font-medium text-foreground sm:mt-1 sm:block sm:text-left">{value}</span>
    </div>
  );
}

function PreDownloadSettingsSkeleton() {
  return (
    <div className="space-y-4" aria-label="Loading pre-download settings">
      <div className="h-40 animate-pulse rounded-lg border bg-muted/30" />
      <div className="grid gap-4 xl:grid-cols-2">
        <div className="h-60 animate-pulse rounded-lg border bg-muted/30" />
        <div className="h-60 animate-pulse rounded-lg border bg-muted/30" />
      </div>
      <div className="h-56 animate-pulse rounded-lg border bg-muted/30" />
    </div>
  );
}
