import { useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  ArrowLeft,
  Check,
  Download,
  Film,
  Loader2,
  Lock,
  Play,
  Plus,
  Server,
  SlidersHorizontal,
  Trash2,
  Tv,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  useCreateProfile,
  useDebugSearch,
  useDeleteProfile,
  useImportProfiles,
  usePreviewProfileImport,
  useProfiles,
  useUpdateProfile,
} from "@/api/queries";
import type { DebugReleaseDto, ProfileImportCandidate, QualityProfile } from "@/api/types";
import { cn } from "@/lib/utils";
import { errorMessage } from "@/api/client";

const schema = z.object({
  name: z.string().trim().min(1, "A name is required"),
  appliesTo: z.enum(["both", "movies", "shows"]),
  preferredResolutions: z.string().optional(),
  preferredSources: z.string().optional(),
  preferredCodecs: z.string().optional(),
  preferredLanguages: z.string().optional(),
  groupAllowList: z.string().optional(),
  groupDenyList: z.string().optional(),
  resolutionWeight: z.coerce.number().int("Whole number"),
  sourceWeight: z.coerce.number().int("Whole number"),
  codecWeight: z.coerce.number().int("Whole number"),
  languageWeight: z.coerce.number().int("Whole number"),
  audioWeight: z.coerce.number().int("Whole number"),
  sizeWeight: z.coerce.number().int("Whole number"),
  properRepackBonus: z.coerce.number().int("Whole number"),
  recencyBonus: z.coerce.number().int("Whole number"),
  grabsBonus: z.coerce.number().int("Whole number"),
  groupAllowBonus: z.coerce.number().int("Whole number"),
  groupDenyPenalty: z.coerce.number().int("Whole number"),
  minBytesPerMinute: z.coerce.number().int("Whole number").min(0, "Cannot be negative"),
  maxBytesPerMinute: z.coerce.number().int("Whole number").min(0, "Cannot be negative"),
});
type FormValues = z.input<typeof schema>;
type ProfileScope = "both" | "movies" | "shows";
type ImportSource = "radarr" | "sonarr";

interface BandRow {
  resolution: string;
  min: number;
  max: number;
}

