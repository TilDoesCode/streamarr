import { useEffect } from "react";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useGeneralConfig, useUpdateGeneralConfig } from "@/api/queries";
import type { GeneralConfigWrite } from "@/api/types";
import { errorMessage } from "@/api/client";

// Mirrors the server's GeneralConfigController validation (BRIEF §9.2: "validation mirrors
// server-side validation"): cache/connection/TTL values >= 1, all values integers.
const schema = z.object({
  tmdbApiKey: z.string().optional(),
  sessionTtlSeconds: z.coerce.number().int("Must be a whole number").min(1, "Must be at least 1"),
  ephemeralCacheSizeMb: z.coerce.number().int("Must be a whole number").min(1, "Must be at least 1"),
  searchCacheTtlSeconds: z.coerce.number().int("Must be a whole number").min(0, "Cannot be negative"),
  segmentCacheSizeMb: z.coerce.number().int("Must be a whole number").min(1, "Must be at least 1"),
  connectionBudget: z.coerce.number().int("Must be a whole number").min(1, "Must be at least 1"),
  addStreamarrBadge: z.boolean(),
  addReleaseScoreToName: z.boolean(),
});
type FormValues = z.input<typeof schema>;

const MASK = "••••••••";

export function GeneralSettings() {
  const { data, isLoading, isError, error } = useGeneralConfig();
  const update = useUpdateGeneralConfig();

  const {
    register,
    control,
    handleSubmit,
    reset,
    formState: { errors, isDirty },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      tmdbApiKey: "",
      sessionTtlSeconds: 86_400,
      ephemeralCacheSizeMb: 102_400,
      searchCacheTtlSeconds: 60,
      segmentCacheSizeMb: 512,
      connectionBudget: 20,
      addStreamarrBadge: true,
      addReleaseScoreToName: true,
    },
  });

  useEffect(() => {
    if (data) {
      reset({
        tmdbApiKey: "",
        sessionTtlSeconds: data.sessionTtlSeconds,
        ephemeralCacheSizeMb: data.ephemeralCacheSizeMb,
        searchCacheTtlSeconds: data.searchCacheTtlSeconds,
        segmentCacheSizeMb: data.segmentCacheSizeMb,
        connectionBudget: data.connectionBudget,
        addStreamarrBadge: data.addStreamarrBadge !== false,
        addReleaseScoreToName: data.addReleaseScoreToName !== false,
      });
    }
  }, [data, reset]);

  async function onSubmit(values: FormValues) {
    const parsed = schema.parse(values);
    // TMDB key is write-only (BRIEF §6.3): only send it when the operator typed a new value,
    // otherwise omit so the stored secret is left unchanged (server omit-to-keep).
    const body: GeneralConfigWrite = {
      sessionTtlSeconds: parsed.sessionTtlSeconds,
      ephemeralCacheSizeMb: parsed.ephemeralCacheSizeMb,
      searchCacheTtlSeconds: parsed.searchCacheTtlSeconds,
      segmentCacheSizeMb: parsed.segmentCacheSizeMb,
      connectionBudget: parsed.connectionBudget,
      addStreamarrBadge: parsed.addStreamarrBadge,
      addReleaseScoreToName: parsed.addReleaseScoreToName,
    };
    const typedKey = parsed.tmdbApiKey?.trim();
    if (typedKey) body.tmdbApiKey = typedKey;

    try {
      await update.mutateAsync(body);
      toast.success("General settings saved.");
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  if (isLoading) return <SettingsSkeleton />;
  if (isError) {
    return (
      <Card>
        <CardContent className="pt-6 text-sm text-destructive">{errorMessage(error)}</CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>General</CardTitle>
        <CardDescription>
          TMDB credential, ephemeral-file retention, search/segment caches, and the global NNTP
          connection budget (BRIEF §6.3). TMDB credentials and artwork marking take effect
          immediately; resource limits apply on restart.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-5" noValidate>
          <Field
            id="tmdbApiKey"
            label="TMDB credential"
            hint={
              data?.hasTmdbApiKey
                ? "An API key or Read Access Token is configured. Leave blank to keep it, or type a replacement."
                : "Enter either the short v3 API key or the API Read Access Token (JWT) from TMDB."
            }
            error={errors.tmdbApiKey?.message}
          >
            <Input
              id="tmdbApiKey"
              type="password"
              autoComplete="off"
              placeholder={data?.hasTmdbApiKey ? MASK : "API key or read access token"}
              aria-invalid={!!errors.tmdbApiKey}
              {...register("tmdbApiKey")}
            />
          </Field>

          <div className="grid gap-5 sm:grid-cols-2">
            <Field
              id="sessionTtlSeconds"
              label="Ephemeral file expiry (seconds)"
              hint="Hard maximum age from creation. File access does not extend it."
              error={errors.sessionTtlSeconds?.message}
            >
              <Input id="sessionTtlSeconds" type="number" min={1} aria-invalid={!!errors.sessionTtlSeconds} {...register("sessionTtlSeconds")} />
            </Field>
            <Field
              id="ephemeralCacheSizeMb"
              label="Ephemeral file cache (MB)"
              hint="Full decoded file sizes count toward this budget. The least recently accessed file is evicted first; one oversized file may exceed it."
              error={errors.ephemeralCacheSizeMb?.message}
            >
              <Input id="ephemeralCacheSizeMb" type="number" min={1} aria-invalid={!!errors.ephemeralCacheSizeMb} {...register("ephemeralCacheSizeMb")} />
            </Field>
            <Field
              id="searchCacheTtlSeconds"
              label="Search cache TTL (seconds)"
              error={errors.searchCacheTtlSeconds?.message}
            >
              <Input id="searchCacheTtlSeconds" type="number" min={0} aria-invalid={!!errors.searchCacheTtlSeconds} {...register("searchCacheTtlSeconds")} />
            </Field>
            <Field
              id="segmentCacheSizeMb"
              label="Segment cache size (MB)"
              error={errors.segmentCacheSizeMb?.message}
            >
              <Input id="segmentCacheSizeMb" type="number" min={1} aria-invalid={!!errors.segmentCacheSizeMb} {...register("segmentCacheSizeMb")} />
            </Field>
            <Field
              id="connectionBudget"
              label="NNTP connection budget"
              hint="Shared across all live sessions."
              error={errors.connectionBudget?.message}
            >
              <Input id="connectionBudget" type="number" min={1} aria-invalid={!!errors.connectionBudget} {...register("connectionBudget")} />
            </Field>
          </div>

          <div className="grid gap-3 lg:grid-cols-2">
            <div className="flex items-start justify-between gap-6 rounded-lg border bg-muted/25 p-4">
              <div className="space-y-1">
                <Label htmlFor="addStreamarrBadge">Mark Streamarr artwork</Label>
                <p className="max-w-xl text-xs leading-relaxed text-muted-foreground">
                  Add a crisp adaptive Streamarr icon to the top-left of work covers in Jellyfin.
                </p>
              </div>
              <Controller
                name="addStreamarrBadge"
                control={control}
                render={({ field }) => (
                  <Switch
                    id="addStreamarrBadge"
                    checked={field.value}
                    onCheckedChange={field.onChange}
                    aria-label="Mark Streamarr artwork"
                  />
                )}
              />
            </div>

            <div className="flex items-start justify-between gap-6 rounded-lg border bg-muted/25 p-4">
              <div className="space-y-1">
                <Label htmlFor="addReleaseScoreToName">Show release scores</Label>
                <p className="max-w-xl text-xs leading-relaxed text-muted-foreground">
                  Append the Core ranking score to each Jellyfin version name.
                </p>
              </div>
              <Controller
                name="addReleaseScoreToName"
                control={control}
                render={({ field }) => (
                  <Switch
                    id="addReleaseScoreToName"
                    checked={field.value}
                    onCheckedChange={field.onChange}
                    aria-label="Show release scores"
                  />
                )}
              />
            </div>
          </div>

          <div className="flex justify-end">
            <Button type="submit" disabled={update.isPending || !isDirty}>
              {update.isPending && <Loader2 className="size-4 animate-spin" />}
              Save changes
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {error ? (
        <p className="text-xs text-destructive">{error}</p>
      ) : hint ? (
        <p className="text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

function SettingsSkeleton() {
  return (
    <Card>
      <CardContent className="space-y-4 pt-6">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-9 w-full animate-pulse rounded-md bg-muted" />
        ))}
      </CardContent>
    </Card>
  );
}
