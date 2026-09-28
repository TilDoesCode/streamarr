import { useState, type ReactNode } from "react";
import { History, KeyRound, LockOpen, LogOut, MailCheck, MailWarning, Pencil, ShieldCheck, ShieldOff, Trash2, UserPlus, UsersRound } from "lucide-react";
import { toast } from "sonner";
import { errorMessage } from "@/api/client";
import { useDeleteViewer, useResetViewerTwoFactor, useUpdateViewer, useViewerSettings, useViewers } from "@/api/queries";
import type { ViewerAdminResponse } from "@/api/types";
import { EmptyOpsState } from "@/components/ops-page";
import { Button } from "@/components/ui/button";
import { cn, timeAgo } from "@/lib/utils";
import { ageLimitLabel, formatDateTime, initials, permissionsSummary } from "@/lib/viewers";
import {
  ConfirmDialog,
  ErrorPanel,
  LoadingBlock,
  ModuleDisabledCallout,
  SectionHeading,
  ToneBadge,
  ViewerChip,
  type ConfirmOptions,
} from "./shared";
import {
  DevicesDialog,
  OneTimePasswordDialog,
  SetPasswordDialog,
  ViewerFormDialog,
  WatchHistoryDialog,
  type OneTimePassword,
} from "./viewer-dialogs";

type RowDialog = { kind: "edit" | "password" | "devices" | "history"; viewer: ViewerAdminResponse } | { kind: "create" } | null;

const ROW_GRID =
  "xl:grid-cols-[minmax(0,2.3fr)_minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,0.7fr)_minmax(0,1fr)_minmax(0,0.9fr)_12.75rem]";

