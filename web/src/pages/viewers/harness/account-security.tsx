import { lazy, Suspense, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, KeyRound, Loader2, LogOut, Mail, MonitorSmartphone, RefreshCw, Save, ShieldCheck, ShieldOff, UserCog } from "lucide-react";
import { toast } from "sonner";
import type { ViewerProfileResponse, ViewerTotpSetupResponse } from "@/api/types";
import { CopyButton } from "@/components/code-disclosure";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatDateTime } from "@/lib/viewers";
import { timeAgo } from "@/lib/utils";
import { Hint, InlineError, LoadingBlock, Panel, TextField, ToneBadge } from "../shared";
import { harnessKeys, useAuthOptions, useHarness, useSessionId, useViewerProfile } from "./use-harness";

// Only needed while enrolling an authenticator, so it stays out of the page chunk.
const QRCodeSVG = lazy(() => import("qrcode.react").then((module) => ({ default: module.QRCodeSVG })));

export function AccountSecurity() {
  const profile = useViewerProfile();
  const [tab, setTab] = useState("profile");
  if (!profile.data) return null;
  return (
    <Panel icon={<UserCog />} title="Account & security" description="The viewer’s own settings, as a viewer app would offer them.">
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="h-auto w-full flex-wrap justify-start sm:w-auto">
          <TabsTrigger value="profile">Profile</TabsTrigger>
          <TabsTrigger value="password">Password</TabsTrigger>
          <TabsTrigger value="email">Email</TabsTrigger>
          <TabsTrigger value="2fa">Two-factor</TabsTrigger>
          <TabsTrigger value="devices">Devices</TabsTrigger>
        </TabsList>
        <TabsContent value="profile"><ProfileForm profile={profile.data} /></TabsContent>
        <TabsContent value="password"><PasswordForm /></TabsContent>
        <TabsContent value="email"><EmailForm profile={profile.data} /></TabsContent>
        <TabsContent value="2fa"><TwoFactor profile={profile.data} /></TabsContent>
        <TabsContent value="devices"><Devices /></TabsContent>
      </Tabs>
    </Panel>
  );
}

function useSetProfile() {
  const qc = useQueryClient();
  const sid = useSessionId();
  return (profile: ViewerProfileResponse) => qc.setQueryData(harnessKeys.me(sid), profile);
}

function useRefetchProfile() {
  const qc = useQueryClient();
  const sid = useSessionId();
  return () => void qc.invalidateQueries({ queryKey: harnessKeys.me(sid) });
}

