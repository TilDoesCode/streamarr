import { useState, type FormEvent, type ReactNode } from "react";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Check, History, KeyRound, Loader2, LogOut, MonitorSmartphone, Save, Trash2, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { errorMessage } from "@/api/client";
import {
  useClearViewerWatchState,
  useCreateViewer,
  useRevokeViewerSessions,
  useSetViewerPassword,
  useUpdateViewer,
  useViewerSessions,
  useViewerWatchState,
} from "@/api/queries";
import type { ViewerAdminResponse, ViewerPermissionsDto, WatchStateResponse } from "@/api/types";
import { CopyButton } from "@/components/code-disclosure";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { cn, formatTicks, timeAgo } from "@/lib/utils";
import { AGE_LIMITS, ageLimitLabel, episodeLabel, formatDateTime } from "@/lib/viewers";
import {
  ErrorPanel,
  Hint,
  LoadingBlock,
  ProgressBar,
  SwitchField,
  TextField,
  ToneBadge,
  ViewerChip,
  selectClassName,
} from "./shared";

const USERNAME = /^[A-Za-z0-9][A-Za-z0-9._-]{2,31}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function viewerFormSchema(mode: "create" | "edit", minLength: number) {
  return z
    .object({
      username: z.string().trim(),
      displayName: z.string().trim().max(64, "At most 64 characters"),
      email: z.string().trim().refine((value) => value === "" || EMAIL.test(value), "Enter a valid email address"),
      passwordMode: z.enum(["generate", "set"]),
      password: z.string(),
      mustChangePassword: z.boolean(),
      maxAge: z.string(),
      blockUnrated: z.boolean(),
      allowTranscoding: z.boolean(),
      maxConcurrentStreams: z
        .string()
        .trim()
        .refine((value) => value === "" || (/^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 20), "1–20, or empty for unlimited"),
      disabled: z.boolean(),
      unlock: z.boolean(),
    })
    .superRefine((values, ctx) => {
      if (mode !== "create") return;
      if (!USERNAME.test(values.username)) {
        ctx.addIssue({ code: "custom", path: ["username"], message: "3–32 characters: letters, digits, “.”, “_” or “-”, starting with a letter or digit" });
      }
      if (values.passwordMode === "set" && values.password.length < minLength) {
        ctx.addIssue({ code: "custom", path: ["password"], message: `At least ${minLength} characters` });
      }
    });
}

type FormValues = z.infer<ReturnType<typeof viewerFormSchema>>;

function permissionsFrom(values: FormValues): ViewerPermissionsDto {
  return {
    maxAge: values.maxAge === "" ? null : Number(values.maxAge),
    blockUnrated: values.blockUnrated,
    allowTranscoding: values.allowTranscoding,
    maxConcurrentStreams: values.maxConcurrentStreams === "" ? null : Number(values.maxConcurrentStreams),
  };
}

function defaults(viewer?: ViewerAdminResponse): FormValues {
  return {
    username: viewer?.username ?? "",
    displayName: viewer?.displayName ?? "",
    email: viewer?.email ?? "",
    passwordMode: "generate",
    password: "",
    mustChangePassword: viewer?.mustChangePassword ?? true,
    maxAge: viewer?.permissions?.maxAge == null ? "" : String(viewer.permissions.maxAge),
    blockUnrated: viewer?.permissions?.blockUnrated ?? false,
    allowTranscoding: viewer?.permissions?.allowTranscoding ?? true,
    maxConcurrentStreams: viewer?.permissions?.maxConcurrentStreams == null ? "" : String(viewer.permissions.maxConcurrentStreams),
    disabled: viewer?.disabled ?? false,
    unlock: false,
  };
}

export interface OneTimePassword {
  username: string;
  password: string;
  mustChangePassword: boolean;
}

