import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  Database,
  Loader2,
  Plus,
  Pencil,
  Trash2,
  X,
  XCircle,
  Zap,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  useCreateIndexer,
  useDeleteIndexer,
  useIndexers,
  useReorderIndexers,
  useTestIndexer,
  useUpdateIndexer,
} from "@/api/queries";
import type { IndexerResponse, IndexerTestResult, IndexerWrite } from "@/api/types";
import { errorMessage } from "@/api/client";

const schema = z.object({
  name: z.string().trim().min(1, "A name is required").max(128, "Maximum 128 characters"),
  baseUrl: z
    .string()
    .trim()
    .url("Must be a valid URL")
    .refine((value) => {
      try {
        const url = new URL(value);
        return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password;
      } catch {
        return false;
      }
    }, "Use an HTTP(S) URL without embedded credentials"),
  apiKey: z.string().max(4096, "Maximum 4096 characters").optional(),
  categories: z
    .string()
    .optional()
    .refine(
      (v) => !v || v.split(",").every((s) => /^\s*\d+\s*$/.test(s)),
      "Comma-separated category numbers only (e.g. 2000, 5000)",
    )
    .refine(
      (v) => !v || (v.split(",").length <= 100 && v.split(",").every((s) => Number(s.trim()) <= 999_999)),
      "Use at most 100 category IDs between 0 and 999999",
    ),
  priority: z.coerce.number().int("Whole number").min(0, "Cannot be negative").max(100_000, "Maximum 100000"),
  enabled: z.boolean(),
  allowedDownloadHosts: z
    .array(z.string())
    .default([])
    .refine(
      (hosts) => hosts.filter((h) => h.trim()).length <= 32,
      "Use at most 32 hosts",
    )
    .refine(
      (hosts) => hosts.every((h) => !h.trim() || HOST_RE.test(h.trim())),
      "Each entry must be a bare hostname — no scheme, port or path (e.g. dl.indexer.example)",
    ),
});
type FormValues = z.input<typeof schema>;

/** A bare DNS hostname: labels of letters/digits/hyphens separated by dots. */
const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i;

function parseCategories(input?: string): number[] {
  if (!input) return [];
  return input
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n));
}

