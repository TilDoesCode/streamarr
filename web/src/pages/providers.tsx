import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  Download,
  Gauge,
  Loader2,
  Plus,
  Pencil,
  Server,
  Trash2,
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
  useCreateProvider,
  useDeleteProvider,
  useProviders,
  useReorderProviders,
  useSpeedTestProvider,
  useTestProvider,
  useUpdateProvider,
} from "@/api/queries";
import type {
  ProviderResponse,
  ProviderSpeedTestResult,
  ProviderTestResult,
  ProviderWrite,
} from "@/api/types";
import { errorMessage } from "@/api/client";

const schema = z.object({
  name: z.string().trim().min(1, "A name is required").max(128, "Maximum 128 characters"),
  host: z.string().trim().min(1, "A host is required").max(253, "Maximum 253 characters"),
  port: z.coerce.number().int("Whole number").min(1, "1–65535").max(65535, "1–65535"),
  useSsl: z.boolean(),
  username: z.string().max(512, "Maximum 512 characters").optional(),
  password: z.string().max(4096, "Maximum 4096 characters").optional(),
  maxConnections: z.coerce.number().int("Whole number").min(1, "At least 1").max(100, "Maximum 100"),
  priority: z.coerce.number().int("Whole number").min(0, "Cannot be negative").max(100_000, "Maximum 100000"),
  enabled: z.boolean(),
  isBackupOnly: z.boolean(),
});
type FormValues = z.input<typeof schema>;

