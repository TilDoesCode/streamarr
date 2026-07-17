import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { BellRing, Loader2, Send } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  useNotificationConfig,
  useTestNotification,
  useUpdateNotificationConfig,
} from "@/api/queries";
import type { NotificationConfigWrite } from "@/api/types";
import { errorMessage } from "@/api/client";

const schema = z.object({
  enabled: z.boolean(),
  appToken: z.string().max(128).optional(),
  userKey: z.string().max(128).optional(),
  device: z.string().max(25),
  sound: z.string().max(64),
  notifyApplicationStarted: z.boolean(),
  notifyPlaybackStarted: z.boolean(),
  notifyPlaybackProgress: z.boolean(),
  notifyPlaybackStopped: z.boolean(),
  notifyResolveSucceeded: z.boolean(),
  notifyResolveFailed: z.boolean(),
  notifyErrors: z.boolean(),
  notifyOutages: z.boolean(),
  notifyRecoveries: z.boolean(),
  includeUserName: z.boolean(),
  includeDeviceName: z.boolean(),
  includeReleaseId: z.boolean(),
  usagePriority: z.coerce.number().int().min(-2).max(2),
  errorPriority: z.coerce.number().int().min(-2).max(2),
  outagePriority: z.coerce.number().int().min(-2).max(2),
  recoveryPriority: z.coerce.number().int().min(-2).max(2),
  progressIntervalMinutes: z.coerce.number().int().min(1).max(1440),
  errorCooldownSeconds: z.coerce.number().int().min(0).max(86400),
  monitorIntervalSeconds: z.coerce.number().int().min(15).max(86400),
  outageFailureThreshold: z.coerce.number().int().min(1).max(100),
  outageReminderMinutes: z.coerce.number().int().min(0).max(10080),
  emergencyRetrySeconds: z.coerce.number().int().min(30).max(10800),
  emergencyExpireSeconds: z.coerce.number().int().min(30).max(10800),
});
type Values = z.input<typeof schema>;

const priorityOptions = [
  [-2, "Lowest — no alert"],
  [-1, "Low — silent"],
  [0, "Normal"],
  [1, "High — bypass quiet hours"],
  [2, "Emergency — repeat until acknowledged"],
] as const;

