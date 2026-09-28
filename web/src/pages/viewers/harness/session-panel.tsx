import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Eraser, KeyRound, Loader2, LogOut, RefreshCw, ShieldAlert, ShieldCheck, UserRound } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { redactToken } from "@/lib/viewer-client";
import { ageLimitLabel, formatDateTime, initials } from "@/lib/viewers";
import { futureTime } from "@/lib/utils";
import { Hint, InlineError, Panel, TextField, ToneBadge, ViewerChip } from "../shared";
import { harnessKeys, useAuthOptions, useHarness, useNow, useSessionId, useViewerProfile } from "./use-harness";

function countdown(iso: string, now: number): string {
  const ms = Date.parse(iso) - now;
  if (!Number.isFinite(ms)) return "—";
  if (ms <= 0) return "expired — the next call refreshes";
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}h ${String(m).padStart(2, "0")}m ${s}s` : `${m}:${s}`;
}

export function SessionPanel() {
  const { client, tokens } = useHarness();
  const profile = useViewerProfile();
  const now = useNow();
  const refresh = useMutation({
    mutationFn: () => client.refresh(),
    onSuccess: () => toast.success("Tokens rotated — the old refresh token is now spent."),
  });
  const logout = useMutation({
    mutationFn: () => client.logout(),
    onSuccess: () => toast.success("Signed out; the session was revoked on the server."),
    onError: () => toast.error("Sign-out failed on the server; the tokens were dropped locally anyway."),
  });
  if (!tokens) return null;
  const viewer = profile.data;
  const name = viewer?.displayName || viewer?.username || "…";

  return (
    <Panel
      icon={<UserRound />}
      title="Viewer session"
      description="What a viewer app knows after signing in. Tokens stay in this tab’s memory only."
    >
      <div className="flex flex-wrap items-start gap-3">
        <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-cyan-500/15 text-sm font-semibold text-cyan-800 dark:bg-cyan-400/15 dark:text-cyan-200" aria-hidden>
          {initials(name)}
        </span>
        <div className="min-w-0 flex-1 basis-56 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <p className="truncate text-base font-semibold">{name}</p>
            <ViewerChip />
          </div>
          <p className="truncate font-mono text-xs text-muted-foreground">
            @{viewer?.username ?? "…"}
            {viewer?.email ? ` · ${viewer.email}${viewer.emailVerified ? "" : " (unverified)"}` : " · no email"}
          </p>
          {viewer && (
            <div className="flex flex-wrap gap-1">
              {viewer.twoFactorEnabled ? (
                <ToneBadge tone="success"><ShieldCheck className="mr-1 size-3" />2FA on · {viewer.recoveryCodesRemaining ?? 0} recovery codes</ToneBadge>
              ) : (
                <ToneBadge tone="muted">2FA off</ToneBadge>
              )}
              <ToneBadge tone="info">Age limit: {ageLimitLabel(viewer.permissions?.maxAge)}</ToneBadge>
              {viewer.mustChangePassword && <ToneBadge tone="warning">Must change password</ToneBadge>}
            </div>
          )}
        </div>
      </div>

      <InlineError error={profile.error} />

      <dl className="grid gap-px overflow-hidden rounded-lg border bg-border text-xs sm:grid-cols-2">
        <TokenCell label="Access token" value={redactToken(tokens.accessToken)} detail={`expires in ${countdown(tokens.accessExpiresAt, now)}`} />
        <TokenCell
          label="Refresh token"
          value={redactToken(tokens.refreshToken)}
          detail={`valid ${futureTime(tokens.refreshExpiresAt, now)} · ${formatDateTime(tokens.refreshExpiresAt)}`}
        />
      </dl>
      <p className="font-mono text-[11px] text-muted-foreground">session {tokens.sessionId}</p>

      <InlineError error={refresh.error} />
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => refresh.mutate()} disabled={refresh.isPending}>
          {refresh.isPending ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          Refresh tokens
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={() => logout.mutate()} disabled={logout.isPending}>
          {logout.isPending ? <Loader2 className="animate-spin" /> : <LogOut />}
          Sign out
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => client.forget()}
          title="Drop the tokens without telling the server; the device stays listed until it expires or is revoked."
        >
          <Eraser />Forget tokens locally
        </Button>
      </div>
    </Panel>
  );
}

function TokenCell({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="min-w-0 bg-card px-3 py-2">
      <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 truncate font-mono text-sm">{value}</dd>
      <dd className="truncate text-[11px] tabular-nums text-muted-foreground">{detail}</dd>
    </div>
  );
}

/** Admin-assigned passwords must be replaced before any other viewer endpoint answers. */
export function ForcedPasswordChange() {
  const { client } = useHarness();
  const qc = useQueryClient();
  const sid = useSessionId();
  const options = useAuthOptions();
  const minLength = options.data?.passwordMinLength ?? 8;
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const change = useMutation({
    mutationFn: () => client.changePassword({ currentPassword: current, newPassword: next }),
    onSuccess: () => {
      toast.success("Password changed — the account is unlocked for this session.");
      void qc.invalidateQueries({ queryKey: harnessKeys.session(sid) });
    },
  });
  const probe = useMutation({ mutationFn: () => client.resume(1) });
  const mismatch = confirm.length > 0 && confirm !== next;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!mismatch) change.mutate();
  }

  return (
    <Panel
      tone="warning"
      icon={<ShieldAlert />}
      title="Password change required"
      description={
        <>
          An administrator assigned this password. Until it is changed, every other viewer endpoint answers 403{" "}
          <code className="font-mono">password_change_required</code>.
        </>
      }
    >
      <form onSubmit={submit} className="space-y-3" aria-label="Change the assigned password">
        <div className="grid gap-3 sm:grid-cols-3">
          <TextField id="forced-current" label="Current password" type="password" autoComplete="off" value={current} onChange={(event) => setCurrent(event.target.value)} />
          <TextField id="forced-new" label="New password" type="password" autoComplete="off" hint={`At least ${minLength} characters.`} value={next} onChange={(event) => setNext(event.target.value)} />
          <TextField id="forced-confirm" label="Repeat new password" type="password" autoComplete="off" error={mismatch ? "Does not match" : undefined} value={confirm} onChange={(event) => setConfirm(event.target.value)} />
        </div>
        <InlineError error={change.error} />
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={!current || !next || mismatch || change.isPending}>
            {change.isPending ? <Loader2 className="animate-spin" /> : <KeyRound />}
            Change password
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => probe.mutate()} disabled={probe.isPending}>
            Try a blocked endpoint
          </Button>
        </div>
        {probe.isError && <InlineError error={probe.error} />}
        {probe.isSuccess && <Hint tone="success">The endpoint answered — the password change requirement is gone.</Hint>}
      </form>
    </Panel>
  );
}
