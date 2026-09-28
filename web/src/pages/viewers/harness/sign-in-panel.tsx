import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Loader2, LogIn, Mail, MailQuestion, ShieldCheck, X } from "lucide-react";
import { toast } from "sonner";
import { useViewers } from "@/api/queries";
import type { ViewerAuthResponse } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn, futureTime } from "@/lib/utils";
import { Hint, InlineError, Panel, TextField } from "../shared";
import { harnessClientName, harnessKeys, useAuthOptions, useHarness } from "./use-harness";

type Method = "password" | "email" | "forgot";

export function SignInPanel() {
  const qc = useQueryClient();
  const options = useAuthOptions();
  const viewers = useViewers();
  const [deviceName, setDeviceName] = useState("Test harness");
  const [login, setLogin] = useState("");
  const [method, setMethod] = useState<Method>("password");
  const [mfa, setMfa] = useState<{ token: string; expiresAt?: string | null } | null>(null);

  const device = { deviceName: deviceName.trim() || "Test harness", clientName: harnessClientName };
  const available = options.data;
  const passwordUnavailable = available && !available.passwordLogin ? "Password sign-in is turned off on this server." : null;
  const emailUnavailable = available && !available.emailCodeLogin ? "Needs email delivery and “Sign-in with email codes” in Settings." : null;
  const resetUnavailable = available && !available.passwordReset ? "Needs email delivery and “Password reset by email” in Settings." : null;
  const quickPick = (viewers.data ?? []).slice(0, 12);

  function handleAuth(response: ViewerAuthResponse) {
    if (response.status === "mfa_required" && response.mfaToken) {
      setMfa({ token: response.mfaToken, expiresAt: response.mfaExpiresAt });
      return;
    }
    const sid = response.session?.sessionId;
    if (sid && response.viewer) qc.setQueryData(harnessKeys.me(sid), response.viewer);
    toast.success(`Signed in as @${response.viewer?.username ?? login}.`);
  }

  return (
    <Panel
      icon={<LogIn />}
      title="Sign in as a viewer"
      description={
        available
          ? `${available.serverName ?? "Streamarr"} · passwords need ≥ ${available.passwordMinLength} characters${available.twoFactor ? " · 2FA available" : ""}`
          : "Uses the viewer sign-in API, exactly like a viewer app would."
      }
    >
      {options.isError && <InlineError error={options.error} />}

      <div className="grid gap-4 sm:grid-cols-2">
        <TextField id="harness-device" label="Device name" value={deviceName} onChange={(event) => setDeviceName(event.target.value)} hint="Shown in the viewer’s device list." />
        <TextField id="harness-login" label="Username or email" autoComplete="off" spellCheck={false} value={login} onChange={(event) => setLogin(event.target.value)} hint="Email works once it is verified." />
      </div>

      {quickPick.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground" id="harness-quick-pick">Existing viewers</p>
          <div className="flex flex-wrap gap-1.5" role="group" aria-labelledby="harness-quick-pick">
            {quickPick.map((viewer) => (
              <button
                key={viewer.id}
                type="button"
                onClick={() => setLogin(viewer.username ?? "")}
                aria-pressed={login === viewer.username}
                className={cn(
                  "rounded-full border px-2.5 py-1 font-mono text-xs transition-colors hover:bg-accent",
                  login === viewer.username && "border-cyan-500/60 bg-cyan-500/10 text-cyan-900 dark:text-cyan-100",
                  viewer.disabled && "line-through opacity-60",
                )}
                title={viewer.disabled ? "Disabled — sign-in will be refused" : viewer.displayName ?? undefined}
              >
                @{viewer.username}
              </button>
            ))}
          </div>
        </div>
      )}

      {mfa ? (
        <SecondFactorForm mfa={mfa} device={device} onDone={handleAuth} onCancel={() => setMfa(null)} />
      ) : (
        <Tabs value={method} onValueChange={(value) => setMethod(value as Method)}>
          <TabsList className="h-auto w-full flex-wrap justify-start sm:w-auto">
            <TabsTrigger value="password" disabled={!!passwordUnavailable}><KeyRound className="mr-1.5 size-3.5" />Password</TabsTrigger>
            <TabsTrigger value="email" disabled={!!emailUnavailable}><Mail className="mr-1.5 size-3.5" />Email code</TabsTrigger>
            <TabsTrigger value="forgot" disabled={!!resetUnavailable}><MailQuestion className="mr-1.5 size-3.5" />Forgot password</TabsTrigger>
          </TabsList>
          {(passwordUnavailable || emailUnavailable || resetUnavailable) && (
            <ul className="mt-2 space-y-0.5 text-xs text-muted-foreground">
              {passwordUnavailable && <li>{passwordUnavailable}</li>}
              {emailUnavailable && <li>Email code unavailable: {emailUnavailable}</li>}
              {resetUnavailable && <li>Forgot password unavailable: {resetUnavailable}</li>}
            </ul>
          )}
          <TabsContent value="password">
            <PasswordForm login={login} device={device} onDone={handleAuth} />
          </TabsContent>
          <TabsContent value="email">
            <EmailCodeForm login={login} device={device} onDone={handleAuth} />
          </TabsContent>
          <TabsContent value="forgot">
            <ForgotPasswordForm login={login} minLength={available?.passwordMinLength ?? 8} onReset={() => setMethod("password")} />
          </TabsContent>
        </Tabs>
      )}
    </Panel>
  );
}