function ProfileForm({ profile }: { profile: ViewerProfileResponse }) {
  const { client } = useHarness();
  const setProfile = useSetProfile();
  const [name, setName] = useState(profile.displayName ?? "");
  const save = useMutation({
    mutationFn: () => client.updateMe({ displayName: name.trim() }),
    onSuccess: (updated) => {
      setProfile(updated);
      toast.success("Display name saved.");
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    save.mutate();
  }

  return (
    <form onSubmit={submit} className="space-y-3" aria-label="Profile">
      <TextField id="me-display-name" label="Display name" value={name} onChange={(event) => setName(event.target.value)} hint="Empty falls back to the username." className="sm:max-w-sm" />
      <InlineError error={save.error} />
      <Button type="submit" size="sm" disabled={save.isPending || name.trim() === (profile.displayName ?? "")}>
        {save.isPending ? <Loader2 className="animate-spin" /> : <Save />}
        Save display name
      </Button>
    </form>
  );
}

function PasswordForm() {
  const { client } = useHarness();
  const qc = useQueryClient();
  const sid = useSessionId();
  const options = useAuthOptions();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const change = useMutation({
    mutationFn: () => client.changePassword({ currentPassword: current, newPassword: next }),
    onSuccess: () => {
      toast.success("Password changed — every other device was signed out.");
      setCurrent("");
      setNext("");
      void qc.invalidateQueries({ queryKey: harnessKeys.devices(sid) });
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    change.mutate();
  }

  return (
    <form onSubmit={submit} className="space-y-3" aria-label="Change password">
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField id="me-current-password" label="Current password" type="password" autoComplete="off" value={current} onChange={(event) => setCurrent(event.target.value)} />
        <TextField id="me-new-password" label="New password" type="password" autoComplete="off" hint={`At least ${options.data?.passwordMinLength ?? 8} characters.`} value={next} onChange={(event) => setNext(event.target.value)} />
      </div>
      <InlineError error={change.error} />
      <Button type="submit" size="sm" disabled={!current || !next || change.isPending}>
        {change.isPending ? <Loader2 className="animate-spin" /> : <KeyRound />}
        Change password
      </Button>
    </form>
  );
}

function EmailForm({ profile }: { profile: ViewerProfileResponse }) {
  const { client } = useHarness();
  const setProfile = useSetProfile();
  const refetch = useRefetchProfile();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const change = useMutation({
    mutationFn: () => client.changeEmail({ email: email.trim(), currentPassword: password }),
    onSuccess: (result) => {
      setPassword("");
      refetch();
      toast.success(result.verificationSent ? `Verification code sent to ${result.pendingEmail}.` : "Email address removed.");
    },
  });
  const verify = useMutation({
    mutationFn: () => client.verifyEmail(code.trim()),
    onSuccess: (updated) => {
      setProfile(updated);
      setCode("");
      toast.success("Email address verified.");
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    change.mutate();
  }

  return (
    <div className="space-y-4">
      <p className="text-sm">
        {profile.email ? (
          <>
            <span className="font-medium">{profile.email}</span>{" "}
            {profile.emailVerified ? <ToneBadge tone="success">verified</ToneBadge> : <ToneBadge tone="warning">not verified</ToneBadge>}
          </>
        ) : (
          <span className="text-muted-foreground">No email address on this account.</span>
        )}
      </p>

      {profile.pendingEmail && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            verify.mutate();
          }}
          className="space-y-3 rounded-lg border border-cyan-500/30 bg-cyan-500/5 p-3"
          aria-label="Verify email"
        >
          <p className="text-xs leading-5">
            Waiting for confirmation of <span className="font-medium">{profile.pendingEmail}</span>. Enter the emailed code (visible in the Test outbox when that mode is on).
          </p>
          <TextField id="me-email-code" label="Verification code" placeholder="ABCD-EFGH" autoComplete="one-time-code" spellCheck={false} value={code} onChange={(event) => setCode(event.target.value)} className="sm:max-w-xs" />
          <InlineError error={verify.error} />
          <Button type="submit" size="sm" disabled={!code.trim() || verify.isPending}>
            {verify.isPending ? <Loader2 className="animate-spin" /> : <Check />}
            Verify address
          </Button>
        </form>
      )}

      <form onSubmit={submit} className="space-y-3" aria-label="Change email">
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField id="me-email" label="New email address" type="email" autoComplete="off" value={email} onChange={(event) => setEmail(event.target.value)} hint="Leave empty to remove the address." />
          <TextField id="me-email-password" label="Current password" type="password" autoComplete="off" value={password} onChange={(event) => setPassword(event.target.value)} />
        </div>
        <InlineError error={change.error} />
        <Button type="submit" size="sm" disabled={!password || change.isPending || (!email.trim() && !profile.email)}>
          {change.isPending ? <Loader2 className="animate-spin" /> : <Mail />}
          {email.trim() ? "Send verification code" : "Remove email"}
        </Button>
      </form>
    </div>
  );
}

function TwoFactor({ profile }: { profile: ViewerProfileResponse }) {
  const { client } = useHarness();
  const options = useAuthOptions();
  const refetch = useRefetchProfile();
  const [password, setPassword] = useState("");
  const [setup, setSetup] = useState<ViewerTotpSetupResponse | null>(null);
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);

  const begin = useMutation({
    mutationFn: () => client.setupTwoFactor(password),
    onSuccess: (result) => {
      setSetup(result);
      setPassword("");
    },
  });
  const enable = useMutation({
    mutationFn: () => client.enableTwoFactor(code.trim()),
    onSuccess: (result) => {
      setCodes(result.recoveryCodes ?? []);
      setSetup(null);
      setCode("");
      refetch();
    },
  });
  const disable = useMutation({
    mutationFn: () => client.disableTwoFactor(password),
    onSuccess: () => {
      setPassword("");
      refetch();
      toast.success("Two-factor authentication disabled.");
    },
  });
  const regenerate = useMutation({
    mutationFn: () => client.regenerateRecoveryCodes(password),
    onSuccess: (result) => {
      setCodes(result.recoveryCodes ?? []);
      setPassword("");
      refetch();
    },
  });

  if (codes) {
    return (
      <div className="space-y-3" aria-label="Recovery codes">
        <Hint tone="warning">Recovery codes are shown only once. Each works a single time instead of an authenticator code.</Hint>
        <ul className="grid grid-cols-2 gap-1.5 rounded-lg border bg-muted/30 p-3 font-mono text-sm sm:grid-cols-3">
          {codes.map((recovery) => <li key={recovery}>{recovery}</li>)}
        </ul>
        <div className="flex flex-wrap gap-2">
          <CopyButton text={codes.join("\n")} label="Copy recovery codes" className="h-8 px-3" />
          <Button type="button" size="sm" onClick={() => setCodes(null)}><Check />I saved them</Button>
        </div>
      </div>
    );
  }

  if (setup) {
    return (
      <form
        onSubmit={(event) => {
          event.preventDefault();
          enable.mutate();
        }}
        className="space-y-3"
        aria-label="Confirm authenticator"
      >
        <p className="text-xs leading-5 text-muted-foreground">
          Scan the code with an authenticator app (or type the secret), then confirm with the 6-digit code it shows.
        </p>
        <div className="flex flex-wrap items-start gap-4">
          <div className="rounded-lg bg-white p-3 shadow-sm ring-1 ring-black/10">
            <Suspense fallback={<div className="size-[168px] animate-pulse rounded bg-zinc-200" role="status" aria-label="Loading QR code" />}>
              <QRCodeSVG value={setup.otpAuthUri ?? ""} size={168} bgColor="#ffffff" fgColor="#000000" marginSize={0} role="img" aria-label="Authenticator QR code" />
            </Suspense>
          </div>
          <dl className="min-w-0 flex-1 basis-48 space-y-2 text-xs">
            <div>
              <dt className="text-muted-foreground">Secret</dt>
              <dd className="flex flex-wrap items-center gap-2">
                <code className="break-all font-mono text-sm">{setup.secret?.replace(/(.{4})/g, "$1 ").trim()}</code>
                <CopyButton text={setup.secret ?? ""} label="Copy secret" />
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Issuer · account</dt>
              <dd>{setup.issuer} · {setup.accountName}</dd>
            </div>
          </dl>
        </div>
        <TextField id="totp-confirm" label="Code from the app" inputMode="numeric" autoComplete="one-time-code" placeholder="123456" value={code} onChange={(event) => setCode(event.target.value)} className="sm:max-w-[12rem]" />
        <InlineError error={enable.error} />
        <div className="flex flex-wrap gap-2">
          <Button type="submit" size="sm" disabled={!code.trim() || enable.isPending}>
            {enable.isPending ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
            Enable two-factor
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => setSetup(null)}>Cancel</Button>
        </div>
      </form>
    );
  }

  const passwordField = (
    <TextField id="totp-password" label="Current password" type="password" autoComplete="off" value={password} onChange={(event) => setPassword(event.target.value)} className="sm:max-w-sm" />
  );

  if (!profile.twoFactorEnabled) {
    return (
      <form
        onSubmit={(event) => {
          event.preventDefault();
          begin.mutate();
        }}
        className="space-y-3"
        aria-label="Set up two-factor"
      >
        {options.data && !options.data.twoFactor && <Hint tone="warning">Authenticator apps are switched off in Settings; the server will refuse the setup.</Hint>}
        <p className="text-xs leading-5 text-muted-foreground">Protect the account with an authenticator app. Sign-in then asks for a 6-digit code after the password.</p>
        {passwordField}
        <InlineError error={begin.error} />
        <Button type="submit" size="sm" disabled={!password || begin.isPending}>
          {begin.isPending ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
          Set up authenticator
        </Button>
      </form>
    );
  }

  return (
    <div className="space-y-3">
      <p className="flex flex-wrap items-center gap-2 text-sm">
        <ToneBadge tone="success"><ShieldCheck className="mr-1 size-3" />Enabled</ToneBadge>
        <span className="text-muted-foreground">{profile.recoveryCodesRemaining ?? 0} recovery codes left</span>
      </p>
      {passwordField}
      <InlineError error={disable.error ?? regenerate.error} />
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="outline" onClick={() => regenerate.mutate()} disabled={!password || regenerate.isPending}>
          {regenerate.isPending ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          New recovery codes
        </Button>
        <Button type="button" size="sm" variant="outline" className="text-destructive hover:text-destructive" onClick={() => disable.mutate()} disabled={!password || disable.isPending}>
          {disable.isPending ? <Loader2 className="animate-spin" /> : <ShieldOff />}
          Disable two-factor
        </Button>
      </div>
    </div>
  );
}

function Devices() {
  const { client } = useHarness();
  const sid = useSessionId();
  const qc = useQueryClient();
  const devices = useQuery({ queryKey: harnessKeys.devices(sid), queryFn: () => client.sessions(), retry: false });
  const revoke = useMutation({
    mutationFn: async ({ id, current }: { id: string; current: boolean }) => {
      await client.revokeSession(id);
      return current;
    },
    onSuccess: (current) => {
      if (current) {
        toast.success("This device was signed out.");
        client.forget();
      } else {
        void qc.invalidateQueries({ queryKey: harnessKeys.devices(sid) });
      }
    },
    onError: (error) => toast.error(error.message),
  });
  const list = devices.data ?? [];

  if (devices.isLoading) return <LoadingBlock label="Loading devices" className="h-24" />;
  if (devices.error) return <InlineError error={devices.error} />;
  return (
    <ul className="divide-y rounded-lg border" aria-label="Signed-in devices">
      {list.map((device) => (
        <li key={device.id} className="flex flex-wrap items-center gap-3 p-3">
          <MonitorSmartphone className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <div className="min-w-0 flex-1 basis-48">
            <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
              <span className="truncate">{device.deviceName || "Unnamed device"}</span>
              {device.current && <ToneBadge tone="info">This device</ToneBadge>}
            </p>
            <p className="truncate text-xs text-muted-foreground">
              {[device.clientName, device.authMethod, device.ipAddress].filter(Boolean).join(" · ")}
            </p>
            <p className="truncate text-[11px] text-muted-foreground" title={`Signed in ${formatDateTime(device.createdAt)}`}>
              seen {timeAgo(device.lastSeenAt)} · stays signed in until {formatDateTime(device.refreshExpiresAt)}
            </p>
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => revoke.mutate({ id: device.id ?? "", current: !!device.current })}
            disabled={revoke.isPending}
            aria-label={`Sign out ${device.deviceName || "device"}`}
          >
            <LogOut />Sign out
          </Button>
        </li>
      ))}
    </ul>
  );
}