const csv = (s?: string): string[] =>
  (s ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

function toForm(p: QualityProfile): FormValues {
  return {
    name: p.name ?? "",
    appliesTo: (p.appliesTo as ProfileScope | undefined) ?? "both",
    preferredResolutions: (p.preferredResolutions ?? []).join(", "),
    preferredSources: (p.preferredSources ?? []).join(", "),
    preferredCodecs: (p.preferredCodecs ?? []).join(", "),
    preferredLanguages: (p.preferredLanguages ?? []).join(", "),
    groupAllowList: (p.groupAllowList ?? []).join(", "),
    groupDenyList: (p.groupDenyList ?? []).join(", "),
    resolutionWeight: p.resolutionWeight ?? 100,
    sourceWeight: p.sourceWeight ?? 80,
    codecWeight: p.codecWeight ?? 40,
    languageWeight: p.languageWeight ?? 60,
    audioWeight: p.audioWeight ?? 30,
    sizeWeight: p.sizeWeight ?? 20,
    properRepackBonus: p.properRepackBonus ?? 20,
    recencyBonus: p.recencyBonus ?? 10,
    grabsBonus: p.grabsBonus ?? 10,
    groupAllowBonus: p.groupAllowBonus ?? 50,
    groupDenyPenalty: p.groupDenyPenalty ?? 100000,
    minBytesPerMinute: p.minBytesPerMinute ?? 3000000,
    maxBytesPerMinute: p.maxBytesPerMinute ?? 1500000000,
  };
}

function bandsOf(p: QualityProfile): BandRow[] {
  return Object.entries(p.sizeBands ?? {}).map(([resolution, band]) => ({
    resolution,
    min: band.minBytesPerMinute ?? 0,
    max: band.maxBytesPerMinute ?? 0,
  }));
}

function buildDraft(values: FormValues, bands: BandRow[], base: QualityProfile | null): QualityProfile {
  const parsed = schema.parse(values);
  const sizeBands: Record<string, { minBytesPerMinute: number; maxBytesPerMinute: number }> = {};
  for (const b of bands) {
    if (b.resolution.trim())
      sizeBands[b.resolution.trim()] = { minBytesPerMinute: b.min, maxBytesPerMinute: b.max };
  }
  return {
    id: base && !base.isDefault ? base.id : undefined,
    name: parsed.name,
    appliesTo: parsed.appliesTo,
    importedFrom: base?.importedFrom,
    importedProfileId: base?.importedProfileId,
    importedAtUtc: base?.importedAtUtc,
    preferredResolutions: csv(parsed.preferredResolutions),
    preferredSources: csv(parsed.preferredSources),
    preferredCodecs: csv(parsed.preferredCodecs),
    preferredLanguages: csv(parsed.preferredLanguages),
    groupAllowList: csv(parsed.groupAllowList),
    groupDenyList: csv(parsed.groupDenyList),
    resolutionWeight: parsed.resolutionWeight,
    sourceWeight: parsed.sourceWeight,
    codecWeight: parsed.codecWeight,
    languageWeight: parsed.languageWeight,
    audioWeight: parsed.audioWeight,
    sizeWeight: parsed.sizeWeight,
    properRepackBonus: parsed.properRepackBonus,
    recencyBonus: parsed.recencyBonus,
    grabsBonus: parsed.grabsBonus,
    groupAllowBonus: parsed.groupAllowBonus,
    groupDenyPenalty: parsed.groupDenyPenalty,
    customFormats: base?.customFormats ?? [],
    minimumCustomFormatScore: base?.minimumCustomFormatScore ?? 0,
    minBytesPerMinute: parsed.minBytesPerMinute,
    maxBytesPerMinute: parsed.maxBytesPerMinute,
    sizeBands,
    isDefault: false,
  };
}

export function ProfilesPage() {
  const { data, isLoading, isError, error } = useProfiles();
  const profiles = data ?? [];
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draftNew, setDraftNew] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  // Default the selection to the first profile once loaded.
  useEffect(() => {
    if (!selectedId && !draftNew && profiles.length > 0) setSelectedId(profiles[0].id ?? null);
  }, [profiles, selectedId, draftNew]);

  const selected = useMemo<QualityProfile | null>(() => {
    if (draftNew) return null;
    return profiles.find((p) => p.id === selectedId) ?? null;
  }, [profiles, selectedId, draftNew]);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Quality Profiles</h2>
          <p className="text-sm text-muted-foreground">
            Tune release ranking for movies, shows, or both — or bring your existing Arr setup
            across in one pass.
          </p>
        </div>
        <Button variant="outline" className="shrink-0" onClick={() => setImportOpen(true)}>
          <Download className="size-4" />
          Import from Arr
        </Button>
      </div>

      <ProfileImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        onImported={(id) => {
          setDraftNew(false);
          setSelectedId(id);
        }}
      />

      {isLoading ? (
        <div className="h-64 w-full animate-pulse rounded-lg bg-muted" />
      ) : isError ? (
        <Card>
          <CardContent className="pt-6 text-sm text-destructive">{errorMessage(error)}</CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-[14rem_1fr]">
          <ProfileList
            profiles={profiles}
            selectedId={draftNew ? null : selectedId}
            onSelect={(id) => {
              setDraftNew(false);
              setSelectedId(id);
            }}
            onNew={() => {
              setDraftNew(true);
              setSelectedId(null);
            }}
          />
          <ProfileEditor
            key={draftNew ? "new" : (selected?.id ?? "none")}
            profile={selected}
            isNew={draftNew}
            onSaved={(id) => {
              setDraftNew(false);
              setSelectedId(id);
            }}
            onDeleted={() => {
              setDraftNew(false);
              setSelectedId(profiles.find((p) => p.id !== selected?.id)?.id ?? null);
            }}
          />
        </div>
      )}
    </div>
  );
}