export function IndexersPage() {
  const { data, isLoading, isError, error } = useIndexers();
  const reorder = useReorderIndexers();
  const [editing, setEditing] = useState<IndexerResponse | null>(null);
  const [creating, setCreating] = useState(false);
  const [toDelete, setToDelete] = useState<IndexerResponse | null>(null);

  const sorted = [...(data ?? [])].sort(
    (a, b) => (a.priority ?? 0) - (b.priority ?? 0) || (a.name ?? "").localeCompare(b.name ?? ""),
  );

  async function swap(first: IndexerResponse, second?: IndexerResponse) {
    if (!second?.id || !first.id) return;
    const ids = sorted.flatMap((item) => (item.id ? [item.id] : []));
    const firstIndex = ids.indexOf(first.id);
    const secondIndex = ids.indexOf(second.id);
    if (firstIndex < 0 || secondIndex < 0) return;
    [ids[firstIndex], ids[secondIndex]] = [ids[secondIndex], ids[firstIndex]];
    try {
      await reorder.mutateAsync(ids);
    } catch (err) {
      toast.error(`Could not reorder indexers: ${errorMessage(err)}`);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Indexers</h2>
          <p className="text-sm text-muted-foreground">
            Newznab indexers to fan out across. Lower priority is queried first (BRIEF §9.1).
          </p>
        </div>
        <Button onClick={() => setCreating(true)}>
          <Plus className="size-4" />
          Add indexer
        </Button>
      </div>

      {isLoading ? (
        <SkeletonList />
      ) : isError ? (
        <Card>
          <CardContent className="pt-6 text-sm text-destructive">{errorMessage(error)}</CardContent>
        </Card>
      ) : sorted.length === 0 ? (
        <EmptyState onAdd={() => setCreating(true)} />
      ) : (
        <ul className="space-y-2">
          {sorted.map((indexer, i) => (
            <IndexerRow
              key={indexer.id}
              indexer={indexer}
              isFirst={i === 0}
              isLast={i === sorted.length - 1}
              neighborAbove={sorted[i - 1]}
              neighborBelow={sorted[i + 1]}
              reorderPending={reorder.isPending}
              onMove={(other) => swap(indexer, other)}
              onEdit={() => setEditing(indexer)}
              onDelete={() => setToDelete(indexer)}
            />
          ))}
        </ul>
      )}

      {(creating || editing) && (
        <IndexerFormDialog
          indexer={editing}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
        />
      )}
      <DeleteDialog target={toDelete} onClose={() => setToDelete(null)} />
    </div>
  );
}

function IndexerRow({
  indexer,
  isFirst,
  isLast,
  neighborAbove,
  neighborBelow,
  reorderPending,
  onMove,
  onEdit,
  onDelete,
}: {
  indexer: IndexerResponse;
  isFirst: boolean;
  isLast: boolean;
  neighborAbove?: IndexerResponse;
  neighborBelow?: IndexerResponse;
  reorderPending: boolean;
  onMove: (other?: IndexerResponse) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const update = useUpdateIndexer();
  const test = useTestIndexer();
  const [result, setResult] = useState<IndexerTestResult | null>(null);

  function writeFrom(source: IndexerResponse): IndexerWrite {
    // Rebuild the write model from the masked response; apiKey omitted → server keeps it.
    return {
      name: source.name,
      baseUrl: source.baseUrl,
      categories: source.categories,
      allowedDownloadHosts: source.allowedDownloadHosts,
      enabled: source.enabled,
      priority: source.priority,
    };
  }

  async function toggleEnabled(enabled: boolean) {
    try {
      await update.mutateAsync({ id: indexer.id!, body: { ...writeFrom(indexer), enabled } });
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  async function runTest() {
    setResult(null);
    try {
      const res = await test.mutateAsync(indexer.id!);
      setResult(res);
      if (res.success) toast.success(`${indexer.name} reachable in ${Math.round(res.latencyMs)} ms.`);
      else toast.error(`${indexer.name}: ${res.error ?? "test failed"}`);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  return (
    <li className="rounded-lg border bg-card">
      <div className="flex flex-wrap items-center gap-3 p-3">
        <div className="flex flex-col">
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            disabled={isFirst || reorderPending}
            aria-label={`Move ${indexer.name} up`}
            onClick={() => onMove(neighborAbove)}
          >
            <ArrowUp className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            disabled={isLast || reorderPending}
            aria-label={`Move ${indexer.name} down`}
            onClick={() => onMove(neighborBelow)}
          >
            <ArrowDown className="size-3.5" />
          </Button>
        </div>

        <span className="flex size-9 items-center justify-center rounded-md bg-muted text-muted-foreground">
          <Database className="size-4" />
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium">{indexer.name}</span>
            <Badge variant="muted">#{indexer.priority ?? 0}</Badge>
            {!indexer.enabled && <Badge variant="muted">Disabled</Badge>}
          </div>
          <p className="truncate text-xs text-muted-foreground">{indexer.baseUrl}</p>
        </div>

        <div className="flex w-full items-center justify-end gap-1 border-t pt-2 sm:w-auto sm:border-0 sm:pt-0">
          <div className="mr-2 flex items-center gap-2">
            <Switch
              checked={!!indexer.enabled}
              onCheckedChange={toggleEnabled}
              disabled={update.isPending}
              aria-label={`${indexer.enabled ? "Disable" : "Enable"} ${indexer.name}`}
            />
          </div>
          <Button variant="outline" size="sm" onClick={runTest} disabled={test.isPending}>
            {test.isPending ? <Loader2 className="size-4 animate-spin" /> : <Zap className="size-4" />}
            Test
          </Button>
          <Button variant="ghost" size="icon" aria-label={`Edit ${indexer.name}`} onClick={onEdit}>
            <Pencil className="size-4" />
          </Button>
          <Button variant="ghost" size="icon" aria-label={`Delete ${indexer.name}`} onClick={onDelete}>
            <Trash2 className="size-4 text-destructive" />
          </Button>
        </div>
      </div>

      {result && (
        <div className="border-t px-3 py-2 text-xs">
          {result.success ? (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-muted-foreground">
              <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                <CheckCircle2 className="size-3.5" /> Connected
              </span>
              <span>Latency {Math.round(result.latencyMs)} ms</span>
              <span>{result.categoryCount} categories</span>
              <span>search {result.searchAvailable ? "✓" : "✗"}</span>
              <span>movie {result.movieSearchAvailable ? "✓" : "✗"}</span>
              <span>tv {result.tvSearchAvailable ? "✓" : "✗"}</span>
              {result.serverVersion && <span>v{result.serverVersion}</span>}
            </div>
          ) : (
            <span className="inline-flex items-center gap-1 text-destructive">
              <XCircle className="size-3.5" /> {result.error ?? "Test failed"}
            </span>
          )}
        </div>
      )}
    </li>
  );
}

function IndexerFormDialog({
  indexer,
  onClose,
}: {
  indexer: IndexerResponse | null;
  onClose: () => void;
}) {
  const isEdit = indexer !== null;
  const create = useCreateIndexer();
  const update = useUpdateIndexer();

  const {
    register,
    handleSubmit,
    reset,
    control,
    setValue,
    watch,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: "",
      baseUrl: "",
      apiKey: "",
      categories: "",
      priority: 0,
      enabled: true,
      allowedDownloadHosts: [],
    },
  });
  void control;
  const enabled = watch("enabled");
  const hosts = watch("allowedDownloadHosts") ?? [];
  const setHosts = (next: string[]) =>
    setValue("allowedDownloadHosts", next, { shouldValidate: true, shouldDirty: true });

  useEffect(() => {
    reset({
      name: indexer?.name ?? "",
      baseUrl: indexer?.baseUrl ?? "",
      apiKey: "",
      categories: (indexer?.categories ?? []).join(", "),
      priority: indexer?.priority ?? 0,
      enabled: indexer?.enabled ?? true,
      allowedDownloadHosts: indexer?.allowedDownloadHosts ?? [],
    });
  }, [indexer, reset]);

  async function onSubmit(values: FormValues) {
    const parsed = schema.parse(values);
    const body: IndexerWrite = {
      name: parsed.name,
      baseUrl: parsed.baseUrl,
      categories: parseCategories(parsed.categories),
      allowedDownloadHosts: parsed.allowedDownloadHosts.map((h) => h.trim()).filter(Boolean),
      priority: parsed.priority,
      enabled: parsed.enabled,
    };
    // apiKey is write-only (BRIEF §6.3): only send it when the operator typed a value.
    const key = parsed.apiKey?.trim();
    if (key) body.apiKey = key;

    try {
      if (isEdit) await update.mutateAsync({ id: indexer!.id!, body });
      else await create.mutateAsync(body);
      toast.success(isEdit ? "Indexer updated." : "Indexer added.");
      onClose();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  const pending = create.isPending || update.isPending;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit indexer" : "Add indexer"}</DialogTitle>
          <DialogDescription>
            Newznab-compatible endpoint. The API key is stored encrypted and never shown again.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
          <Field id="name" label="Name" error={errors.name?.message}>
            <Input id="name" aria-invalid={!!errors.name} {...register("name")} />
          </Field>
          <Field id="baseUrl" label="Base URL" error={errors.baseUrl?.message}>
            <Input id="baseUrl" placeholder="https://indexer.example" aria-invalid={!!errors.baseUrl} {...register("baseUrl")} />
          </Field>
          <Field
            id="apiKey"
            label="API key"
            hint={
              isEdit && indexer?.hasApiKey
                ? "A key is stored. Leave blank to keep it, or type a new one to replace it."
                : "Newznab API key for this indexer."
            }
            error={errors.apiKey?.message}
          >
            <Input
              id="apiKey"
              type="password"
              autoComplete="off"
              placeholder={isEdit && indexer?.hasApiKey ? "••••••••" : "Enter API key"}
              aria-invalid={!!errors.apiKey}
              {...register("apiKey")}
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="categories" label="Categories" hint="Comma-separated Newznab IDs." error={errors.categories?.message}>
              <Input id="categories" placeholder="2000, 5000" aria-invalid={!!errors.categories} {...register("categories")} />
            </Field>
            <Field id="priority" label="Priority" hint="Lower is queried first." error={errors.priority?.message}>
              <Input id="priority" type="number" min={0} aria-invalid={!!errors.priority} {...register("priority")} />
            </Field>
          </div>
          <div className="space-y-2">
            <Label>Allowed download hosts</Label>
            <p className="text-xs text-muted-foreground">
              Extra hosts this indexer serves NZB downloads from, besides the Base URL host. Add
              one if a resolve fails with “download host not allowed”.
            </p>
            {hosts.length > 0 && (
              <div className="space-y-2">
                {hosts.map((host, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <Input
                      value={host}
                      placeholder="dl.indexer.example"
                      aria-label={`Allowed download host ${i + 1}`}
                      aria-invalid={!!errors.allowedDownloadHosts}
                      onChange={(e) => setHosts(hosts.map((h, j) => (j === i ? e.target.value : h)))}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`Remove download host ${i + 1}`}
                      onClick={() => setHosts(hosts.filter((_, j) => j !== i))}
                    >
                      <X className="size-4" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
            <Button type="button" variant="outline" size="sm" onClick={() => setHosts([...hosts, ""])}>
              <Plus className="size-4" />
              Add host
            </Button>
            {errors.allowedDownloadHosts && (
              <p className="text-xs text-destructive">
                {errors.allowedDownloadHosts.message as string}
              </p>
            )}
          </div>

          <div className="flex items-center gap-3">
            <Switch id="enabled" checked={enabled} onCheckedChange={(v) => setValue("enabled", v)} aria-label="Enabled" />
            <Label htmlFor="enabled" className="cursor-pointer">
              Enabled
            </Label>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending && <Loader2 className="size-4 animate-spin" />}
              {isEdit ? "Save changes" : "Add indexer"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DeleteDialog({
  target,
  onClose,
}: {
  target: IndexerResponse | null;
  onClose: () => void;
}) {
  const del = useDeleteIndexer();
  async function confirm() {
    if (!target?.id) return;
    try {
      await del.mutateAsync(target.id);
      toast.success(`Removed “${target.name}”.`);
      onClose();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }
  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Remove indexer</DialogTitle>
          <DialogDescription>
            {target ? `"${target.name}" will no longer be searched. This cannot be undone.` : ""}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={del.isPending}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={confirm} disabled={del.isPending}>
            {del.isPending && <Loader2 className="size-4 animate-spin" />}
            Remove
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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

function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-3 py-16 text-center">
        <span className="flex size-12 items-center justify-center rounded-xl bg-muted text-muted-foreground">
          <Database className="size-6" />
        </span>
        <p className="text-sm text-muted-foreground">No indexers configured yet.</p>
        <Button onClick={onAdd}>
          <Plus className="size-4" />
          Add your first indexer
        </Button>
      </CardContent>
    </Card>
  );
}

function SkeletonList() {
  return (
    <div className="space-y-2">
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="h-16 w-full animate-pulse rounded-lg bg-muted" />
      ))}
    </div>
  );
}