export function AccountsTab() {
  const viewers = useViewers();
  const settings = useViewerSettings();
  const deleteViewer = useDeleteViewer();
  const resetTwoFactor = useResetViewerTwoFactor();
  const [dialog, setDialog] = useState<RowDialog>(null);
  const [confirm, setConfirm] = useState<ConfirmOptions | null>(null);
  const [secret, setSecret] = useState<OneTimePassword | null>(null);
  const minLength = settings.data?.passwordMinLength ?? 8;
  const list = viewers.data ?? [];
  const close = () => setDialog(null);

  function askDelete(viewer: ViewerAdminResponse) {
    setConfirm({
      title: `Delete @${viewer.username}?`,
      description: "The account, its devices and its entire watch state are removed permanently. Signed-in apps stop working immediately.",
      confirmLabel: "Delete viewer",
      destructive: true,
      onConfirm: async () => {
        await deleteViewer.mutateAsync(viewer.id ?? "");
        toast.success(`Deleted @${viewer.username}.`);
      },
    });
  }

  function askResetTwoFactor(viewer: ViewerAdminResponse) {
    setConfirm({
      title: `Reset two-factor for @${viewer.username}?`,
      description: "Removes the authenticator app and all recovery codes, e.g. after a lost phone. The viewer signs in with the password alone until they set it up again.",
      confirmLabel: "Reset two-factor",
      destructive: true,
      onConfirm: async () => {
        await resetTwoFactor.mutateAsync(viewer.id ?? "");
        toast.success(`Two-factor removed from @${viewer.username}.`);
      },
    });
  }

  return (
    <div className="space-y-4">
      <ModuleDisabledCallout />
      <SectionHeading
        id="viewer-accounts-heading"
        icon={<UsersRound />}
        title="Viewer accounts"
        detail="People who watch. Viewer accounts are not administrators and cannot sign in to this console."
        action={
          <Button type="button" size="sm" onClick={() => setDialog({ kind: "create" })}>
            <UserPlus />New viewer
          </Button>
        }
      />

      {viewers.isLoading ? (
        <LoadingBlock label="Loading viewer accounts" />
      ) : viewers.isError ? (
        <ErrorPanel message={errorMessage(viewers.error)} />
      ) : list.length === 0 ? (
        <EmptyOpsState
          icon={<UsersRound className="size-5" />}
          title="No viewer accounts yet"
          description="Create one account per person who watches. They sign in with a viewer app — never with this management console. Try it out right away in the Test harness tab."
        />
      ) : (
        <div className="overflow-hidden rounded-xl border bg-card">
          <div
            className={cn(
              "hidden gap-4 border-b bg-muted/30 px-4 py-2 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground dark:bg-zinc-900/40 xl:grid",
              ROW_GRID,
            )}
            aria-hidden
          >
            <span>Viewer</span>
            <span>Email</span>
            <span>Age limit</span>
            <span>Devices</span>
            <span>Watched</span>
            <span>Last login</span>
            <span className="text-right">Actions</span>
          </div>
          <ul className="divide-y" aria-labelledby="viewer-accounts-heading">
            {list.map((viewer) => (
              <ViewerRow
                key={viewer.id}
                viewer={viewer}
                onEdit={() => setDialog({ kind: "edit", viewer })}
                onPassword={() => setDialog({ kind: "password", viewer })}
                onDevices={() => setDialog({ kind: "devices", viewer })}
                onHistory={() => setDialog({ kind: "history", viewer })}
                onResetTwoFactor={() => askResetTwoFactor(viewer)}
                onDelete={() => askDelete(viewer)}
              />
            ))}
          </ul>
        </div>
      )}

      <ViewerFormDialog
        open={dialog?.kind === "create" || dialog?.kind === "edit"}
        viewer={dialog?.kind === "edit" ? dialog.viewer : undefined}
        passwordMinLength={minLength}
        onClose={close}
        onGeneratedPassword={setSecret}
      />
      <SetPasswordDialog viewer={dialog?.kind === "password" ? dialog.viewer : null} passwordMinLength={minLength} onClose={close} />
      <DevicesDialog viewer={dialog?.kind === "devices" ? dialog.viewer : null} onClose={close} />
      <WatchHistoryDialog viewer={dialog?.kind === "history" ? dialog.viewer : null} onClose={close} />
      <OneTimePasswordDialog secret={secret} onClose={() => setSecret(null)} />
      <ConfirmDialog options={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
}

function ViewerRow({
  viewer,
  onEdit,
  onPassword,
  onDevices,
  onHistory,
  onResetTwoFactor,
  onDelete,
}: {
  viewer: ViewerAdminResponse;
  onEdit: () => void;
  onPassword: () => void;
  onDevices: () => void;
  onHistory: () => void;
  onResetTwoFactor: () => void;
  onDelete: () => void;
}) {
  const update = useUpdateViewer();
  const name = viewer.displayName || viewer.username || "—";
  const locked = !!viewer.lockedUntil && Date.parse(viewer.lockedUntil) > Date.now();
  const notes = permissionsSummary(viewer.permissions);
  const handle = `@${viewer.username}`;

  async function unlock() {
    try {
      await update.mutateAsync({ id: viewer.id ?? "", body: { unlock: true } });
      toast.success(`${handle} unlocked.`);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  return (
    <li
      className={cn("grid grid-cols-2 gap-x-4 gap-y-3 p-4 sm:grid-cols-4 xl:items-center xl:gap-4 xl:py-3", ROW_GRID)}
      aria-label={`${name} (${handle})`}
    >
      <div className="col-span-2 flex min-w-0 items-start gap-3 sm:col-span-4 xl:col-span-1">
        <span
          className={cn(
            "flex size-9 shrink-0 items-center justify-center rounded-full bg-cyan-500/15 text-xs font-semibold text-cyan-800 dark:bg-cyan-400/15 dark:text-cyan-200",
            viewer.disabled && "opacity-50",
          )}
          aria-hidden
        >
          {initials(name)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <p className={cn("min-w-0 truncate font-medium", viewer.disabled && "text-muted-foreground")}>{name}</p>
            <ViewerChip />
          </div>
          <p className="truncate font-mono text-xs text-muted-foreground">{handle}</p>
          {(viewer.twoFactorEnabled || viewer.disabled || locked || viewer.mustChangePassword) && (
            <div className="mt-1.5 flex flex-wrap items-center gap-1">
              {viewer.twoFactorEnabled && <ToneBadge tone="success"><ShieldCheck className="mr-1 size-3" />2FA</ToneBadge>}
              {viewer.disabled && <ToneBadge tone="danger">Disabled</ToneBadge>}
              {locked && (
                <span className="inline-flex items-center gap-1">
                  <ToneBadge tone="warning">
                    <span title={`Locked until ${formatDateTime(viewer.lockedUntil)}`}>Locked</span>
                  </ToneBadge>
                  <Button type="button" size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={unlock} disabled={update.isPending} aria-label={`Unlock ${handle}`}>
                    <LockOpen />Unlock
                  </Button>
                </span>
              )}
              {viewer.mustChangePassword && <ToneBadge tone="info">Must change password</ToneBadge>}
            </div>
          )}
        </div>
      </div>

      <Cell label="Email" className="col-span-2 xl:col-span-1">
        {viewer.email ? (
          <span className="flex min-w-0 items-center gap-1.5">
            {viewer.emailVerified ? (
              <MailCheck className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />
            ) : (
              <MailWarning className="size-3.5 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
            )}
            <span className="truncate" title={viewer.email}>{viewer.email}</span>
            <span className="sr-only">{viewer.emailVerified ? "(verified)" : "(not verified)"}</span>
          </span>
        ) : (
          <span className="text-muted-foreground">No email</span>
        )}
        {viewer.pendingEmail && <span className="block truncate text-xs text-muted-foreground">pending: {viewer.pendingEmail}</span>}
      </Cell>

      <Cell label="Age limit">
        {ageLimitLabel(viewer.permissions?.maxAge)}
        {notes.length > 0 && <span className="block text-xs text-muted-foreground">{notes.join(" · ")}</span>}
      </Cell>

      <Cell label="Devices">
        <span className="tabular-nums">{viewer.activeSessions ?? 0}</span>
        <span className="text-xs text-muted-foreground"> active</span>
      </Cell>

      <Cell label="Watched" className="sm:col-span-2 xl:col-span-1">
        <span className="block">
          <span className="tabular-nums">{viewer.playedCount ?? 0}</span>
          <span className="text-xs text-muted-foreground"> played</span>
        </span>
        <span className="block">
          <span className="tabular-nums">{viewer.inProgressCount ?? 0}</span>
          <span className="text-xs text-muted-foreground"> in progress</span>
        </span>
      </Cell>

      <Cell label="Last login" className="sm:col-span-2 xl:col-span-1">
        <span title={formatDateTime(viewer.lastLoginAt)}>{viewer.lastLoginAt ? timeAgo(viewer.lastLoginAt) : "Never"}</span>
      </Cell>

      <div className="col-span-2 flex flex-wrap gap-1.5 sm:col-span-4 xl:col-span-1 xl:flex-nowrap xl:justify-end xl:gap-0.5">
        <RowAction icon={<Pencil />} label="Edit" handle={handle} onClick={onEdit} />
        <RowAction icon={<KeyRound />} label="Set password" handle={handle} onClick={onPassword} />
        {viewer.twoFactorEnabled && <RowAction icon={<ShieldOff />} label="Reset 2FA" handle={handle} onClick={onResetTwoFactor} />}
        <RowAction icon={<LogOut />} label="Sign out everywhere" handle={handle} onClick={onDevices} />
        <RowAction icon={<History />} label="Watch history" handle={handle} onClick={onHistory} />
        <RowAction icon={<Trash2 />} label="Delete" handle={handle} onClick={onDelete} destructive />
      </div>
    </li>
  );
}

function Cell({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  return (
    <div className={cn("min-w-0 text-sm", className)}>
      <p className="mb-0.5 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground xl:sr-only">{label}</p>
      {children}
    </div>
  );
}

function RowAction({
  icon,
  label,
  handle,
  onClick,
  destructive = false,
}: {
  icon: ReactNode;
  label: string;
  handle: string;
  onClick: () => void;
  destructive?: boolean;
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      onClick={onClick}
      aria-label={`${label} ${handle}`}
      title={label}
      className={cn(
        "xl:size-8 xl:border-transparent xl:bg-transparent xl:p-0 xl:shadow-none",
        destructive && "text-destructive hover:text-destructive",
      )}
    >
      {icon}
      <span className="xl:hidden">{label}</span>
    </Button>
  );
}