function ProfileList({
  profiles,
  selectedId,
  onSelect,
  onNew,
}: {
  profiles: QualityProfile[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
}) {
  return (
    <div className="space-y-2">
      <ul className="space-y-1" aria-label="Quality profiles">
        {profiles.map((p) => (
          <li key={p.id}>
            <button
              type="button"
              onClick={() => onSelect(p.id!)}
              aria-current={selectedId === p.id ? "true" : undefined}
              className={cn(
                "flex w-full items-center justify-between gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors",
                selectedId === p.id
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:bg-accent/50",
              )}
            >
              <span className="truncate font-medium">{p.name}</span>
              <span className="flex shrink-0 items-center gap-1">
                {p.importedFrom && (
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    {p.importedFrom}
                  </span>
                )}
                <ScopeIcon scope={(p.appliesTo as ProfileScope | undefined) ?? "both"} />
                {p.isDefault && <Lock className="size-3.5" />}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <Button variant="outline" size="sm" className="w-full" onClick={onNew}>
        <Plus className="size-4" />
        New profile
      </Button>
    </div>
  );
}

function ScopeIcon({ scope }: { scope: ProfileScope }) {
  if (scope === "movies") return <Film className="size-3.5 text-muted-foreground" aria-hidden />;
  if (scope === "shows") return <Tv className="size-3.5 text-muted-foreground" aria-hidden />;
  return (
    <span className="flex -space-x-0.5 text-muted-foreground" aria-hidden>
      <Film className="size-3.5" />
      <Tv className="size-3.5" />
    </span>
  );
}

function ScopeSelector({
  value,
  onChange,
  disabled,
  compact = false,
}: {
  value: ProfileScope;
  onChange: (value: ProfileScope) => void;
  disabled?: boolean;
  compact?: boolean;
}) {
  const options: Array<{ value: ProfileScope; label: string; icon: React.ReactNode }> = [
    { value: "movies", label: "Movies", icon: <Film /> },
    { value: "shows", label: "Shows", icon: <Tv /> },
    {
      value: "both",
      label: "Both",
      icon: (
        <span className="flex -space-x-1">
          <Film />
          <Tv />
        </span>
      ),
    },
  ];

  return (
    <div className="grid grid-cols-3 gap-1 rounded-lg border bg-muted/40 p-1" role="group" aria-label="Profile media scope">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          disabled={disabled}
          onClick={() => onChange(option.value)}
          className={cn(
            "flex items-center justify-center gap-2 rounded-md font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60",
            compact ? "h-8 px-2 text-xs" : "h-10 px-3 text-sm",
            value === option.value
              ? "bg-background text-foreground shadow-sm ring-1 ring-border"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          <span className="[&_svg]:size-3.5">{option.icon}</span>
          {option.label}
        </button>
      ))}
    </div>
  );
}

function ProfileImportDialog({
  open,
  onOpenChange,
  onImported,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported: (id: string) => void;
}) {
  const preview = usePreviewProfileImport();
  const importProfiles = useImportProfiles();
  const [source, setSource] = useState<ImportSource>("radarr");
  const [baseUrl, setBaseUrl] = useState("http://radarr:7878");
  const [apiKey, setApiKey] = useState("");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [scopes, setScopes] = useState<Record<number, ProfileScope>>({});

  const candidates = preview.data?.profiles ?? [];

  function reset() {
    preview.reset();
    importProfiles.reset();
    setApiKey("");
    setSelected(new Set());
    setScopes({});
  }

  function changeOpen(next: boolean) {
    if (!next) reset();
    onOpenChange(next);
  }

  function chooseSource(next: ImportSource) {
    setSource(next);
    setBaseUrl(next === "radarr" ? "http://radarr:7878" : "http://sonarr:8989");
    preview.reset();
    setSelected(new Set());
    setScopes({});
  }

  async function connect() {
    try {
      const result = await preview.mutateAsync({ source, baseUrl: baseUrl.trim(), apiKey });
      const profiles = result.profiles ?? [];
      setSelected(new Set(profiles.map((profile) => profile.externalId ?? 0)));
      setScopes(
        Object.fromEntries(
          profiles.map((profile) => [
            profile.externalId ?? 0,
            (profile.suggestedAppliesTo as ProfileScope | null) ?? (source === "radarr" ? "movies" : "shows"),
          ]),
        ),
      );
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  function toggleProfile(id: number) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function finishImport() {
    if (selected.size === 0) {
      toast.error("Select at least one profile.");
      return;
    }
    try {
      const created = await importProfiles.mutateAsync({
        source,
        baseUrl: baseUrl.trim(),
        apiKey,
        profiles: [...selected].map((externalId) => ({
          externalId,
          appliesTo: scopes[externalId] ?? (source === "radarr" ? "movies" : "shows"),
        })),
      });
      toast.success(
        `Imported ${created.length} profile${created.length === 1 ? "" : "s"} from ${preview.data?.instanceName ?? source}.`,
      );
      const firstId = created[0]?.id;
      changeOpen(false);
      if (firstId) onImported(firstId);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent className="max-w-3xl overflow-hidden p-0">
        <div className="border-b bg-gradient-to-r from-muted/80 via-background to-background px-6 py-5">
          <DialogHeader>
            <div className="mb-2 flex size-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <Download className="size-5" />
            </div>
            <DialogTitle>Import scoring profiles</DialogTitle>
            <DialogDescription>
              Connect directly to Sonarr or Radarr. Streamarr imports quality order, minimum score,
              and matching custom-format rules; the API key is used once and never stored.
            </DialogDescription>
          </DialogHeader>
        </div>

        {!preview.data ? (
          <div className="space-y-5 px-6 pb-6">
            <div className="grid grid-cols-2 gap-2">
              {(["radarr", "sonarr"] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  aria-pressed={source === option}
                  onClick={() => chooseSource(option)}
                  className={cn(
                    "flex items-center gap-3 rounded-xl border p-4 text-left transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    source === option
                      ? "border-primary/50 bg-primary/5 shadow-sm"
                      : "hover:border-foreground/20 hover:bg-muted/40",
                  )}
                >
                  <span className={cn(
                    "flex size-9 items-center justify-center rounded-lg",
                    option === "radarr" ? "bg-amber-500/15 text-amber-600 dark:text-amber-400" : "bg-sky-500/15 text-sky-600 dark:text-sky-400",
                  )}>
                    {option === "radarr" ? <Film className="size-4" /> : <Tv className="size-4" />}
                  </span>
                  <span>
                    <span className="block text-sm font-semibold capitalize">{option}</span>
                    <span className="block text-xs text-muted-foreground">
                      {option === "radarr" ? "Movie profiles" : "Series profiles"}
                    </span>
                  </span>
                  {source === option && <Check className="ml-auto size-4 text-primary" />}
                </button>
              ))}
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field id="arr-base-url" label={`${source === "radarr" ? "Radarr" : "Sonarr"} URL`}>
                <div className="relative">
                  <Server className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    id="arr-base-url"
                    className="pl-9"
                    value={baseUrl}
                    onChange={(event) => setBaseUrl(event.target.value)}
                    autoComplete="url"
                  />
                </div>
              </Field>
              <Field id="arr-api-key" label="API key" hint="Settings → General → Security">
                <Input
                  id="arr-api-key"
                  type="password"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  autoComplete="off"
                  placeholder="Paste the API key"
                />
              </Field>
            </div>

            {preview.isError && (
              <p className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                {errorMessage(preview.error)}
              </p>
            )}

            <DialogFooter>
              <Button variant="outline" onClick={() => changeOpen(false)}>Cancel</Button>
              <Button onClick={connect} disabled={preview.isPending || !baseUrl.trim() || !apiKey.trim()}>
                {preview.isPending && <Loader2 className="size-4 animate-spin" />}
                Connect &amp; inspect
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="space-y-4 px-6 pb-6">
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-muted/35 px-3 py-2">
              <div className="flex items-center gap-2 text-sm">
                <span className="relative flex size-2">
                  <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-60" />
                  <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
                </span>
                <span className="font-medium">{preview.data.instanceName}</span>
                {preview.data.version && <span className="text-muted-foreground">v{preview.data.version}</span>}
              </div>
              <span className="text-xs text-muted-foreground">
                {candidates.length} profile{candidates.length === 1 ? "" : "s"} found
              </span>
            </div>

            <div className="max-h-[23rem] space-y-2 overflow-y-auto pr-1">
              {candidates.length === 0 && (
                <p className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
                  No quality profiles were returned by this instance.
                </p>
              )}
              {candidates.map((candidate) => (
                <ImportCandidateRow
                  key={candidate.externalId}
                  candidate={candidate}
                  selected={selected.has(candidate.externalId ?? 0)}
                  scope={scopes[candidate.externalId ?? 0] ?? (source === "radarr" ? "movies" : "shows")}
                  onToggle={() => toggleProfile(candidate.externalId ?? 0)}
                  onScope={(scope) => setScopes((current) => ({ ...current, [candidate.externalId ?? 0]: scope }))}
                />
              ))}
            </div>

            {importProfiles.isError && (
              <p className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                {errorMessage(importProfiles.error)}
              </p>
            )}

            <DialogFooter className="items-center sm:justify-between">
              <Button variant="ghost" onClick={() => preview.reset()} disabled={importProfiles.isPending}>
                <ArrowLeft className="size-4" />
                Connection
              </Button>
              <Button onClick={finishImport} disabled={importProfiles.isPending || selected.size === 0}>
                {importProfiles.isPending && <Loader2 className="size-4 animate-spin" />}
                Import {selected.size || "selected"}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ImportCandidateRow({
  candidate,
  selected,
  scope,
  onToggle,
  onScope,
}: {
  candidate: ProfileImportCandidate;
  selected: boolean;
  scope: ProfileScope;
  onToggle: () => void;
  onScope: (scope: ProfileScope) => void;
}) {
  return (
    <div className={cn(
      "grid gap-3 rounded-xl border p-3 transition-colors sm:grid-cols-[1fr_17rem] sm:items-center",
      selected ? "border-primary/35 bg-primary/[0.035]" : "opacity-65",
    )}>
      <div className="flex min-w-0 items-start gap-3">
        <button
          type="button"
          aria-label={`${selected ? "Deselect" : "Select"} ${candidate.name}`}
          aria-pressed={selected}
          onClick={onToggle}
          className={cn(
            "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            selected ? "border-primary bg-primary text-primary-foreground" : "bg-background",
          )}
        >
          {selected && <Check className="size-3.5" />}
        </button>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{candidate.name}</p>
          <div className="mt-1 flex flex-wrap gap-1.5">
            <Badge variant="muted">{candidate.qualityCount ?? 0} qualities</Badge>
            <Badge variant="muted">{candidate.scoredFormatCount ?? 0} scored formats</Badge>
            {(candidate.profile.minimumCustomFormatScore ?? 0) !== 0 && (
              <Badge variant="outline">min {candidate.profile.minimumCustomFormatScore}</Badge>
            )}
          </div>
          {(candidate.unsupportedConditionCount ?? 0) > 0 && (
            <p className="mt-1.5 text-[11px] text-amber-600 dark:text-amber-400">
              {candidate.unsupportedConditionCount} Arr-only condition{candidate.unsupportedConditionCount === 1 ? "" : "s"} kept as non-matching
            </p>
          )}
        </div>
      </div>
      <ScopeSelector value={scope} onChange={onScope} compact disabled={!selected} />
    </div>
  );
}

function ImportedFormatSummary({ profile }: { profile: QualityProfile }) {
  const formats = profile.customFormats ?? [];
  return (
    <div className="rounded-xl border bg-muted/25 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold">Imported scoring</h3>
          <p className="text-xs text-muted-foreground">
            Exact custom-format scores from <span className="capitalize">{profile.importedFrom}</span>
            {profile.importedProfileId ? ` profile #${profile.importedProfileId}` : ""}.
          </p>
        </div>
        <Badge variant="outline">minimum {profile.minimumCustomFormatScore ?? 0}</Badge>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {formats.slice(0, 10).map((format, index) => (
          <span
            key={`${format.name}-${index}`}
            className="inline-flex items-center gap-1.5 rounded-md border bg-background px-2 py-1 text-xs"
          >
            <span className="max-w-48 truncate">{format.name}</span>
            <span className={cn(
              "font-mono font-semibold tabular-nums",
              (format.score ?? 0) < 0 ? "text-destructive" : "text-emerald-600 dark:text-emerald-400",
            )}>
              {(format.score ?? 0) > 0 ? "+" : ""}{format.score ?? 0}
            </span>
          </span>
        ))}
        {formats.length > 10 && (
          <span className="rounded-md border border-dashed px-2 py-1 text-xs text-muted-foreground">
            +{formats.length - 10} more
          </span>
        )}
        {formats.length === 0 && <span className="text-xs text-muted-foreground">No non-zero custom-format scores.</span>}
      </div>
    </div>
  );
}

function ProfileEditor({
  profile,
  isNew,
  onSaved,
  onDeleted,
}: {
  profile: QualityProfile | null;
  isNew: boolean;
  onSaved: (id: string) => void;
  onDeleted: () => void;
}) {
  const readOnly = !!profile?.isDefault;
  const create = useCreateProfile();
  const update = useUpdateProfile();
  const del = useDeleteProfile();
  const [bands, setBands] = useState<BandRow[]>(profile ? bandsOf(profile) : []);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const {
    register,
    handleSubmit,
    getValues,
    watch,
    setValue,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: profile
      ? toForm(profile)
      : toForm({ name: "", isDefault: false } as QualityProfile),
  });

  async function onSubmit(values: FormValues) {
    const body = buildDraft(values, bands, profile);
    try {
      if (isNew || !profile || profile.isDefault) {
        const created = await create.mutateAsync({ ...body, id: undefined });
        toast.success(`Created “${created.name}”.`);
        onSaved(created.id!);
      } else {
        const updated = await update.mutateAsync({ id: profile.id!, body });
        toast.success(`Saved “${updated.name}”.`);
        onSaved(updated.id!);
      }
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  async function confirmDeletion() {
    if (!profile?.id) return;
    try {
      await del.mutateAsync(profile.id);
      toast.success(`Deleted “${profile.name}”.`);
      setConfirmDelete(false);
      onDeleted();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  const pending = create.isPending || update.isPending;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
          <div>
            <CardTitle className="flex items-center gap-2">
              {isNew ? "New profile" : profile?.name}
              {readOnly && <Badge variant="muted">Built-in · read-only</Badge>}
              {profile?.importedFrom && (
                <Badge variant="outline" className="capitalize">
                  {profile.importedFrom} import
                </Badge>
              )}
            </CardTitle>
            <CardDescription>
              {readOnly
                ? "The built-in default cannot be edited. Save it as a new profile to customise."
                : "Weights, preferences, group lists and size-sanity bands (BRIEF §7.3)."}
            </CardDescription>
          </div>
          {!isNew && profile && !profile.isDefault && (
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Delete ${profile.name}`}
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 className="size-4 text-destructive" />
            </Button>
          )}
        </CardHeader>
        <CardContent>
          <form id="profile-form" onSubmit={handleSubmit(onSubmit)} className="space-y-6" noValidate>
            <fieldset disabled={readOnly} className="space-y-6">
              <Field id="name" label="Name" error={errors.name?.message}>
                <Input id="name" aria-invalid={!!errors.name} {...register("name")} />
              </Field>

              <Section title="Use this profile for" hint="A scoped profile falls back to Standard for other media.">
                <ScopeSelector
                  value={watch("appliesTo")}
                  onChange={(value) => setValue("appliesTo", value, { shouldDirty: true })}
                  disabled={readOnly}
                />
              </Section>

              {profile?.importedFrom && <ImportedFormatSummary profile={profile} />}

              <Section title="Preferences" hint="Comma-separated, best first.">
                <div className="grid gap-4 sm:grid-cols-2">
                  <CsvField id="preferredResolutions" label="Resolutions" placeholder="1080p, 2160p, 720p" register={register} />
                  <CsvField id="preferredSources" label="Sources" placeholder="BluRay, WEB-DL" register={register} />
                  <CsvField id="preferredCodecs" label="Codecs" placeholder="x265, x264" register={register} />
                  <CsvField id="preferredLanguages" label="Languages" placeholder="en, de" register={register} />
                </div>
              </Section>

              <Section title="Weights" hint="Points contributed at a full match.">
                <div className="grid gap-4 sm:grid-cols-3">
                  <NumField id="resolutionWeight" label="Resolution" register={register} error={errors.resolutionWeight?.message} />
                  <NumField id="sourceWeight" label="Source" register={register} error={errors.sourceWeight?.message} />
                  <NumField id="codecWeight" label="Codec" register={register} error={errors.codecWeight?.message} />
                  <NumField id="languageWeight" label="Language" register={register} error={errors.languageWeight?.message} />
                  <NumField id="audioWeight" label="Audio" register={register} error={errors.audioWeight?.message} />
                  <NumField id="sizeWeight" label="Size" register={register} error={errors.sizeWeight?.message} />
                </div>
              </Section>

              <Section title="Bonuses">
                <div className="grid gap-4 sm:grid-cols-3">
                  <NumField id="properRepackBonus" label="PROPER / REPACK" register={register} error={errors.properRepackBonus?.message} />
                  <NumField id="recencyBonus" label="Recency" register={register} error={errors.recencyBonus?.message} />
                  <NumField id="grabsBonus" label="Grabs" register={register} error={errors.grabsBonus?.message} />
                </div>
              </Section>

              <Section title="Release groups" hint="Comma-separated group names.">
                <div className="grid gap-4 sm:grid-cols-2">
                  <CsvField id="groupAllowList" label="Allow list" placeholder="GROUP1, GROUP2" register={register} />
                  <CsvField id="groupDenyList" label="Deny list" placeholder="BADGROUP" register={register} />
                  <NumField id="groupAllowBonus" label="Allow bonus" register={register} error={errors.groupAllowBonus?.message} />
                  <NumField id="groupDenyPenalty" label="Deny penalty" register={register} error={errors.groupDenyPenalty?.message} />
                </div>
              </Section>

              <Section
                title="Rejection rules"
                hint="Bytes-per-minute size-sanity band; releases outside it are rejected as fakes (§7.2)."
              >
                <div className="grid gap-4 sm:grid-cols-2">
                  <NumField id="minBytesPerMinute" label="Min bytes / minute" register={register} error={errors.minBytesPerMinute?.message} />
                  <NumField id="maxBytesPerMinute" label="Max bytes / minute" register={register} error={errors.maxBytesPerMinute?.message} />
                </div>
                <SizeBandsEditor bands={bands} onChange={setBands} disabled={readOnly} />
              </Section>
            </fieldset>
          </form>
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button type="submit" form="profile-form" disabled={pending}>
          {pending && <Loader2 className="size-4 animate-spin" />}
          {readOnly || isNew ? "Save as new profile" : "Save changes"}
        </Button>
      </div>

      <LivePreview getDraft={() => buildDraft(getValues(), bands, profile)} />

      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete profile</DialogTitle>
            <DialogDescription>
              {profile ? `"${profile.name}" will be permanently deleted.` : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDelete(false)} disabled={del.isPending}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={confirmDeletion} disabled={del.isPending}>
              {del.isPending && <Loader2 className="size-4 animate-spin" />}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SizeBandsEditor({
  bands,
  onChange,
  disabled,
}: {
  bands: BandRow[];
  onChange: (b: BandRow[]) => void;
  disabled?: boolean;
}) {
  return (
    <div className="mt-4 space-y-2">
      <Label>Per-resolution size bands</Label>
      {bands.length === 0 && (
        <p className="text-xs text-muted-foreground">
          No per-resolution overrides — the global band above applies to every resolution.
        </p>
      )}
      {bands.map((band, i) => (
        <div key={i} className="grid grid-cols-[1fr_1fr_1fr_auto] items-center gap-2">
          <Input
            aria-label={`Band ${i + 1} resolution`}
            placeholder="2160p"
            value={band.resolution}
            onChange={(e) => onChange(bands.map((b, j) => (j === i ? { ...b, resolution: e.target.value } : b)))}
          />
          <Input
            aria-label={`Band ${i + 1} min bytes per minute`}
            type="number"
            placeholder="min b/min"
            value={band.min}
            onChange={(e) => onChange(bands.map((b, j) => (j === i ? { ...b, min: Number(e.target.value) } : b)))}
          />
          <Input
            aria-label={`Band ${i + 1} max bytes per minute`}
            type="number"
            placeholder="max b/min"
            value={band.max}
            onChange={(e) => onChange(bands.map((b, j) => (j === i ? { ...b, max: Number(e.target.value) } : b)))}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`Remove band ${i + 1}`}
            onClick={() => onChange(bands.filter((_, j) => j !== i))}
          >
            <X className="size-4" />
          </Button>
        </div>
      ))}
      {!disabled && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onChange([...bands, { resolution: "", min: 0, max: 0 }])}
        >
          <Plus className="size-4" />
          Add band
        </Button>
      )}
    </div>
  );
}

function LivePreview({ getDraft }: { getDraft: () => QualityProfile }) {
  const debug = useDebugSearch();
  const [q, setQ] = useState("");
  const [type, setType] = useState("any");

  async function run() {
    if (!q.trim()) {
      toast.error("Enter a sample query to preview.");
      return;
    }
    try {
      await debug.mutateAsync({
        q: q.trim(),
        type: type === "any" ? undefined : type,
        profile: getDraft(),
      });
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  const results = debug.data?.results ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <SlidersHorizontal className="size-4" />
          Live preview
        </CardTitle>
        <CardDescription>
          Run a sample query through <code>/debug/search</code> with the current draft — no save
          required. Releases are ranked and ordered by the draft you see above.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form
          className="flex flex-col gap-2 sm:flex-row"
          onSubmit={(e) => {
            e.preventDefault();
            void run();
          }}
        >
          <Input
            aria-label="Sample query"
            placeholder="e.g. Example Movie 2021"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <select
            aria-label="Media type"
            value={type}
            onChange={(e) => setType(e.target.value)}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <option value="any">Any</option>
            <option value="movie">Movie</option>
            <option value="tv">TV</option>
          </select>
          <Button type="submit" disabled={debug.isPending}>
            {debug.isPending ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
            Preview
          </Button>
        </form>

        {debug.isError && <p className="text-sm text-destructive">{errorMessage(debug.error)}</p>}

        {debug.isSuccess && results.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No results — check that indexers are configured and reachable.
          </p>
        )}

        {results.map((work) => (
          <div key={work.workId} className="space-y-2">
            <div className="flex items-center gap-2 text-sm font-medium">
              {work.title}
              {work.year && <span className="text-muted-foreground">({work.year})</span>}
            </div>
            <ol className="space-y-1" aria-label={`Ranked releases for ${work.title}`}>
              {(work.releases ?? []).map((release, i) => (
                <PreviewRelease key={release.releaseId} release={release} rank={i + 1} />
              ))}
            </ol>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function PreviewRelease({ release, rank }: { release: DebugReleaseDto; rank: number }) {
  return (
    <li
      className={cn(
        "flex items-center gap-3 rounded-md border px-3 py-2 text-xs",
        release.rejected && "opacity-60",
      )}
    >
      <span className="w-5 shrink-0 text-center font-mono text-muted-foreground">{rank}</span>
      <span className="min-w-0 flex-1 truncate font-mono" title={release.title ?? ""}>
        {release.title}
      </span>
      <span className="shrink-0 text-muted-foreground">{release.indexer}</span>
      {release.rejected ? (
        <Badge variant="destructive">rejected</Badge>
      ) : (
        <Badge variant="success">score {release.score}</Badge>
      )}
    </li>
  );
}

// ---- small field helpers -------------------------------------------------------------

type Register = ReturnType<typeof useForm<FormValues>>["register"];

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold">{title}</h3>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
      {children}
    </div>
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

function CsvField({
  id,
  label,
  placeholder,
  register,
}: {
  id: keyof FormValues;
  label: string;
  placeholder?: string;
  register: Register;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} placeholder={placeholder} {...register(id)} />
    </div>
  );
}

function NumField({
  id,
  label,
  register,
  error,
}: {
  id: keyof FormValues;
  label: string;
  register: Register;
  error?: string;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} type="number" aria-invalid={!!error} {...register(id)} />
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
