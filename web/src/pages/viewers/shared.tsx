import { useState, type InputHTMLAttributes, type ReactNode, type Ref } from "react";
import { AlertTriangle, Loader2, Power, UserRound } from "lucide-react";
import { toast } from "sonner";
import { errorMessage } from "@/api/client";
import { useUpdateViewerSettings, useViewerSettings } from "@/api/queries";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

export { ErrorPanel, LoadingBlock, ProgressBar, ToneBadge, selectClassName } from "@/pages/transcoding/shared";

export const cyanIcon = "text-cyan-600 dark:text-cyan-400";

/** Marks an account as a viewer (watch) account, as opposed to an administrator. */
export function ViewerChip({ className }: { className?: string }) {
  return (
    <Badge
      className={cn(
        "gap-1 border-cyan-500/30 bg-cyan-500/10 px-2 py-0 text-[11px] font-medium text-cyan-800 dark:border-cyan-400/30 dark:bg-cyan-400/10 dark:text-cyan-200",
        className,
      )}
      title="Viewer account — not an administrator; cannot sign in to this console"
    >
      <UserRound className="size-3" aria-hidden />
      Viewer
    </Badge>
  );
}

export function SectionHeading({
  id,
  icon,
  title,
  detail,
  action,
}: {
  id?: string;
  icon: ReactNode;
  title: string;
  detail?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start gap-x-3 gap-y-2 px-1">
      <span className={cn("mt-0.5 [&_svg]:size-4", cyanIcon)}>{icon}</span>
      <div className="min-w-0 flex-1 basis-56">
        <h3 id={id} className="text-sm font-semibold">{title}</h3>
        {detail && <p className="text-xs leading-5 text-muted-foreground">{detail}</p>}
      </div>
      {action}
    </div>
  );
}

/** Bordered card with a titled header; used by the settings form and the harness panels. */
export function Panel({
  icon,
  title,
  description,
  action,
  children,
  className,
  tone,
}: {
  icon: ReactNode;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  tone?: "warning";
}) {
  return (
    <section
      className={cn(
        "min-w-0 rounded-xl border bg-card",
        tone === "warning" && "border-amber-500/50 ring-1 ring-amber-500/20",
        className,
      )}
      aria-label={title}
    >
      <header
        className={cn(
          "flex flex-wrap items-start gap-2 border-b bg-muted/20 px-4 py-3 dark:bg-zinc-900/40",
          tone === "warning" && "bg-amber-500/10 dark:bg-amber-500/10",
        )}
      >
        <div className="min-w-0 flex-1 basis-48">
          <h3
            className={cn(
              "flex items-center gap-2 text-sm font-semibold [&_svg]:size-4",
              tone === "warning" ? "[&_svg]:text-amber-600 dark:[&_svg]:text-amber-400" : "[&_svg]:text-cyan-600 dark:[&_svg]:text-cyan-400",
            )}
          >
            {icon}
            {title}
          </h3>
          {description && <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{description}</p>}
        </div>
        {action}
      </header>
      <div className="space-y-4 p-4">{children}</div>
    </section>
  );
}

export function Hint({ tone = "muted", children, className }: { tone?: "muted" | "warning" | "info" | "success"; children: ReactNode; className?: string }) {
  return (
    <p
      className={cn(
        "rounded-md px-3 py-2 text-xs leading-5",
        tone === "muted" && "bg-muted/60 text-muted-foreground",
        tone === "warning" && "border border-amber-500/30 bg-amber-500/10 text-amber-900 dark:text-amber-200",
        tone === "info" && "border border-cyan-500/30 bg-cyan-500/10 text-cyan-900 dark:text-cyan-100",
        tone === "success" && "border border-emerald-500/30 bg-emerald-500/10 text-emerald-900 dark:text-emerald-200",
        className,
      )}
    >
      {children}
    </p>
  );
}