export function NotificationSettings() {
  const query = useNotificationConfig();
  const update = useUpdateNotificationConfig();
  const test = useTestNotification();
  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: defaults,
  });

  useEffect(() => {
    if (query.data) form.reset({
      ...defaults,
      ...query.data,
      device: query.data.device ?? "",
      sound: query.data.sound ?? "",
      appToken: "",
      userKey: "",
    });
  }, [query.data, form]);

  const values = form.watch();
  const setToggle = (name: keyof Values) => (checked: boolean) =>
    form.setValue(name, checked, { shouldDirty: true });

  async function save(raw: Values) {
    const parsed = schema.parse(raw);
    const body = { ...parsed } as NotificationConfigWrite;
    if (!parsed.appToken?.trim()) delete body.appToken;
    if (!parsed.userKey?.trim()) delete body.userKey;
    try {
      await update.mutateAsync(body);
      toast.success("Notification settings saved.");
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  async function sendTest() {
    try {
      await test.mutateAsync();
      toast.success("Test notification sent.");
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  if (query.isLoading) return <Card><CardContent className="h-44 animate-pulse bg-muted/20" /></Card>;
  if (query.isError) return <Card><CardContent className="pt-6 text-sm text-destructive">{errorMessage(query.error)}</CardContent></Card>;

  return (
    <form onSubmit={form.handleSubmit(save)} className="space-y-4" noValidate>
      <Card className="overflow-hidden">
        <CardHeader className="border-b bg-muted/20">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <CardTitle className="flex items-center gap-2"><BellRing className="size-5" />Pushover</CardTitle>
              <CardDescription>Push operational events to a Pushover user, group, or individual device.</CardDescription>
            </div>
            <Switch
              checked={values.enabled}
              onCheckedChange={setToggle("enabled")}
              aria-label="Enable Pushover notifications"
            />
          </div>
        </CardHeader>
        <CardContent className="grid gap-5 pt-6 md:grid-cols-2">
          <Field id="appToken" label="Application API token" hint={query.data?.hasAppToken ? "Configured. Leave blank to keep it." : "Create an application in Pushover to obtain this token."}>
            <Input id="appToken" type="password" autoComplete="off" placeholder={query.data?.hasAppToken ? "••••••••" : "Application token"} {...form.register("appToken")} />
          </Field>
          <Field id="userKey" label="User or group key" hint={query.data?.hasUserKey ? "Configured. Leave blank to keep it." : "Messages may target a user or delivery group."}>
            <Input id="userKey" type="password" autoComplete="off" placeholder={query.data?.hasUserKey ? "••••••••" : "User/group key"} {...form.register("userKey")} />
          </Field>
          <Field id="device" label="Device (optional)" hint="Leave empty to notify every device attached to the key.">
            <Input id="device" placeholder="e.g. phone" {...form.register("device")} />
          </Field>
          <Field id="sound" label="Sound (optional)" hint="A Pushover sound name; empty uses the recipient’s default.">
            <Input id="sound" placeholder="e.g. pushover" {...form.register("sound")} />
          </Field>
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        <EventCard title="Usage events" description="Choose the routine activity worth interrupting you for.">
          <Toggle label="Server started" checked={values.notifyApplicationStarted} onChange={setToggle("notifyApplicationStarted")} />
          <Toggle label="Playback started" checked={values.notifyPlaybackStarted} onChange={setToggle("notifyPlaybackStarted")} />
          <Toggle label="Playback progress" checked={values.notifyPlaybackProgress} onChange={setToggle("notifyPlaybackProgress")} />
          <Toggle label="Playback stopped" checked={values.notifyPlaybackStopped} onChange={setToggle("notifyPlaybackStopped")} />
          <Toggle label="Resolve succeeded" checked={values.notifyResolveSucceeded} onChange={setToggle("notifyResolveSucceeded")} />
        </EventCard>
        <EventCard title="Failures & availability" description="Transition alerts are deduplicated and recoveries are sent once.">
          <Toggle label="Resolve failed" checked={values.notifyResolveFailed} onChange={setToggle("notifyResolveFailed")} />
          <Toggle label="Unhandled server errors" checked={values.notifyErrors} onChange={setToggle("notifyErrors")} />
          <Toggle label="Indexer/provider outages" checked={values.notifyOutages} onChange={setToggle("notifyOutages")} />
          <Toggle label="Indexer/provider recoveries" checked={values.notifyRecoveries} onChange={setToggle("notifyRecoveries")} />
        </EventCard>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <EventCard title="Message content" description="Control potentially identifying context included in usage alerts.">
          <Toggle label="User name" checked={values.includeUserName} onChange={setToggle("includeUserName")} />
          <Toggle label="Playback device" checked={values.includeDeviceName} onChange={setToggle("includeDeviceName")} />
          <Toggle label="Internal release ID" checked={values.includeReleaseId} onChange={setToggle("includeReleaseId")} />
        </EventCard>
        <Card>
          <CardHeader><CardTitle>Timing</CardTitle><CardDescription>Throttle chatter and decide when a dependency is truly down.</CardDescription></CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <NumberField label="Progress interval (min)" name="progressIntervalMinutes" form={form} />
            <NumberField label="Error cooldown (sec)" name="errorCooldownSeconds" form={form} />
            <NumberField label="Health check interval (sec)" name="monitorIntervalSeconds" form={form} />
            <NumberField label="Failures before outage" name="outageFailureThreshold" form={form} />
            <NumberField label="Outage reminder (min)" name="outageReminderMinutes" form={form} hint="0 disables reminders." />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader><CardTitle>Delivery priority</CardTitle><CardDescription>Emergency priority repeats until acknowledged. Retry and expiry apply only to emergency messages.</CardDescription></CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <PriorityField label="Usage" name="usagePriority" form={form} />
          <PriorityField label="Errors" name="errorPriority" form={form} />
          <PriorityField label="Outages" name="outagePriority" form={form} />
          <PriorityField label="Recoveries" name="recoveryPriority" form={form} />
          <NumberField label="Emergency retry (sec)" name="emergencyRetrySeconds" form={form} />
          <NumberField label="Emergency expiry (sec)" name="emergencyExpireSeconds" form={form} />
        </CardContent>
      </Card>

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button type="button" variant="outline" onClick={sendTest} disabled={test.isPending}>
          {test.isPending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}Send test
        </Button>
        <Button type="submit" disabled={update.isPending || !form.formState.isDirty}>
          {update.isPending && <Loader2 className="size-4 animate-spin" />}Save notifications
        </Button>
      </div>
    </form>
  );
}

const defaults: Values = {
  enabled: false, appToken: "", userKey: "", device: "", sound: "",
  notifyApplicationStarted: false, notifyPlaybackStarted: true, notifyPlaybackProgress: false,
  notifyPlaybackStopped: true, notifyResolveSucceeded: false, notifyResolveFailed: true,
  notifyErrors: true, notifyOutages: true, notifyRecoveries: true,
  includeUserName: true, includeDeviceName: true, includeReleaseId: false,
  usagePriority: 0, errorPriority: 1, outagePriority: 1, recoveryPriority: 0,
  progressIntervalMinutes: 30, errorCooldownSeconds: 300, monitorIntervalSeconds: 60,
  outageFailureThreshold: 3, outageReminderMinutes: 0, emergencyRetrySeconds: 60,
  emergencyExpireSeconds: 3600,
};

function EventCard({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return <Card><CardHeader><CardTitle>{title}</CardTitle><CardDescription>{description}</CardDescription></CardHeader><CardContent className="divide-y">{children}</CardContent></Card>;
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return <div className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0"><span className="text-sm">{label}</span><Switch checked={checked} onCheckedChange={onChange} aria-label={label} /></div>;
}

function Field({ id, label, hint, children }: { id: string; label: string; hint?: string; children: React.ReactNode }) {
  return <div className="space-y-2"><Label htmlFor={id}>{label}</Label>{children}{hint && <p className="text-xs text-muted-foreground">{hint}</p>}</div>;
}

function NumberField({ label, name, form, hint }: { label: string; name: keyof Values; form: ReturnType<typeof useForm<Values>>; hint?: string }) {
  return <Field id={name} label={label} hint={hint}><Input id={name} type="number" {...form.register(name)} /></Field>;
}

function PriorityField({ label, name, form }: { label: string; name: keyof Values; form: ReturnType<typeof useForm<Values>> }) {
  return <Field id={name} label={label}><select id={name} className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm" {...form.register(name)}>{priorityOptions.map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select></Field>;
}
