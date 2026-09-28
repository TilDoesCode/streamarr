import { useEffect, useState, type ReactNode } from "react";
import { Controller, useForm, type Control, type FieldPath } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { History, Loader2, Mail, Power, RotateCcw, Save, Send, ShieldCheck, UserCog } from "lucide-react";
import { toast } from "sonner";
import { errorMessage } from "@/api/client";
import { useSendViewerTestEmail, useUpdateViewerSettings, useViewerSettings } from "@/api/queries";
import type { ViewerSettingsResponse, ViewerSettingsWrite } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ErrorPanel, Hint, LoadingBlock, Panel, SwitchField, TextField, selectClassName } from "./shared";

const whole = (min: number, max: number) =>
  z.coerce
    .number({ invalid_type_error: "Enter a number" })
    .int("Must be a whole number")
    .min(min, `Must be at least ${min.toLocaleString("en-US")}`)
    .max(max, `Must not exceed ${max.toLocaleString("en-US")}`);

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Mirrors ViewerSettings.Validate() on the server.
export const viewerSettingsSchema = z
  .object({
    enabled: z.boolean(),
    serverName: z.string().trim().min(1, "Enter a name").max(64, "At most 64 characters"),
    accessTokenMinutes: whole(5, 1_440),
    refreshTokenDays: whole(1, 365),
    maxSessionsPerViewer: whole(1, 100),
    passwordMinLength: whole(6, 128),
    lockoutThreshold: whole(3, 100),
    lockoutMinutes: whole(1, 1_440),
    allowPasswordReset: z.boolean(),
    allowEmailLogin: z.boolean(),
    allowTotp: z.boolean(),
    minResumePercent: whole(0, 50),
    playedPercent: whole(50, 100),
    minResumeDurationSeconds: whole(0, 3_600),
    nextUpCutoffDays: whole(1, 3_650),
    emailMode: z.enum(["disabled", "smtp", "outbox"]),
    smtpHost: z.string().trim().max(255).refine((value) => !/\s/.test(value), "No spaces allowed"),
    smtpPort: whole(1, 65_535),
    smtpSecurity: z.enum(["auto", "none", "startTls", "sslOnConnect"]),
    smtpUsername: z.string().trim().max(256),
    smtpPassword: z.string().max(1_024),
    clearSmtpPassword: z.boolean(),
    fromAddress: z.string().trim().refine((value) => value === "" || EMAIL.test(value), "Enter a valid email address"),
    fromName: z.string().trim().max(128, "At most 128 characters"),
  })
  .superRefine((values, ctx) => {
    if (values.emailMode !== "smtp") return;
    if (!values.smtpHost) ctx.addIssue({ code: "custom", path: ["smtpHost"], message: "SMTP delivery needs a host" });
    if (!values.fromAddress) ctx.addIssue({ code: "custom", path: ["fromAddress"], message: "SMTP delivery needs a sender address" });
  });

type Values = z.input<typeof viewerSettingsSchema>;
type Output = z.output<typeof viewerSettingsSchema>;

const EMAIL_MODES = new Set(["disabled", "smtp", "outbox"]);
const SECURITY_MODES = new Set(["auto", "none", "startTls", "sslOnConnect"]);

function toValues(settings: ViewerSettingsResponse): Values {
  const email = settings.email ?? {};
  return {
    enabled: settings.enabled,
    serverName: settings.serverName ?? "Streamarr",
    accessTokenMinutes: settings.accessTokenMinutes,
    refreshTokenDays: settings.refreshTokenDays,
    maxSessionsPerViewer: settings.maxSessionsPerViewer,
    passwordMinLength: settings.passwordMinLength,
    lockoutThreshold: settings.lockoutThreshold,
    lockoutMinutes: settings.lockoutMinutes,
    allowPasswordReset: settings.allowPasswordReset,
    allowEmailLogin: settings.allowEmailLogin,
    allowTotp: settings.allowTotp,
    minResumePercent: settings.minResumePercent,
    playedPercent: settings.playedPercent,
    minResumeDurationSeconds: settings.minResumeDurationSeconds,
    nextUpCutoffDays: settings.nextUpCutoffDays,
    emailMode: (EMAIL_MODES.has(email.mode ?? "") ? email.mode : "disabled") as Output["emailMode"],
    smtpHost: email.smtpHost ?? "",
    smtpPort: email.smtpPort ?? 587,
    smtpSecurity: (SECURITY_MODES.has(email.smtpSecurity ?? "") ? email.smtpSecurity : "auto") as Output["smtpSecurity"],
    smtpUsername: email.smtpUsername ?? "",
    smtpPassword: "",
    clearSmtpPassword: false,
    fromAddress: email.fromAddress ?? "",
    fromName: email.fromName ?? "",
  };
}