/** Callout shown while the module is off; one click switches it on. */
export function ModuleDisabledCallout() {
  const settings = useViewerSettings();
  const update = useUpdateViewerSettings();
  if (!settings.data || settings.data.enabled) return null;

  async function enable() {
    try {
      await update.mutateAsync({ enabled: true });
      toast.success("Viewer module enabled.");
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  return (
    <div
      className="flex flex-wrap items-start gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-950 dark:text-amber-100"
      role="status"
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
      <div className="min-w-0 flex-1 basis-64 space-y-1">
        <p className="font-semibold">The viewer module is switched off</p>
        <p className="text-xs leading-5 text-amber-900/90 dark:text-amber-200/90">
          Every <code className="font-mono">/api/v1/viewer</code> endpoint answers 404 <code className="font-mono">module_disabled</code>, so
          viewer apps (and the test harness) cannot sign in. Accounts can still be prepared here.
        </p>
      </div>
      <Button type="button" size="sm" onClick={enable} disabled={update.isPending}>
        {update.isPending ? <Loader2 className="animate-spin" /> : <Power />}
        Enable module
      </Button>
    </div>
  );
}

export interface ConfirmOptions {
  title: string;
  description: ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  onConfirm: () => Promise<void>;
}

/** Small confirm dialog driven by a state object; closes itself when the action succeeds. */
export function ConfirmDialog({ options, onClose }: { options: ConfirmOptions | null; onClose: () => void }) {
  const [pending, setPending] = useState(false);

  async function confirm() {
    if (!options) return;
    setPending(true);
    try {
      await options.onConfirm();
      onClose();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={options !== null} onOpenChange={(open) => !open && !pending && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{options?.title}</DialogTitle>
          <DialogDescription asChild>
            <div>{options?.description}</div>
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="button" variant={options?.destructive ? "destructive" : "default"} onClick={confirm} disabled={pending}>
            {pending && <Loader2 className="animate-spin" />}
            {options?.confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function SwitchField({
  id,
  label,
  description,
  checked,
  onCheckedChange,
  disabled,
}: {
  id: string;
  label: string;
  description?: ReactNode;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className={cn("flex items-start justify-between gap-4", disabled && "opacity-60")}>
      <div className="min-w-0 space-y-1">
        <Label htmlFor={id}>{label}</Label>
        {description && <p className="text-xs leading-5 text-muted-foreground">{description}</p>}
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} aria-label={label} />
    </div>
  );
}

/** Labelled text input with hint/error line; spreads the rest onto the input (e.g. react-hook-form's register). */
export function TextField({
  id,
  label,
  hint,
  error,
  className,
  unit,
  ...input
}: {
  id: string;
  label: string;
  hint?: ReactNode;
  error?: string;
  className?: string;
  unit?: string;
} & InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement> }) {
  const describedBy = error || hint ? `${id}-${error ? "error" : "hint"}` : undefined;
  return (
    <div className={cn("min-w-0 space-y-2", className)}>
      <Label htmlFor={id}>{label}</Label>
      <div className="relative">
        <Input id={id} aria-invalid={!!error} aria-describedby={describedBy} className={unit ? "pr-16" : undefined} {...input} />
        {unit && (
          <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-muted-foreground">{unit}</span>
        )}
      </div>
      {(error || hint) && (
        <p id={describedBy} className={error ? "text-xs text-destructive" : "text-xs leading-5 text-muted-foreground"}>
          {error ?? hint}
        </p>
      )}
    </div>
  );
}

export function InlineError({ error }: { error: unknown }) {
  if (!error) return null;
  const code = typeof error === "object" && error && "code" in error ? String((error as { code: unknown }).code) : null;
  const status = typeof error === "object" && error && "status" in error ? Number((error as { status: unknown }).status) : null;
  return (
    <p className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive" role="alert">
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 break-words">
        {status ? <span className="font-mono">{status} {code} · </span> : null}
        {errorMessage(error)}
      </span>
    </p>
  );
}
