import { useMemo, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  AlertTriangle,
  ArrowLeft,
  ChevronDown,
  ExternalLink,
  FileUp,
  KeyRound,
  Loader2,
  Sparkles,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useCreateTunnel, useImportTunnel, useTunnelPresets, useUpdateTunnel } from "@/api/queries";
import type { TunnelFieldError, TunnelPresetResponse, TunnelResponse } from "@/api/types";
import { ApiError, errorMessage } from "@/api/client";
import { cn } from "@/lib/utils";
import {
  emptyValues,
  isTunnelField,
  toTunnelWrite,
  tunnelSchema,
  valuesFromImport,
  valuesFromTunnel,
  type TunnelFormValues,
} from "./form";
import { CopyableKey } from "./copyable-key";

const MAX_CONF_BYTES = 64 * 1024;
const ADVANCED_FIELDS = ["mtu", "keepalive", "allowedIps"] as const;

const selectClassName =
  "flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

type Step = "provider" | "details";

/** Create (two steps: provider + import, then details) or edit (details only) a WireGuard tunnel. */
export function TunnelDialog({ tunnel, onClose }: { tunnel: TunnelResponse | null; onClose: () => void }) {
  const isEdit = tunnel !== null;
  const presets = useTunnelPresets();
  const importTunnel = useImportTunnel();
  const create = useCreateTunnel();
  const update = useUpdateTunnel();

  const [step, setStep] = useState<Step>(isEdit ? "details" : "provider");
  const [selectedPreset, setSelectedPreset] = useState<string | null>(null);
  const [confText, setConfText] = useState("");
  const [importProblems, setImportProblems] = useState<TunnelFieldError[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [detectedPreset, setDetectedPreset] = useState<string | null>(null);
  const [fromImport, setFromImport] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const schema = useMemo(
    () => tunnelSchema({ requirePrivateKey: !isEdit || !tunnel?.hasPrivateKey }),
    [isEdit, tunnel?.hasPrivateKey],
  );
  const form = useForm<TunnelFormValues>({
    resolver: zodResolver(schema),
    defaultValues: tunnel ? valuesFromTunnel(tunnel) : emptyValues(),
  });
  const { register, handleSubmit, reset, setError, setValue, watch, formState } = form;
  const errors = formState.errors;

  const presetList = presets.data ?? [];
  const presetById = (id?: string | null) => presetList.find((preset) => preset.id === id);
  const presetValue = watch("preset");
  const currentPreset = presetById(presetValue);
  const enabled = watch("enabled");
  const removePresharedKey = watch("removePresharedKey");
  const showAdvanced = advancedOpen || ADVANCED_FIELDS.some((field) => errors[field]);

  function applyFieldErrors(fieldErrors: TunnelFieldError[]) {
    for (const problem of fieldErrors) {
      if (isTunnelField(problem.field)) setError(problem.field, { type: "server", message: problem.message ?? "Invalid value" });
    }
  }

  async function parse() {
    setImportProblems([]);
    try {
      const result = await importTunnel.mutateAsync(confText);
      const found = result.detectedPreset && result.detectedPreset !== "custom" ? result.detectedPreset : null;
      const preset = found ?? selectedPreset ?? "custom";
      const problems = result.errors ?? [];
      const structural = problems.filter((problem) => !isTunnelField(problem.field));
      const prefill = result.tunnel;
      if (!prefill.endpoint && !prefill.peerPublicKey && !prefill.privateKey) {
        setImportProblems(structural.length > 0 ? structural : problems);
        return;
      }
      reset(valuesFromImport(prefill, preset, presetById(preset)?.name ?? "WireGuard tunnel"));
      applyFieldErrors(problems);
      setImportProblems(structural);
      setWarnings(result.warnings ?? []);
      setDetectedPreset(found);
      setFromImport(true);
      setStep("details");
    } catch (err) {
      toast.error(`Could not read the configuration: ${errorMessage(err)}`);
    }
  }

  function enterManually() {
    const preset = selectedPreset ?? "custom";
    reset({ ...emptyValues(preset), name: presetById(preset)?.name ?? "" });
    setImportProblems([]);
    setWarnings([]);
    setDetectedPreset(null);
    setFromImport(false);
    setStep("details");
  }

  async function onSubmit(values: TunnelFormValues) {
    const body = toTunnelWrite(values);
    try {
      if (isEdit) await update.mutateAsync({ id: tunnel!.id!, body });
      else await create.mutateAsync(body);
      toast.success(isEdit ? `Tunnel “${body.name}” saved.` : `Tunnel “${body.name}” added. Assign it to indexers or providers next.`);
      onClose();
    } catch (err) {
      const params = err instanceof ApiError ? err.envelope?.error?.params : null;
      if (params && Object.keys(params).length > 0) {
        applyFieldErrors(Object.entries(params).map(([field, message]) => ({ field, message })));
        if (Object.keys(params).some((field) => (ADVANCED_FIELDS as readonly string[]).includes(field))) setAdvancedOpen(true);
      }
      toast.error(errorMessage(err));
    }
  }

  const pending = create.isPending || update.isPending;
  const dnsDefaults = currentPreset?.defaultDns ?? [];

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{isEdit ? `Edit ${tunnel?.name ?? "tunnel"}` : "Add VPN tunnel"}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? "WireGuard settings for this tunnel. Keys are stored encrypted and never shown again."
              : "Import the WireGuard configuration your VPN provider generated. Nothing is stored until you save."}
          </DialogDescription>
        </DialogHeader>

        {!isEdit && <Stepper step={step} />}

        {step === "provider" ? (
          <div className="space-y-5">
            <PresetGrid
              presets={presetList}
              loading={presets.isLoading}
              selected={selectedPreset}
              onSelect={setSelectedPreset}
            />
            <ConfInput value={confText} onChange={setConfText} />
            {importProblems.length > 0 && <ProblemList problems={importProblems} />}
            <DialogFooter className="items-center sm:justify-between">
              <Button type="button" variant="link" className="px-0" onClick={enterManually}>
                Skip import and enter the details by hand
              </Button>
              <Button type="button" onClick={parse} disabled={!confText.trim() || importTunnel.isPending}>
                {importTunnel.isPending ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
                Parse configuration
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate>
            {(warnings.length > 0 || detectedPreset) && (
              <ImportSummary warnings={warnings} detected={presetById(detectedPreset)?.name ?? null} />
            )}
            {importProblems.length > 0 && <ProblemList problems={importProblems} />}

            <div className="grid gap-4 sm:grid-cols-2">
              <Field id="tunnel-name" label="Name" error={errors.name?.message}>
                <Input id="tunnel-name" aria-invalid={!!errors.name} {...register("name")} />
              </Field>
              <Field id="tunnel-preset" label="VPN provider" error={errors.preset?.message}>
                <select id="tunnel-preset" className={selectClassName} {...register("preset")}>
                  {presetList.length === 0 && <option value={presetValue}>{presetValue}</option>}
                  {presetList.map((preset) => (
                    <option key={preset.id} value={preset.id ?? ""}>
                      {preset.name}
                    </option>
                  ))}
                </select>
              </Field>
            </div>

            <div className="grid gap-4 sm:grid-cols-[1fr_auto] sm:items-end">
              <Field id="tunnel-endpoint" label="Endpoint" hint="host:port of the VPN server, from [Peer] Endpoint." error={errors.endpoint?.message}>
                <Input
                  id="tunnel-endpoint"
                  placeholder={`vpn.example.com:${currentPreset?.defaultEndpointPort ?? 51820}`}
                  className="font-mono"
                  spellCheck={false}
                  aria-invalid={!!errors.endpoint}
                  {...register("endpoint")}
                />
              </Field>
              <div className="flex h-9 items-center gap-2 sm:mb-6">
                <Switch
                  id="tunnel-enabled"
                  checked={enabled}
                  onCheckedChange={(value) => setValue("enabled", value, { shouldDirty: true })}
                  aria-label="Enabled"
                />
                <Label htmlFor="tunnel-enabled" className="cursor-pointer">
                  Enabled
                </Label>
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field id="tunnel-addresses" label="Addresses" hint="Comma-separated, from [Interface] Address." error={errors.addresses?.message}>
                <Input id="tunnel-addresses" placeholder="10.64.12.3/32" className="font-mono" spellCheck={false} aria-invalid={!!errors.addresses} {...register("addresses")} />
              </Field>
              <Field
                id="tunnel-dns"
                label="DNS servers"
                hint={
                  dnsDefaults.length > 0
                    ? `Leave empty to use ${currentPreset?.name}'s ${dnsDefaults.join(", ")}. Hostnames resolve inside the tunnel.`
                    : "Required for custom tunnels. Hostnames resolve inside the tunnel."
                }
                error={errors.dns?.message}
              >
                <Input
                  id="tunnel-dns"
                  placeholder={dnsDefaults.join(", ") || "10.0.0.1"}
                  className="font-mono"
                  spellCheck={false}
                  aria-invalid={!!errors.dns}
                  {...register("dns")}
                />
              </Field>
            </div>

            <Field id="tunnel-peer" label="Peer public key" hint="The VPN server's key, from [Peer] PublicKey." error={errors.peerPublicKey?.message}>
              <Input id="tunnel-peer" className="font-mono" spellCheck={false} autoComplete="off" aria-invalid={!!errors.peerPublicKey} {...register("peerPublicKey")} />
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                id="tunnel-private"
                label="Private key"
                hint={
                  isEdit && tunnel?.hasPrivateKey
                    ? "Stored. Leave empty to keep it."
                    : fromImport
                      ? "Taken from your .conf. Stored encrypted, never shown again."
                      : "From [Interface] PrivateKey. Stored encrypted, never shown again."
                }
                error={errors.privateKey?.message}
              >
                <Input
                  id="tunnel-private"
                  type="password"
                  autoComplete="new-password"
                  className="font-mono"
                  placeholder={isEdit && tunnel?.hasPrivateKey ? "••••••••  stored" : "base64 key"}
                  aria-invalid={!!errors.privateKey}
                  {...register("privateKey")}
                />
              </Field>
              <div className="space-y-2">
                <Field
                  id="tunnel-psk"
                  label="Preshared key (optional)"
                  hint={isEdit && tunnel?.hasPresharedKey ? "Stored. Leave empty to keep it." : "Only if your provider issued one."}
                  error={errors.presharedKey?.message}
                >
                  <Input
                    id="tunnel-psk"
                    type="password"
                    autoComplete="new-password"
                    className="font-mono"
                    disabled={removePresharedKey}
                    placeholder={isEdit && tunnel?.hasPresharedKey ? "••••••••  stored" : "base64 key"}
                    aria-invalid={!!errors.presharedKey}
                    {...register("presharedKey")}
                  />
                </Field>
                {isEdit && tunnel?.hasPresharedKey && (
                  <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
                    <input type="checkbox" className="size-3.5 accent-primary" {...register("removePresharedKey")} />
                    Remove the stored preshared key
                  </label>
                )}
              </div>
            </div>

            <div className="rounded-lg border">
              <button
                type="button"
                className="flex w-full items-center justify-between px-3 py-2 text-sm font-medium"
                aria-expanded={showAdvanced}
                onClick={() => setAdvancedOpen(!showAdvanced)}
              >
                Advanced
                <ChevronDown className={cn("size-4 text-muted-foreground transition-transform", showAdvanced && "rotate-180")} />
              </button>
              {showAdvanced && (
                <div className="grid gap-4 border-t p-3 sm:grid-cols-[7rem_9rem_1fr]">
                  <Field id="tunnel-mtu" label="MTU" hint="1280–1500, empty = default." error={errors.mtu?.message}>
                    <Input id="tunnel-mtu" inputMode="numeric" placeholder="1420" aria-invalid={!!errors.mtu} {...register("mtu")} />
                  </Field>
                  <Field id="tunnel-keepalive" label="Keepalive (s)" hint="0–600, 0 = off." error={errors.keepalive?.message}>
                    <Input id="tunnel-keepalive" inputMode="numeric" placeholder="25" aria-invalid={!!errors.keepalive} {...register("keepalive")} />
                  </Field>
                  <Field id="tunnel-allowed" label="Allowed IPs" hint="Leave the default to send everything routed here through the tunnel." error={errors.allowedIps?.message}>
                    <Input id="tunnel-allowed" className="font-mono" spellCheck={false} aria-invalid={!!errors.allowedIps} {...register("allowedIps")} />
                  </Field>
                </div>
              )}
            </div>

            {isEdit && tunnel?.publicKey && (
              <div className="space-y-1.5 rounded-lg border bg-muted/30 p-3">
                <p className="flex items-center gap-1.5 text-xs font-medium">
                  <KeyRound className="size-3.5 text-muted-foreground" />
                  This device's public key, as the provider sees it
                </p>
                <CopyableKey value={tunnel.publicKey} />
              </div>
            )}

            <DialogFooter>
              {isEdit ? (
                <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
                  Cancel
                </Button>
              ) : (
                <Button type="button" variant="outline" onClick={() => setStep("provider")} disabled={pending}>
                  <ArrowLeft className="size-4" />
                  Back
                </Button>
              )}
              <Button type="submit" disabled={pending}>
                {pending && <Loader2 className="size-4 animate-spin" />}
                {isEdit ? "Save changes" : "Save tunnel"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Stepper({ step }: { step: Step }) {
  const steps: { id: Step; label: string }[] = [
    { id: "provider", label: "Provider" },
    { id: "details", label: "Details" },
  ];
  return (
    <ol className="flex items-center gap-2 text-xs" aria-label="Steps">
      {steps.map((item, index) => {
        const active = item.id === step;
        const done = step === "details" && item.id === "provider";
        return (
          <li key={item.id} className="flex items-center gap-2" aria-current={active ? "step" : undefined}>
            {index > 0 && <span className="h-px w-8 bg-border" aria-hidden />}
            <span
              className={cn(
                "flex size-5 items-center justify-center rounded-full border text-[11px] font-semibold",
                active && "border-primary bg-primary text-primary-foreground",
                done && "border-primary/40 bg-primary/10 text-primary",
                !active && !done && "text-muted-foreground",
              )}
            >
              {index + 1}
            </span>
            <span className={cn("font-medium", !active && "text-muted-foreground")}>{item.label}</span>
          </li>
        );
      })}
    </ol>
  );
}

function PresetGrid({
  presets,
  loading,
  selected,
  onSelect,
}: {
  presets: TunnelPresetResponse[];
  loading: boolean;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  if (loading)
    return (
      <div className="grid gap-2 sm:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-24 animate-pulse rounded-lg bg-muted" />
        ))}
      </div>
    );
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">1. Pick your VPN provider</p>
      <div role="radiogroup" aria-label="VPN provider" className="grid gap-2 sm:grid-cols-3">
        {presets.map((preset) => {
          const active = selected === preset.id;
          return (
            <div
              key={preset.id}
              className={cn(
                "flex flex-col rounded-lg border bg-card transition-colors",
                active ? "border-primary ring-1 ring-primary" : "hover:border-foreground/20",
              )}
            >
              <button
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => onSelect(preset.id ?? "custom")}
                className="flex-1 rounded-t-lg px-3 pt-2.5 pb-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="block text-sm font-medium">{preset.name}</span>
                <span className="mt-0.5 line-clamp-2 block text-xs text-muted-foreground" title={preset.hint ?? undefined}>
                  {preset.hint}
                </span>
              </button>
              {preset.helpUrl && (
                <a
                  href={preset.helpUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="inline-flex items-center gap-1 px-3 pb-2.5 text-xs font-medium text-primary hover:underline"
                >
                  Where do I get the config?
                  <ExternalLink className="size-3" />
                </a>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ConfInput({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  async function readFile(file?: File | null) {
    if (!file) return;
    if (file.size > MAX_CONF_BYTES) {
      toast.error("That file is larger than 64 KiB; a WireGuard .conf is a few hundred bytes.");
      return;
    }
    onChange(await readText(file));
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Label htmlFor="tunnel-conf">2. Paste your WireGuard config (.conf)</Label>
        <Button type="button" variant="outline" size="sm" onClick={() => fileInput.current?.click()}>
          <FileUp className="size-4" />
          Upload .conf
        </Button>
        <input
          ref={fileInput}
          type="file"
          accept=".conf,text/plain"
          className="hidden"
          aria-label="WireGuard configuration file"
          onChange={(event) => {
            void readFile(event.target.files?.[0]);
            event.target.value = "";
          }}
        />
      </div>
      <div
        className={cn("relative rounded-md", dragging && "ring-2 ring-primary ring-offset-2 ring-offset-background")}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          void readFile(event.dataTransfer.files?.[0]);
        }}
      >
        <textarea
          id="tunnel-conf"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          rows={8}
          spellCheck={false}
          placeholder={"[Interface]\nPrivateKey = …\nAddress = 10.64.12.3/32\nDNS = 10.64.0.1\n\n[Peer]\nPublicKey = …\nEndpoint = se-sto-wg-001.relays.mullvad.net:51820\nAllowedIPs = 0.0.0.0/0, ::/0\n\nor drop the .conf file here"}
          className="block w-full resize-y rounded-md border border-dashed border-input bg-background px-3 py-2 font-mono text-xs leading-relaxed shadow-sm placeholder:text-muted-foreground/70 focus-visible:border-solid focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </div>
      <p className="text-xs text-muted-foreground">
        The file is read in your browser and sent only to this Streamarr server to be parsed.
      </p>
    </div>
  );
}

function readText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

function ImportSummary({ warnings, detected }: { warnings: string[]; detected: string | null }) {
  return (
    <div className="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm" role="status" aria-label="Import notes">
      {detected && (
        <p className="flex items-center gap-1.5 text-xs">
          <Sparkles className="size-3.5 text-primary" />
          <span>
            Recognised <span className="font-medium">{detected}</span> from the configuration.
          </span>
        </p>
      )}
      {warnings.length > 0 && (
        <>
          <p className="flex items-center gap-1.5 text-xs font-medium text-amber-800 dark:text-amber-200">
            <AlertTriangle className="size-3.5" />
            Worth a glance before saving
          </p>
          <ul className="list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">
            {warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function ProblemList({ problems }: { problems: TunnelFieldError[] }) {
  return (
    <div role="alert" className="space-y-1 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
      {problems.map((problem, i) => (
        <p key={i} className="flex gap-1.5">
          <XCircle className="mt-0.5 size-3.5 shrink-0" />
          <span>{problem.message}</span>
        </p>
      ))}
    </div>
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
