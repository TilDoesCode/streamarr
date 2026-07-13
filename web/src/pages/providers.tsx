import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  ArrowDown,
  ArrowUp,
  CheckCircle2,
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
  useTestProvider,
  useUpdateProvider,
} from "@/api/queries";
import type { ProviderResponse, ProviderTestResult, ProviderWrite } from "@/api/types";
import { errorMessage } from "@/api/client";

const schema = z.object({
  name: z.string().trim().min(1, "A name is required"),
  host: z.string().trim().min(1, "A host is required"),
  port: z.coerce.number().int("Whole number").min(1, "1–65535").max(65535, "1–65535"),
  useSsl: z.boolean(),
  username: z.string().optional(),
  password: z.string().optional(),
  maxConnections: z.coerce.number().int("Whole number").min(1, "At least 1"),
  priority: z.coerce.number().int("Whole number").min(0, "Cannot be negative"),
  enabled: z.boolean(),
  isBackupOnly: z.boolean(),
});
type FormValues = z.input<typeof schema>;

export function ProvidersPage() {
  const { data, isLoading, isError, error } = useProviders();
  const [editing, setEditing] = useState<ProviderResponse | null>(null);
  const [creating, setCreating] = useState(false);
  const [toDelete, setToDelete] = useState<ProviderResponse | null>(null);

  const sorted = [...(data ?? [])].sort(
    (a, b) => (a.priority ?? 0) - (b.priority ?? 0) || (a.name ?? "").localeCompare(b.name ?? ""),
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Usenet Providers</h2>
          <p className="text-sm text-muted-foreground">
            Priority-ordered NNTP providers (primary + block-account fallback). Lower priority is
            tried first (BRIEF §9.1, DECISIONS #6).
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
  onEdit,
  onDelete,
}: {
  provider: ProviderResponse;
  isFirst: boolean;
  isLast: boolean;
  neighborAbove?: ProviderResponse;
  neighborBelow?: ProviderResponse;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const update = useUpdateProvider();
  const test = useTestProvider();
  const [result, setResult] = useState<ProviderTestResult | null>(null);

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

  async function swapWith(other?: ProviderResponse) {
    if (!other) return;
    try {
      await Promise.all([
        update.mutateAsync({
          id: provider.id!,
          body: { ...writeFrom(provider), priority: other.priority ?? 0 },
        }),
        update.mutateAsync({
          id: other.id!,
          body: { ...writeFrom(other), priority: provider.priority ?? 0 },
        }),
      ]);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  async function runTest() {
    setResult(null);
    try {
      const res = await test.mutateAsync(provider.id!);
      setResult(res);
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
      <div className="flex items-center gap-3 p-3">
        <div className="flex flex-col">
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            disabled={isFirst || update.isPending}
            aria-label={`Move ${provider.name} up`}
            onClick={() => swapWith(neighborAbove)}
          >
            <ArrowUp className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            disabled={isLast || update.isPending}
            aria-label={`Move ${provider.name} down`}
            onClick={() => swapWith(neighborBelow)}
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

        <div className="flex items-center gap-1">
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
            Test
          </Button>
          <Button variant="ghost" size="icon" aria-label={`Edit ${provider.name}`} onClick={onEdit}>
            <Pencil className="size-4" />
          </Button>
          <Button variant="ghost" size="icon" aria-label={`Delete ${provider.name}`} onClick={onDelete}>
            <Trash2 className="size-4 text-destructive" />
          </Button>
        </div>
      </div>

      {result && (
        <div className="border-t px-3 py-2 text-xs">
          {result.success ? (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-muted-foreground">
              <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                <CheckCircle2 className="size-3.5" /> Authenticated
              </span>
              <span>
                {result.achievableConnections} / {result.requestedConnections} connections
              </span>
            </div>
          ) : (
            <span className="inline-flex items-center gap-1 text-destructive">
              <XCircle className="size-3.5" /> {result.error ?? "Connection failed"}
            </span>
          )}
        </div>
      )}
    </li>
  );
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
          <div className="grid grid-cols-[1fr_7rem] gap-4">
            <Field id="host" label="Host" error={errors.host?.message}>
              <Input id="host" placeholder="news.example.com" aria-invalid={!!errors.host} {...register("host")} />
            </Field>
            <Field id="port" label="Port" error={errors.port?.message}>
              <Input id="port" type="number" min={1} max={65535} aria-invalid={!!errors.port} {...register("port")} />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-4">
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
          <div className="grid grid-cols-2 gap-4">
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