/** Create (no `viewer`) or edit an account. */
export function ViewerFormDialog({
  open,
  viewer,
  passwordMinLength,
  onClose,
  onGeneratedPassword,
}: {
  open: boolean;
  viewer?: ViewerAdminResponse;
  passwordMinLength: number;
  onClose: () => void;
  onGeneratedPassword: (secret: OneTimePassword) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-2xl">
        {open && (
          <ViewerForm viewer={viewer} passwordMinLength={passwordMinLength} onClose={onClose} onGeneratedPassword={onGeneratedPassword} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function ViewerForm({
  viewer,
  passwordMinLength,
  onClose,
  onGeneratedPassword,
}: {
  viewer?: ViewerAdminResponse;
  passwordMinLength: number;
  onClose: () => void;
  onGeneratedPassword: (secret: OneTimePassword) => void;
}) {
  const mode = viewer ? "edit" : "create";
  const create = useCreateViewer();
  const update = useUpdateViewer();
  const form = useForm<FormValues>({
    resolver: zodResolver(viewerFormSchema(mode, passwordMinLength)),
    defaultValues: defaults(viewer),
  });
  const errors = form.formState.errors;
  const passwordMode = form.watch("passwordMode");
  const maxAge = form.watch("maxAge");
  const pending = create.isPending || update.isPending;
  const locked = !!viewer?.lockedUntil && Date.parse(viewer.lockedUntil) > Date.now();

  async function submit(values: FormValues) {
    try {
      if (!viewer) {
        const created = await create.mutateAsync({
          username: values.username,
          displayName: values.displayName || undefined,
          email: values.email || undefined,
          password: values.passwordMode === "set" ? values.password : undefined,
          mustChangePassword: values.mustChangePassword,
          permissions: permissionsFrom(values),
          disabled: values.disabled,
        });
        if (created.generatedPassword) {
          onGeneratedPassword({
            username: created.viewer.username ?? values.username,
            password: created.generatedPassword,
            mustChangePassword: created.viewer.mustChangePassword ?? values.mustChangePassword,
          });
        } else {
          toast.success(`Viewer @${created.viewer.username} created.`);
        }
      } else {
        const emailChanged = values.email !== (viewer.email ?? "");
        await update.mutateAsync({
          id: viewer.id ?? "",
          body: {
            displayName: values.displayName,
            email: emailChanged ? values.email : undefined,
            disabled: values.disabled,
            mustChangePassword: values.mustChangePassword,
            unlock: values.unlock || undefined,
            permissions: permissionsFrom(values),
          },
        });
        toast.success(`Saved @${viewer.username}.`);
      }
      onClose();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  return (
    <form onSubmit={form.handleSubmit(submit)} className="space-y-5" noValidate aria-label={viewer ? "Edit viewer" : "New viewer"}>
      <DialogHeader>
        <DialogTitle className="flex flex-wrap items-center gap-2">
          {viewer ? `Edit @${viewer.username}` : "New viewer"}
          <ViewerChip />
        </DialogTitle>
        <DialogDescription>
          A watch account for one person. Viewers sign in through viewer apps — they are not administrators and cannot sign in to this console.
        </DialogDescription>
      </DialogHeader>

      <fieldset className="grid gap-4 sm:grid-cols-2">
        <legend className="sr-only">Identity</legend>
        {!viewer && (
          <TextField
            id="viewer-username"
            label="Username"
            autoComplete="off"
            spellCheck={false}
            hint="3–32 characters; used to sign in."
            error={errors.username?.message}
            {...form.register("username")}
          />
        )}
        <TextField
          id="viewer-display-name"
          label="Display name"
          placeholder={viewer?.username ?? "Defaults to the username"}
          error={errors.displayName?.message}
          {...form.register("displayName")}
        />
        <TextField
          id="viewer-email"
          label="Email (optional)"
          type="email"
          autoComplete="off"
          className={viewer ? undefined : "sm:col-span-2"}
          hint={viewer ? "Leave empty to remove. Addresses set here count as verified." : "Counts as verified; enables email codes and password reset."}
          error={errors.email?.message}
          {...form.register("email")}
        />
      </fieldset>

      {!viewer && (
        <fieldset className="space-y-3">
          <legend className="text-sm font-medium">Password</legend>
          <Controller
            control={form.control}
            name="passwordMode"
            render={({ field }) => (
              <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Password">
                <RadioCard name="password-mode" checked={field.value === "generate"} onChange={() => field.onChange("generate")} label="Generate" description="The server creates one and shows it once." />
                <RadioCard name="password-mode" checked={field.value === "set"} onChange={() => field.onChange("set")} label="Set" description="Type a password to hand over." />
              </div>
            )}
          />
          {passwordMode === "set" && (
            <TextField
              id="viewer-password"
              label="Initial password"
              type="password"
              autoComplete="new-password"
              hint={`At least ${passwordMinLength} characters.`}
              error={errors.password?.message}
              {...form.register("password")}
            />
          )}
        </fieldset>
      )}

      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-0.5 size-4 accent-cyan-600" {...form.register("mustChangePassword")} />
        <span>
          <span className="font-medium">Must change password at next sign-in</span>
          <span className="block text-xs leading-5 text-muted-foreground">Until then the viewer can only change the password and manage devices.</span>
        </span>
      </label>

      <fieldset className="space-y-4 rounded-lg border p-4">
        <legend className="px-1 text-sm font-medium">Permissions</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="viewer-max-age">Age limit</Label>
            <select id="viewer-max-age" className={selectClassName} {...form.register("maxAge")}>
              <option value="">Unrestricted</option>
              {[...AGE_LIMITS].reverse().map((age) => (
                <option key={age} value={String(age)}>{ageLimitLabel(age)}</option>
              ))}
            </select>
            <p className="text-xs leading-5 text-muted-foreground">Compared with the TMDB certification of a title.</p>
          </div>
          <TextField
            id="viewer-max-streams"
            label="Max concurrent streams"
            type="number"
            inputMode="numeric"
            min={1}
            max={20}
            placeholder="Unlimited"
            hint="1–20; empty = unlimited."
            error={errors.maxConcurrentStreams?.message}
            {...form.register("maxConcurrentStreams")}
          />
        </div>
        <Controller
          control={form.control}
          name="blockUnrated"
          render={({ field }) => (
            <SwitchField
              id="viewer-block-unrated"
              label="Block unrated titles"
              description={maxAge === "" ? "Only applies with an age limit." : "Titles without a TMDB certification are refused."}
              checked={field.value}
              onCheckedChange={field.onChange}
              disabled={maxAge === ""}
            />
          )}
        />
        <Controller
          control={form.control}
          name="allowTranscoding"
          render={({ field }) => (
            <SwitchField id="viewer-allow-transcoding" label="Allow transcoding" description="May start server-side transcodes; otherwise direct play only." checked={field.value} onCheckedChange={field.onChange} />
          )}
        />
      </fieldset>

      <div className="space-y-4">
        <Controller
          control={form.control}
          name="disabled"
          render={({ field }) => (
            <SwitchField id="viewer-disabled" label="Account disabled" description="Disabled viewers cannot sign in; disabling signs them out everywhere." checked={field.value} onCheckedChange={field.onChange} />
          )}
        />
        {locked && (
          <label className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-950 dark:text-amber-100">
            <input type="checkbox" className="mt-0.5 size-4 accent-cyan-600" {...form.register("unlock")} />
            <span>
              <span className="font-medium">Clear lockout</span>
              <span className="block text-xs leading-5">Locked after too many failed sign-ins until {formatDateTime(viewer?.lockedUntil)}.</span>
            </span>
          </label>
        )}
      </div>

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose} disabled={pending}>Cancel</Button>
        <Button type="submit" disabled={pending}>
          {pending ? <Loader2 className="animate-spin" /> : viewer ? <Save /> : <UserPlus />}
          {viewer ? "Save viewer" : "Create viewer"}
        </Button>
      </DialogFooter>
    </form>
  );
}

function RadioCard({ name, checked, onChange, label, description }: { name: string; checked: boolean; onChange: () => void; label: string; description: string }) {
  return (
    <label className="flex cursor-pointer items-start gap-2 rounded-lg border p-2.5 text-sm has-[:checked]:border-cyan-500/50 has-[:checked]:bg-cyan-500/10">
      <input type="radio" name={name} className="mt-0.5 accent-cyan-600" checked={checked} onChange={onChange} />
      <span>
        <span className="font-medium">{label}</span>
        <span className="block text-xs leading-5 text-muted-foreground">{description}</span>
      </span>
    </label>
  );
}

/** The generated password, shown exactly once. */
export function OneTimePasswordView({ secret }: { secret: OneTimePassword }) {
  return (
    <div className="space-y-3">
      <Hint tone="warning">
        Shown only once — copy it now and hand it to the viewer. It cannot be displayed again; set a new one if it gets lost.
      </Hint>
      <div className="flex items-center gap-2 rounded-md border bg-muted/50 p-2">
        <code className="min-w-0 flex-1 break-all font-mono text-sm" aria-label={`Generated password for @${secret.username}`}>
          {secret.password}
        </code>
        <CopyButton text={secret.password} label="Copy password" />
      </div>
      <p className="text-xs leading-5 text-muted-foreground">
        {secret.mustChangePassword
          ? `@${secret.username} has to choose a new password right after signing in.`
          : `@${secret.username} can keep using this password.`}
      </p>
    </div>
  );
}

export function OneTimePasswordDialog({ secret, onClose }: { secret: OneTimePassword | null; onClose: () => void }) {
  return (
    <Dialog open={secret !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Password for @{secret?.username}</DialogTitle>
          <DialogDescription>The account is ready. The viewer signs in with this username and password in a viewer app.</DialogDescription>
        </DialogHeader>
        {secret && <OneTimePasswordView secret={secret} />}
        <DialogFooter>
          <Button type="button" onClick={onClose}><Check />I copied it</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function SetPasswordDialog({
  viewer,
  passwordMinLength,
  onClose,
}: {
  viewer: ViewerAdminResponse | null;
  passwordMinLength: number;
  onClose: () => void;
}) {
  return (
    <Dialog open={viewer !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>{viewer && <SetPasswordForm viewer={viewer} passwordMinLength={passwordMinLength} onClose={onClose} />}</DialogContent>
    </Dialog>
  );
}

function SetPasswordForm({ viewer, passwordMinLength, onClose }: { viewer: ViewerAdminResponse; passwordMinLength: number; onClose: () => void }) {
  const setPassword = useSetViewerPassword();
  const [mode, setMode] = useState<"generate" | "set">("generate");
  const [password, setPasswordValue] = useState("");
  const [mustChange, setMustChange] = useState(true);
  const [result, setResult] = useState<OneTimePassword | null>(null);
  const tooShort = mode === "set" && password.length < passwordMinLength;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (tooShort) return;
    try {
      const response = await setPassword.mutateAsync({
        id: viewer.id ?? "",
        body: { password: mode === "set" ? password : undefined, mustChangePassword: mustChange },
      });
      if (response?.generatedPassword) {
        setResult({ username: viewer.username ?? "", password: response.generatedPassword, mustChangePassword: mustChange });
      } else {
        toast.success(`New password set for @${viewer.username}; signed out everywhere.`);
        onClose();
      }
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  if (result) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>New password for @{viewer.username}</DialogTitle>
          <DialogDescription>The viewer was signed out on every device.</DialogDescription>
        </DialogHeader>
        <OneTimePasswordView secret={result} />
        <DialogFooter>
          <Button type="button" onClick={onClose}><Check />I copied it</Button>
        </DialogFooter>
      </>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-4" noValidate aria-label="Set password">
      <DialogHeader>
        <DialogTitle>Set password for @{viewer.username}</DialogTitle>
        <DialogDescription>Replaces the current password and signs the viewer out on every device.</DialogDescription>
      </DialogHeader>
      <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="New password">
        <RadioCard name="set-password-mode" checked={mode === "generate"} onChange={() => setMode("generate")} label="Generate" description="Shown once after saving." />
        <RadioCard name="set-password-mode" checked={mode === "set"} onChange={() => setMode("set")} label="Set" description="Type the new password." />
      </div>
      {mode === "set" && (
        <TextField
          id="set-password"
          label="New password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(event) => setPasswordValue(event.target.value)}
          hint={`At least ${passwordMinLength} characters.`}
          error={password.length > 0 && tooShort ? `At least ${passwordMinLength} characters` : undefined}
        />
      )}
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-0.5 size-4 accent-cyan-600" checked={mustChange} onChange={(event) => setMustChange(event.target.checked)} />
        <span className="font-medium">Must change password at next sign-in</span>
      </label>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose} disabled={setPassword.isPending}>Cancel</Button>
        <Button type="submit" disabled={setPassword.isPending || tooShort}>
          {setPassword.isPending ? <Loader2 className="animate-spin" /> : <KeyRound />}
          {mode === "generate" ? "Generate password" : "Set password"}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** Active devices of one viewer with per-device and global sign-out. */
export function DevicesDialog({ viewer, onClose }: { viewer: ViewerAdminResponse | null; onClose: () => void }) {
  const id = viewer?.id ?? "";
  const sessions = useViewerSessions(id, { enabled: viewer !== null });
  const revoke = useRevokeViewerSessions();
  const list = sessions.data ?? [];

  async function signOut(sessionId?: string) {
    try {
      await revoke.mutateAsync({ id, sessionId });
      toast.success(sessionId ? "Device signed out." : `@${viewer?.username} was signed out everywhere.`);
      if (!sessionId) onClose();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  return (
    <Dialog open={viewer !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Devices of @{viewer?.username}</DialogTitle>
          <DialogDescription>Signing out revokes the refresh token; access tokens stop working immediately.</DialogDescription>
        </DialogHeader>
        {sessions.isLoading ? (
          <LoadingBlock label="Loading devices" className="h-24" />
        ) : sessions.isError ? (
          <ErrorPanel message={errorMessage(sessions.error)} />
        ) : list.length === 0 ? (
          <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">No active devices.</p>
        ) : (
          <ul className="divide-y rounded-lg border" aria-label="Active devices">
            {list.map((session) => (
              <li key={session.id} className="flex flex-wrap items-center gap-3 p-3">
                <MonitorSmartphone className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <div className="min-w-0 flex-1 basis-48">
                  <p className="truncate text-sm font-medium">{session.deviceName || "Unnamed device"}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {[session.clientName, session.authMethod, session.ipAddress].filter(Boolean).join(" · ")}
                  </p>
                  <p className="truncate text-[11px] text-muted-foreground" title={`Signed in ${formatDateTime(session.createdAt)}`}>
                    seen {timeAgo(session.lastSeenAt)} · signed in until {formatDateTime(session.refreshExpiresAt)}
                  </p>
                </div>
                <Button type="button" size="sm" variant="outline" onClick={() => signOut(session.id ?? "")} disabled={revoke.isPending} aria-label={`Sign out ${session.deviceName || "device"}`}>
                  <LogOut />Sign out
                </Button>
              </li>
            ))}
          </ul>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>Close</Button>
          <Button type="button" variant="destructive" onClick={() => signOut()} disabled={revoke.isPending}>
            {revoke.isPending ? <Loader2 className="animate-spin" /> : <LogOut />}
            Sign out everywhere
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function WatchHistoryDialog({ viewer, onClose }: { viewer: ViewerAdminResponse | null; onClose: () => void }) {
  const id = viewer?.id ?? "";
  const state = useViewerWatchState(id, { enabled: viewer !== null });
  const clear = useClearViewerWatchState();
  const [confirming, setConfirming] = useState(false);
  const items = state.data?.items ?? [];

  async function clearAll() {
    try {
      await clear.mutateAsync(id);
      toast.success(`Watch state of @${viewer?.username} cleared.`);
      setConfirming(false);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  return (
    <Dialog open={viewer !== null} onOpenChange={(open) => { if (!open) { setConfirming(false); onClose(); } }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><History className="size-4" />Watch history of @{viewer?.username}</DialogTitle>
          <DialogDescription>
            Resume points, played flags and play counts, most recent first
            {state.data ? ` · ${state.data.total} title${state.data.total === 1 ? "" : "s"}` : ""}.
          </DialogDescription>
        </DialogHeader>
        {state.isLoading ? (
          <LoadingBlock label="Loading watch state" className="h-32" />
        ) : state.isError ? (
          <ErrorPanel message={errorMessage(state.error)} />
        ) : items.length === 0 ? (
          <p className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">Nothing watched yet.</p>
        ) : (
          <ul className="max-h-[50vh] divide-y overflow-y-auto rounded-lg border" aria-label="Watch state">
            {items.map((item) => <WatchStateRow key={item.workId} item={item} />)}
          </ul>
        )}
        {confirming ? (
          <div className="space-y-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3" role="alert">
            <p className="text-sm">Remove every resume point, played flag and play count of @{viewer?.username}? This cannot be undone.</p>
            <div className="flex flex-wrap justify-end gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => setConfirming(false)} disabled={clear.isPending}>Cancel</Button>
              <Button type="button" variant="destructive" size="sm" onClick={clearAll} disabled={clear.isPending}>
                {clear.isPending ? <Loader2 className="animate-spin" /> : <Trash2 />}
                Clear watch state
              </Button>
            </div>
          </div>
        ) : (
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setConfirming(true)} disabled={items.length === 0}>
              <Trash2 />Clear watch state
            </Button>
            <Button type="button" onClick={onClose}>Close</Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function WatchStateRow({ item, action }: { item: WatchStateResponse; action?: ReactNode }) {
  const percent = item.progressPercent ?? 0;
  const episode = episodeLabel(item.seasonNumber, item.episodeNumber);
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 p-3">
      <div className="min-w-0 flex-1 basis-56 space-y-1.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <p className={cn("min-w-0 truncate text-sm font-medium", !item.title && "font-mono text-xs")}>{item.title || item.workId}</p>
          {episode && <span className="font-mono text-[11px] text-muted-foreground">{episode}</span>}
          {item.played && <ToneBadge tone="success"><Check className="mr-1 size-3" />Played</ToneBadge>}
          {(item.playCount ?? 0) > 1 && <ToneBadge tone="muted">{item.playCount}× played</ToneBadge>}
        </div>
        {item.title && <p className="truncate font-mono text-[11px] text-muted-foreground">{item.workId}</p>}
        {(item.positionTicks ?? 0) > 0 && (
          <div className="flex items-center gap-2">
            <ProgressBar value={percent / 100} label={`Progress of ${item.title || item.workId}`} className="flex-1" barClassName="bg-cyan-500" />
            <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
              {formatTicks(item.positionTicks)} · {percent.toFixed(0)}%
            </span>
          </div>
        )}
      </div>
      <div className={cn("flex items-center gap-2 text-xs text-muted-foreground", action && "w-full justify-between sm:w-auto")}>
        <span title={formatDateTime(item.lastPlayedAt)}>{item.lastPlayedAt ? timeAgo(item.lastPlayedAt) : "—"}</span>
        {action}
      </div>
    </li>
  );
}