export function ProvidersPage() {
  const { data, isLoading, isError, error } = useProviders();
  const reorder = useReorderProviders();
  const [editing, setEditing] = useState<ProviderResponse | null>(null);
  const [creating, setCreating] = useState(false);
  const [toDelete, setToDelete] = useState<ProviderResponse | null>(null);

  const sorted = [...(data ?? [])].sort(
    (a, b) => (a.priority ?? 0) - (b.priority ?? 0) || (a.name ?? "").localeCompare(b.name ?? ""),
  );

  async function swap(first: ProviderResponse, second?: ProviderResponse) {
    if (!second?.id || !first.id) return;
    const ids = sorted.flatMap((item) => (item.id ? [item.id] : []));
    const firstIndex = ids.indexOf(first.id);
    const secondIndex = ids.indexOf(second.id);
    if (firstIndex < 0 || secondIndex < 0) return;
    [ids[firstIndex], ids[secondIndex]] = [ids[secondIndex], ids[firstIndex]];
    try {
      await reorder.mutateAsync(ids);
    } catch (err) {
      toast.error(`Could not reorder providers: ${errorMessage(err)}`);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Usenet Providers</h2>
          <p className="text-sm text-muted-foreground">
            Priority-ordered NNTP providers (primary + block-account fallback). Lower priority is
            tried first. Check authentication, then measure real streaming throughput.
          </p>
        </div>
        <Button onClick={() => setCreating(true)}>
          <Plus className="size-4" />
          Add provider
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
          {sorted.map((provider, i) => (
            <ProviderRow
              key={provider.id}
              provider={provider}
              isFirst={i === 0}
              isLast={i === sorted.length - 1}
              neighborAbove={sorted[i - 1]}
              neighborBelow={sorted[i + 1]}
              reorderPending={reorder.isPending}
              onMove={(other) => swap(provider, other)}
              onEdit={() => setEditing(provider)}
              onDelete={() => setToDelete(provider)}
            />
          ))}
        </ul>
      )}

      {(creating || editing) && (
        <ProviderFormDialog
          provider={editing}
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

function ProviderRow({
  provider,
  isFirst,
  isLast,
  neighborAbove,
  neighborBelow,
  reorderPending,
  onMove,
  onEdit,
  onDelete,
}: {
  provider: ProviderResponse;
  isFirst: boolean;
  isLast: boolean;
  neighborAbove?: ProviderResponse;
  neighborBelow?: ProviderResponse;
  reorderPending: boolean;
  onMove: (other?: ProviderResponse) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const update = useUpdateProvider();
  const test = useTestProvider();
  const [connectionResult, setConnectionResult] = useState<ProviderTestResult | null>(null);
  const [speedResult, setSpeedResult] = useState<ProviderSpeedTestResult | null>(null);
  const [speedTestOpen, setSpeedTestOpen] = useState(false);

  function writeFrom(source: ProviderResponse): ProviderWrite {
    // Rebuild the write model from the masked response; password omitted → server keeps it.
    return {
      name: source.name,
      host: source.host,
      port: source.port,
      useSsl: source.useSsl,
      username: source.username,
      maxConnections: source.maxConnections,
      priority: source.priority,
      enabled: source.enabled,
      isBackupOnly: source.isBackupOnly,
    };
  }

  async function toggleEnabled(enabled: boolean) {
    try {
      await update.mutateAsync({ id: provider.id!, body: { ...writeFrom(provider), enabled } });
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  async function runTest() {
    setConnectionResult(null);
    try {
      const res = await test.mutateAsync(provider.id!);
      setConnectionResult(res);
      if (res.success)
        toast.success(
          `${provider.name}: authenticated, ${res.achievableConnections}/${res.requestedConnections} connections.`,
        );
      else toast.error(`${provider.name}: ${res.error ?? "connection failed"}`);
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
            aria-label={`Move ${provider.name} up`}
            onClick={() => onMove(neighborAbove)}
          >
            <ArrowUp className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            disabled={isLast || reorderPending}
            aria-label={`Move ${provider.name} down`}
            onClick={() => onMove(neighborBelow)}
          >
            <ArrowDown className="size-3.5" />
          </Button>
        </div>

        <span className="flex size-9 items-center justify-center rounded-md bg-muted text-muted-foreground">
          <Server className="size-4" />
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-medium">{provider.name}</span>
            <Badge variant="muted">#{provider.priority ?? 0}</Badge>
            {provider.useSsl && <Badge variant="secondary">SSL</Badge>}
            {provider.isBackupOnly && <Badge variant="outline">Backup</Badge>}
            {!provider.enabled && <Badge variant="muted">Disabled</Badge>}
          </div>
          <p className="truncate text-xs text-muted-foreground">
            {provider.host}:{provider.port} · {provider.maxConnections} conns
          </p>
        </div>

        <div className="flex w-full items-center justify-end gap-1 border-t pt-2 sm:w-auto sm:border-0 sm:pt-0">
          <div className="mr-2">
            <Switch
              checked={!!provider.enabled}
              onCheckedChange={toggleEnabled}
              disabled={update.isPending}
              aria-label={`${provider.enabled ? "Disable" : "Enable"} ${provider.name}`}
            />
          </div>
          <Button variant="outline" size="sm" onClick={runTest} disabled={test.isPending}>
            {test.isPending ? <Loader2 className="size-4 animate-spin" /> : <Zap className="size-4" />}
            Check
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setSpeedTestOpen(true)}
            aria-label={`Speed test ${provider.name}`}
          >
            <Gauge className="size-4" />
            Speed
          </Button>
          <Button variant="ghost" size="icon" aria-label={`Edit ${provider.name}`} onClick={onEdit}>
            <Pencil className="size-4" />
          </Button>
          <Button variant="ghost" size="icon" aria-label={`Delete ${provider.name}`} onClick={onDelete}>
            <Trash2 className="size-4 text-destructive" />
          </Button>
        </div>
      </div>

      {connectionResult && (
        <div className="border-t px-3 py-2 text-xs">
          {connectionResult.success ? (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-muted-foreground">
              <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                <CheckCircle2 className="size-3.5" /> Authenticated
              </span>
              <span>
                {connectionResult.achievableConnections} / {connectionResult.requestedConnections} connections
              </span>
            </div>
          ) : (
            <span className="inline-flex items-center gap-1 text-destructive">
              <XCircle className="size-3.5" /> {connectionResult.error ?? "Connection failed"}
            </span>
          )}
        </div>
      )}

      {speedResult && <SpeedResult result={speedResult} />}

      {speedTestOpen && (
        <ProviderSpeedTestDialog
          provider={provider}
          onResult={setSpeedResult}
          onClose={() => setSpeedTestOpen(false)}
        />
      )}
    </li>
  );
}

function ProviderSpeedTestDialog({
  provider,
  onResult,
  onClose,
}: {
  provider: ProviderResponse;
  onResult: (result: ProviderSpeedTestResult) => void;
  onClose: () => void;
}) {
  const speedTest = useSpeedTestProvider();
  const [messageId, setMessageId] = useState("");
  const [failure, setFailure] = useState<string | null>(null);

  async function run(event: React.FormEvent) {
    event.preventDefault();
    setFailure(null);
    try {
      const trimmedMessageId = messageId.trim();
      const result = await speedTest.mutateAsync({
        id: provider.id!,
        body: {
          durationSeconds: 8,
          ...(trimmedMessageId ? { messageId: trimmedMessageId } : {}),
        },
      });
      onResult(result);
      if (result.success) {
        toast.success(`${provider.name}: ${result.megabitsPerSecond.toFixed(1)} Mbps NNTP throughput.`);
        onClose();
      } else {
        setFailure(result.error ?? "The provider returned no article data.");
      }
    } catch (err) {
      setFailure(errorMessage(err));
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Gauge className="size-5 text-primary" />
            Streaming speed test
          </DialogTitle>
          <DialogDescription>
            Measure {provider.name} with real NNTP article traffic across up to {provider.maxConnections} configured
            connections.
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-lg border bg-muted/40 p-4">
          <div className="flex gap-3">
            <Download className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
            <div className="space-y-1">
              <p className="text-sm font-medium">An 8-second, traffic-consuming test</p>
              <p className="text-xs leading-relaxed text-muted-foreground">
                Streamarr repeatedly downloads a recent article for up to 8 seconds or 512 MiB. The result keeps
                30% safety headroom when estimating video quality.
              </p>
            </div>
          </div>
        </div>

        <form onSubmit={run} className="space-y-4">
          <Field
            id={`speed-message-${provider.id}`}
            label="Article message-ID (optional)"
            hint="Leave blank for automatic discovery. If your provider blocks OVER, paste a segment ID from a recent NZB."
          >
            <Input
              id={`speed-message-${provider.id}`}
              value={messageId}
              onChange={(event) => setMessageId(event.target.value)}
              placeholder="<segment-id@example>"
              autoComplete="off"
              spellCheck={false}
            />
          </Field>

          {failure && (
            <div role="alert" className="flex gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
              <XCircle className="mt-0.5 size-4 shrink-0" />
              <span>{failure}</span>
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={speedTest.isPending}>
              Cancel
            </Button>
            <Button type="submit" disabled={speedTest.isPending}>
              {speedTest.isPending ? <Loader2 className="size-4 animate-spin" /> : <Gauge className="size-4" />}
              {speedTest.isPending ? "Measuring…" : "Run 8-second test"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function SpeedResult({ result }: { result: ProviderSpeedTestResult }) {
  if (!result.success) {
    return (
      <div role="status" className="flex items-center gap-2 border-t px-3 py-3 text-xs text-destructive">
        <XCircle className="size-4 shrink-0" />
        {result.error ?? "Speed test failed"}
      </div>
    );
  }

  const tier = tierLabel(result.streamingTier);
  const meterWidth = Math.min(100, Math.max(3, result.recommendedVideoBitrateMbps / 0.75));
  const sampleMiB = result.bytesDownloaded / 1024 / 1024;

  return (
    <div role="status" className="border-t bg-muted/20 px-4 py-4">
      <div className="grid gap-4 lg:grid-cols-[minmax(10rem,0.75fr)_minmax(14rem,1.25fr)] lg:items-center">
        <div>
          <div className="flex items-end gap-2">
            <span className="text-3xl font-semibold tracking-tight tabular-nums">
              {result.megabitsPerSecond.toFixed(1)}
            </span>
            <span className="pb-1 text-sm font-medium text-muted-foreground">Mbps</span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <Badge variant="success">{tier}</Badge>
            <span className="text-xs text-muted-foreground">{result.megabytesPerSecond.toFixed(1)} MB/s payload</span>
          </div>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3 text-xs">
            <span className="font-medium">Recommended video ceiling</span>
            <span className="tabular-nums text-muted-foreground">
              {result.recommendedVideoBitrateMbps.toFixed(1)} Mbps
            </span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-muted" aria-hidden="true">
            <div className="h-full rounded-full bg-primary transition-[width] duration-500" style={{ width: `${meterWidth}%` }} />
          </div>
          <p className="text-[11px] text-muted-foreground">
            Approx. {streamCount(result.estimated4KStreams)} 4K or {streamCount(result.estimated1080pStreams)} 1080p
            simultaneous streams with safety headroom.
          </p>
        </div>
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 border-t pt-3 text-[11px] sm:grid-cols-4">
        <Metric label="Connections" value={`${result.connectionsUsed}/${result.requestedConnections}`} />
        <Metric label="First byte" value={`${result.firstByteMilliseconds} ms`} />
        <Metric label="Setup" value={`${result.setupMilliseconds} ms`} />
        <Metric label="Sample" value={`${sampleMiB.toFixed(1)} MiB`} />
      </dl>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium tabular-nums">{value}</dd>
    </div>
  );
}

function tierLabel(tier: string | null) {
  switch (tier) {
    case "4k":
      return "4K ready";
    case "1080p":
      return "1080p ready";
    case "720p":
      return "720p ready";
    case "sd":
      return "SD only";
    default:
      return "Below streaming minimum";
  }
}

function streamCount(count: number) {
  return count > 0 ? String(count) : "<1";
}

function ProviderFormDialog({
  provider,
  onClose,
}: {
  provider: ProviderResponse | null;
  onClose: () => void;
}) {
  const isEdit = provider !== null;
  const create = useCreateProvider();
  const update = useUpdateProvider();

  const {
    register,
    handleSubmit,
    reset,
    setValue,
    watch,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      name: "",
      host: "",
      port: 563,
      useSsl: true,
      username: "",
      password: "",
      maxConnections: 20,
      priority: 0,
      enabled: true,
      isBackupOnly: false,
    },
  });
  const useSsl = watch("useSsl");
  const enabled = watch("enabled");
  const isBackupOnly = watch("isBackupOnly");

  useEffect(() => {
    reset({
      name: provider?.name ?? "",
      host: provider?.host ?? "",
      port: provider?.port ?? 563,
      useSsl: provider?.useSsl ?? true,
      username: provider?.username ?? "",
      password: "",
      maxConnections: provider?.maxConnections ?? 20,
      priority: provider?.priority ?? 0,
      enabled: provider?.enabled ?? true,
      isBackupOnly: provider?.isBackupOnly ?? false,
    });
  }, [provider, reset]);

  async function onSubmit(values: FormValues) {
    const parsed = schema.parse(values);
    const body: ProviderWrite = {
      name: parsed.name,
      host: parsed.host,
      port: parsed.port,
      useSsl: parsed.useSsl,
      username: parsed.username?.trim() || undefined,
      maxConnections: parsed.maxConnections,
      priority: parsed.priority,
      enabled: parsed.enabled,
      isBackupOnly: parsed.isBackupOnly,
    };
    // password is write-only (BRIEF §6.3): only send it when the operator typed a value.
    const pw = parsed.password?.trim();
    if (pw) body.password = pw;

    try {
      if (isEdit) await update.mutateAsync({ id: provider!.id!, body });
      else await create.mutateAsync(body);
      toast.success(isEdit ? "Provider updated." : "Provider added.");
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
          <DialogTitle>{isEdit ? "Edit provider" : "Add provider"}</DialogTitle>
          <DialogDescription>
            NNTP provider credentials. The password is stored encrypted and never shown again.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
          <Field id="name" label="Name" error={errors.name?.message}>
            <Input id="name" aria-invalid={!!errors.name} {...register("name")} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-[1fr_7rem]">
            <Field id="host" label="Host" error={errors.host?.message}>
              <Input id="host" placeholder="news.example.com" aria-invalid={!!errors.host} {...register("host")} />
            </Field>
            <Field id="port" label="Port" error={errors.port?.message}>
              <Input id="port" type="number" min={1} max={65535} aria-invalid={!!errors.port} {...register("port")} />
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="username" label="Username" error={errors.username?.message}>
              <Input id="username" autoComplete="off" aria-invalid={!!errors.username} {...register("username")} />
            </Field>
            <Field
              id="password"
              label="Password"
              hint={isEdit && provider?.hasPassword ? "Leave blank to keep the stored password." : undefined}
              error={errors.password?.message}
            >
              <Input
                id="password"
                type="password"
                autoComplete="off"
                placeholder={isEdit && provider?.hasPassword ? "••••••••" : "Enter password"}
                aria-invalid={!!errors.password}
                {...register("password")}
              />
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="maxConnections" label="Max connections" error={errors.maxConnections?.message}>
              <Input id="maxConnections" type="number" min={1} aria-invalid={!!errors.maxConnections} {...register("maxConnections")} />
            </Field>
            <Field id="priority" label="Priority" hint="Lower is tried first." error={errors.priority?.message}>
              <Input id="priority" type="number" min={0} aria-invalid={!!errors.priority} {...register("priority")} />
            </Field>
          </div>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
            <Toggle id="useSsl" label="Use SSL" checked={useSsl} onChange={(v) => setValue("useSsl", v)} />
            <Toggle id="enabled" label="Enabled" checked={enabled} onChange={(v) => setValue("enabled", v)} />
            <Toggle
              id="isBackupOnly"
              label="Backup only"
              checked={isBackupOnly}
              onChange={(v) => setValue("isBackupOnly", v)}
            />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending && <Loader2 className="size-4 animate-spin" />}
              {isEdit ? "Save changes" : "Add provider"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Toggle({
  id,
  label,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <Switch id={id} checked={checked} onCheckedChange={onChange} aria-label={label} />
      <Label htmlFor={id} className="cursor-pointer">
        {label}
      </Label>
    </div>
  );
}

function DeleteDialog({
  target,
  onClose,
}: {
  target: ProviderResponse | null;
  onClose: () => void;
}) {
  const del = useDeleteProvider();
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
          <DialogTitle>Remove provider</DialogTitle>
          <DialogDescription>
            {target ? `"${target.name}" will no longer be used for streaming. This cannot be undone.` : ""}
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
          <Server className="size-6" />
        </span>
        <p className="text-sm text-muted-foreground">No Usenet providers configured yet.</p>
        <Button onClick={onAdd}>
          <Plus className="size-4" />
          Add your first provider
        </Button>
      </CardContent>
    </Card>
  );
}

function SkeletonList() {
  return (
    <div className="space-y-2">
      {Array.from({ length: 2 }).map((_, i) => (
        <div key={i} className="h-16 w-full animate-pulse rounded-lg bg-muted" />
      ))}
    </div>
  );
}