/** The SMTP password is write-only: an empty field keeps the stored one unless "clear" is ticked. */
export function toWrite(values: Output): ViewerSettingsWrite {
  const { emailMode, smtpHost, smtpPort, smtpSecurity, smtpUsername, smtpPassword, clearSmtpPassword, fromAddress, fromName, ...rest } = values;
  const password = smtpPassword !== "" ? smtpPassword : clearSmtpPassword ? "" : undefined;
  return {
    ...rest,
    email: {
      mode: emailMode,
      smtpHost,
      smtpPort,
      smtpSecurity,
      smtpUsername,
      fromAddress,
      fromName,
      ...(password !== undefined ? { smtpPassword: password } : {}),
    },
  };
}

export function SettingsTab() {
  const query = useViewerSettings();
  if (query.isLoading) return <LoadingBlock label="Loading viewer settings" className="h-96" />;
  if (query.isError || !query.data) return <ErrorPanel message={errorMessage(query.error)} />;
  return <SettingsForm settings={query.data} />;
}

function SettingsForm({ settings }: { settings: ViewerSettingsResponse }) {
  const update = useUpdateViewerSettings();
  const form = useForm<Values>({
    resolver: zodResolver(viewerSettingsSchema),
    defaultValues: toValues(settings),
  });

  useEffect(() => {
    form.reset(toValues(settings), { keepDirtyValues: true });
  }, [form, settings]);

  async function save(raw: Values) {
    try {
      const saved = await update.mutateAsync(toWrite(viewerSettingsSchema.parse(raw)));
      form.reset(toValues(saved));
      toast.success("Viewer settings saved.");
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  const errors = form.formState.errors;
  const enabled = form.watch("enabled");
  const emailMode = form.watch("emailMode");
  const clearPassword = form.watch("clearSmtpPassword");
  const hasStoredPassword = !!settings.email?.smtpPassword;
  const needsEmail = emailMode === "disabled";
  const num = (name: FieldPath<Values>) => form.register(name);

  return (
    <form onSubmit={form.handleSubmit(save)} className="space-y-4" noValidate aria-label="Viewer settings">
      <div className="grid gap-4 xl:grid-cols-2">
        <Panel icon={<Power />} title="Module" description="Whether viewer accounts exist on this server at all.">
          <FormSwitch
            control={form.control}
            name="enabled"
            label="Enable viewer accounts"
            description="When off, every /api/v1/viewer endpoint answers 404 module_disabled. Accounts and watch state are kept."
          />
          <TextField
            id="serverName"
            label="Server name"
            hint="Shown to viewers on sign-in screens, in emails and as the authenticator-app issuer."
            error={errors.serverName?.message}
            {...form.register("serverName")}
          />
          <p className="text-xs text-muted-foreground">
            {settings.viewerCount} viewer account{settings.viewerCount === 1 ? "" : "s"}
            {!enabled && " · module disabled — the values below stay saved"}
          </p>
        </Panel>

        <Panel icon={<ShieldCheck />} title="Sessions & security" description="Token lifetimes, device limits and brute-force protection.">
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField id="accessTokenMinutes" label="Access token lifetime" unit="min" type="number" inputMode="numeric" min={5} max={1_440} hint="5–1440; apps refresh silently." error={errors.accessTokenMinutes?.message} {...num("accessTokenMinutes")} />
            <TextField id="refreshTokenDays" label="Stay signed in for" unit="days" type="number" inputMode="numeric" min={1} max={365} hint="1–365 since last use." error={errors.refreshTokenDays?.message} {...num("refreshTokenDays")} />
            <TextField id="maxSessionsPerViewer" label="Devices per viewer" unit="devices" type="number" inputMode="numeric" min={1} max={100} hint="1–100; the oldest is signed out." error={errors.maxSessionsPerViewer?.message} {...num("maxSessionsPerViewer")} />
            <TextField id="passwordMinLength" label="Minimum password length" unit="chars" type="number" inputMode="numeric" min={6} max={128} hint="6–128." error={errors.passwordMinLength?.message} {...num("passwordMinLength")} />
            <TextField id="lockoutThreshold" label="Lock after" unit="failures" type="number" inputMode="numeric" min={3} max={100} hint="3–100 failed sign-ins in a row." error={errors.lockoutThreshold?.message} {...num("lockoutThreshold")} />
            <TextField id="lockoutMinutes" label="Lockout duration" unit="min" type="number" inputMode="numeric" min={1} max={1_440} hint="1–1440; admins can unlock early." error={errors.lockoutMinutes?.message} {...num("lockoutMinutes")} />
          </div>
        </Panel>

        <Panel icon={<UserCog />} title="Self-service" description="What viewers may do without asking you.">
          <FormSwitch control={form.control} name="allowPasswordReset" label="Password reset by email" description="“Forgot password” sends a one-time reset code." />
          <FormSwitch control={form.control} name="allowEmailLogin" label="Sign-in with email codes" description="Password-less sign-in with a code sent to the verified address." />
          <FormSwitch control={form.control} name="allowTotp" label="Authenticator apps (2FA)" description="Viewers may protect their account with TOTP codes and recovery codes." />
          {needsEmail ? (
            <Hint tone="warning">Password reset and email codes need email delivery — choose SMTP or Test outbox below. Authenticator apps work without it.</Hint>
          ) : !settings.emailDeliveryReady ? (
            <Hint tone="warning">Email delivery is not ready yet, so reset and sign-in codes are unavailable until it is saved and configured.</Hint>
          ) : null}
        </Panel>

        <Panel icon={<History />} title="Watch state" description="When a title counts as started, finished, or next up (Jellyfin-compatible defaults).">
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField id="minResumePercent" label="Resume point from" unit="%" type="number" inputMode="numeric" min={0} max={50} hint="0–50; earlier stops keep no position." error={errors.minResumePercent?.message} {...num("minResumePercent")} />
            <TextField id="playedPercent" label="Played at" unit="%" type="number" inputMode="numeric" min={50} max={100} hint="50–100; counts a play and resets the position." error={errors.playedPercent?.message} {...num("playedPercent")} />
            <TextField id="minResumeDurationSeconds" label="Shortest resumable item" unit="s" type="number" inputMode="numeric" min={0} max={3_600} hint="0–3600; shorter items never get a resume point." error={errors.minResumeDurationSeconds?.message} {...num("minResumeDurationSeconds")} />
            <TextField id="nextUpCutoffDays" label="Next up window" unit="days" type="number" inputMode="numeric" min={1} max={3_650} hint="1–3650; series idle longer drop out." error={errors.nextUpCutoffDays?.message} {...num("nextUpCutoffDays")} />
          </div>
        </Panel>
      </div>

      <Panel icon={<Mail />} title="Email delivery" description="Used for sign-in codes, password resets and address verification.">
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
          <div className="space-y-2">
            <Label htmlFor="emailMode">Delivery mode</Label>
            <select id="emailMode" className={selectClassName} aria-describedby="emailMode-hint" {...form.register("emailMode")}>
              <option value="disabled">Off — no email</option>
              <option value="smtp">SMTP server</option>
              <option value="outbox">Test outbox — capture only, never send</option>
            </select>
            <p id="emailMode-hint" className="text-xs leading-5 text-muted-foreground">
              {emailMode === "outbox"
                ? "Messages are kept in memory and shown in the Test harness; nothing leaves the server."
                : emailMode === "smtp"
                  ? "Messages are delivered through your mail server."
                  : "Email features are unavailable to viewers."}
            </p>
          </div>

          {emailMode === "smtp" && (
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField id="smtpHost" label="SMTP host" placeholder="smtp.example.com" autoComplete="off" error={errors.smtpHost?.message} {...form.register("smtpHost")} />
              <div className="grid grid-cols-[minmax(0,6rem)_minmax(0,1fr)] gap-3">
                <TextField id="smtpPort" label="Port" type="number" inputMode="numeric" min={1} max={65_535} error={errors.smtpPort?.message} {...num("smtpPort")} />
                <div className="min-w-0 space-y-2">
                  <Label htmlFor="smtpSecurity">Security</Label>
                  <select id="smtpSecurity" className={selectClassName} {...form.register("smtpSecurity")}>
                    <option value="auto">Auto</option>
                    <option value="startTls">STARTTLS</option>
                    <option value="sslOnConnect">SSL/TLS on connect</option>
                    <option value="none">None (plain)</option>
                  </select>
                </div>
              </div>
              <TextField id="smtpUsername" label="Username" autoComplete="off" hint="Leave empty for unauthenticated relays." error={errors.smtpUsername?.message} {...form.register("smtpUsername")} />
              <div className="min-w-0 space-y-2">
                <TextField
                  id="smtpPassword"
                  label="Password"
                  type="password"
                  autoComplete="new-password"
                  placeholder={hasStoredPassword && !clearPassword ? "•••••••• (saved)" : ""}
                  disabled={clearPassword}
                  hint={hasStoredPassword ? "Write-only. Leave empty to keep the saved password." : "Write-only; never shown again."}
                  error={errors.smtpPassword?.message}
                  {...form.register("smtpPassword")}
                />
                {hasStoredPassword && (
                  <label className="flex items-center gap-2 text-xs">
                    <input type="checkbox" className="size-3.5 accent-cyan-600" {...form.register("clearSmtpPassword")} />
                    Remove the saved password
                  </label>
                )}
              </div>
              <TextField id="fromAddress" label="From address" type="email" placeholder="streamarr@example.com" error={errors.fromAddress?.message} {...form.register("fromAddress")} />
              <TextField id="fromName" label="From name" placeholder="Streamarr" error={errors.fromName?.message} {...form.register("fromName")} />
            </div>
          )}
        </div>
        <TestEmail dirty={form.formState.isDirty} ready={settings.emailDeliveryReady} mode={settings.email?.mode ?? "disabled"} />
      </Panel>

      <div className="sticky bottom-0 z-10 -mx-1 flex flex-wrap items-center justify-end gap-2 rounded-xl border bg-background/95 p-3 backdrop-blur supports-[backdrop-filter]:bg-background/75">
        <p className="mr-auto text-xs text-muted-foreground" aria-live="polite">
          {form.formState.isDirty ? "Unsaved changes" : "All changes saved"}
        </p>
        <Button type="button" variant="outline" disabled={!form.formState.isDirty || update.isPending} onClick={() => form.reset(toValues(settings))}>
          <RotateCcw />Reset
        </Button>
        <Button type="submit" disabled={update.isPending || !form.formState.isDirty}>
          {update.isPending ? <Loader2 className="animate-spin" /> : <Save />}
          Save viewer settings
        </Button>
      </div>
    </form>
  );
}

function TestEmail({ dirty, ready, mode }: { dirty: boolean; ready: boolean; mode: string }) {
  const send = useSendViewerTestEmail();
  const [to, setTo] = useState("");

  async function submit() {
    try {
      await send.mutateAsync(to.trim());
      toast.success(mode === "outbox" ? "Test email captured in the test outbox." : `Test email sent to ${to.trim()}.`);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  return (
    <div className="space-y-2 border-t pt-4">
      <Label htmlFor="test-email-to">Send a test email</Label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          id="test-email-to"
          type="email"
          placeholder="you@example.com"
          value={to}
          onChange={(event) => setTo(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              if (to.trim() && ready) void submit();
            }
          }}
          className="sm:max-w-sm"
        />
        <Button type="button" variant="outline" onClick={submit} disabled={!to.trim() || !ready || send.isPending}>
          {send.isPending ? <Loader2 className="animate-spin" /> : <Send />}
          Send test email
        </Button>
      </div>
      <p className="text-xs leading-5 text-muted-foreground">
        {!ready ? "Save a working SMTP or Test outbox configuration first." : dirty ? "Uses the saved settings — save your changes first." : "Uses the saved settings; SMTP errors are shown as they come back from the server."}
      </p>
    </div>
  );
}

function FormSwitch({
  control,
  name,
  label,
  description,
}: {
  control: Control<Values>;
  name: FieldPath<Values>;
  label: string;
  description: ReactNode;
}) {
  return (
    <Controller
      control={control}
      name={name}
      render={({ field }) => (
        <SwitchField id={`switch-${name}`} label={label} description={description} checked={field.value === true} onCheckedChange={field.onChange} />
      )}
    />
  );
}