interface Device {
  deviceName: string;
  clientName: string;
}

function PasswordForm({ login, device, onDone }: { login: string; device: Device; onDone: (response: ViewerAuthResponse) => void }) {
  const { client } = useHarness();
  const [password, setPassword] = useState("");
  const mutation = useMutation({
    mutationFn: () => client.login({ login: login.trim(), password, ...device }),
    onSuccess: onDone,
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    mutation.mutate();
  }

  return (
    <form onSubmit={submit} className="space-y-3" aria-label="Password sign-in">
      <TextField id="harness-password" label="Password" type="password" autoComplete="off" value={password} onChange={(event) => setPassword(event.target.value)} />
      <InlineError error={mutation.error} />
      <Button type="submit" disabled={!login.trim() || !password || mutation.isPending}>
        {mutation.isPending ? <Loader2 className="animate-spin" /> : <LogIn />}
        Sign in
      </Button>
    </form>
  );
}

function SecondFactorForm({
  mfa,
  device,
  onDone,
  onCancel,
}: {
  mfa: { token: string; expiresAt?: string | null };
  device: Device;
  onDone: (response: ViewerAuthResponse) => void;
  onCancel: () => void;
}) {
  const { client } = useHarness();
  const [code, setCode] = useState("");
  const mutation = useMutation({
    mutationFn: () => client.secondFactor({ mfaToken: mfa.token, code: code.trim(), ...device }),
    onSuccess: onDone,
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    mutation.mutate();
  }

  return (
    <form onSubmit={submit} className="space-y-3 rounded-lg border border-cyan-500/30 bg-cyan-500/5 p-3" aria-label="Second factor">
      <p className="flex items-center gap-2 text-sm font-medium">
        <ShieldCheck className="size-4 text-cyan-600 dark:text-cyan-400" aria-hidden />
        Two-factor authentication required
      </p>
      <p className="text-xs leading-5 text-muted-foreground">
        The password was correct (<code className="font-mono">mfa_required</code>). Enter the 6-digit code from the authenticator app or one
        recovery code such as <code className="font-mono">abcde-fghij</code>
        {mfa.expiresAt ? ` — this attempt expires ${futureTime(mfa.expiresAt)}` : ""}.
      </p>
      <TextField
        id="harness-mfa-code"
        label="Authenticator or recovery code"
        autoComplete="one-time-code"
        spellCheck={false}
        value={code}
        onChange={(event) => setCode(event.target.value)}
        className="sm:max-w-xs"
      />
      <InlineError error={mutation.error} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={!code.trim() || mutation.isPending}>
          {mutation.isPending ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
          Verify
        </Button>
        <Button type="button" variant="outline" onClick={onCancel}><X />Cancel</Button>
      </div>
    </form>
  );
}

function EmailCodeForm({ login, device, onDone }: { login: string; device: Device; onDone: (response: ViewerAuthResponse) => void }) {
  const { client } = useHarness();
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState("");
  const request = useMutation({ mutationFn: () => client.requestEmailCode(login.trim()), onSuccess: () => setSent(true) });
  const verify = useMutation({
    mutationFn: () => client.verifyEmailCode({ login: login.trim(), code: code.trim(), ...device }),
    onSuccess: onDone,
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (sent) verify.mutate();
    else request.mutate();
  }

  return (
    <form onSubmit={submit} className="space-y-3" aria-label="Email code sign-in">
      {!sent ? (
        <p className="text-xs leading-5 text-muted-foreground">Sends a one-time code to the viewer’s verified email address.</p>
      ) : (
        <>
          <Hint tone="info">
            Accepted (202). If the account exists and has a verified address, a code is on its way — the server never reveals which. With the
            test outbox it shows up in the Test outbox panel.
          </Hint>
          <TextField id="harness-email-code" label="Code" placeholder="ABCD-EFGH" autoComplete="one-time-code" spellCheck={false} value={code} onChange={(event) => setCode(event.target.value)} className="sm:max-w-xs" />
        </>
      )}
      <InlineError error={sent ? verify.error : request.error} />
      <div className="flex flex-wrap gap-2">
        {!sent ? (
          <Button type="submit" disabled={!login.trim() || request.isPending}>
            {request.isPending ? <Loader2 className="animate-spin" /> : <Mail />}
            Send code
          </Button>
        ) : (
          <>
            <Button type="submit" disabled={!code.trim() || verify.isPending}>
              {verify.isPending ? <Loader2 className="animate-spin" /> : <LogIn />}
              Sign in with code
            </Button>
            <Button type="button" variant="outline" onClick={() => request.mutate()} disabled={request.isPending}>Send a new code</Button>
          </>
        )}
      </div>
    </form>
  );
}

function ForgotPasswordForm({ login, minLength, onReset }: { login: string; minLength: number; onReset: () => void }) {
  const { client } = useHarness();
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const request = useMutation({ mutationFn: () => client.forgotPassword(login.trim()), onSuccess: () => setSent(true) });
  const reset = useMutation({
    mutationFn: () => client.resetPassword({ login: login.trim(), code: code.trim(), newPassword: password }),
    onSuccess: () => {
      toast.success("Password reset — every device was signed out. Sign in with the new password.");
      setSent(false);
      setCode("");
      setPassword("");
      onReset();
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (sent) reset.mutate();
    else request.mutate();
  }

  return (
    <form onSubmit={submit} className="space-y-3" aria-label="Password reset">
      {!sent ? (
        <p className="text-xs leading-5 text-muted-foreground">Emails a reset code to the viewer’s verified address.</p>
      ) : (
        <>
          <Hint tone="info">Accepted (202). Enter the emailed reset code and a new password.</Hint>
          <div className="grid gap-3 sm:grid-cols-2">
            <TextField id="harness-reset-code" label="Reset code" placeholder="ABCD-EFGH" autoComplete="one-time-code" spellCheck={false} value={code} onChange={(event) => setCode(event.target.value)} />
            <TextField id="harness-reset-password" label="New password" type="password" autoComplete="off" hint={`At least ${minLength} characters.`} value={password} onChange={(event) => setPassword(event.target.value)} />
          </div>
        </>
      )}
      <InlineError error={sent ? reset.error : request.error} />
      <div className="flex flex-wrap gap-2">
        {!sent ? (
          <Button type="submit" disabled={!login.trim() || request.isPending}>
            {request.isPending ? <Loader2 className="animate-spin" /> : <MailQuestion />}
            Send reset code
          </Button>
        ) : (
          <>
            <Button type="submit" disabled={!code.trim() || !password || reset.isPending}>
              {reset.isPending ? <Loader2 className="animate-spin" /> : <KeyRound />}
              Reset password
            </Button>
            <Button type="button" variant="outline" onClick={() => setSent(false)}>Start over</Button>
          </>
        )}
      </div>
    </form>
  );
}
