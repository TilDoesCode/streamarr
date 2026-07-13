import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Copy, Loader2, Plus, Trash2, KeyRound, Check } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useApiKeys, useCreateApiKey, useRevokeApiKey } from "@/api/queries";
import type { ApiKeyResponse, CreatedApiKeyResponse } from "@/api/types";
import { errorMessage } from "@/api/client";

const schema = z.object({ name: z.string().trim().min(1, "A name is required") });
type FormValues = z.infer<typeof schema>;

export function ApiKeysSettings() {
  const { data: keys, isLoading, isError, error } = useApiKeys();
  const create = useCreateApiKey();
  const [created, setCreated] = useState<CreatedApiKeyResponse | null>(null);
  const [toRevoke, setToRevoke] = useState<ApiKeyResponse | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: { name: "" } });

  async function onCreate(values: FormValues) {
    try {
      const res = await create.mutateAsync({ name: values.name.trim() });
      setCreated(res);
      reset({ name: "" });
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Machine API keys</CardTitle>
        <CardDescription>
          Bearer keys for headless clients such as the Jellyfin plugin (BRIEF §6.4). The token is
          shown once, at creation — store it now. Revoking is immediate and permanent.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <form onSubmit={handleSubmit(onCreate)} className="flex flex-col gap-2 sm:flex-row sm:items-start">
          <div className="flex-1 space-y-1">
            <Label htmlFor="apiKeyName" className="sr-only">
              New key name
            </Label>
            <Input
              id="apiKeyName"
              placeholder="Key name (e.g. jellyfin-plugin)"
              aria-invalid={!!errors.name}
              {...register("name")}
            />
            {errors.name && <p className="text-xs text-destructive">{errors.name.message}</p>}
          </div>
          <Button type="submit" disabled={create.isPending}>
            {create.isPending ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
            Create key
          </Button>
        </form>

        {isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 2 }).map((_, i) => (
              <div key={i} className="h-14 w-full animate-pulse rounded-md bg-muted" />
            ))}
          </div>
        ) : isError ? (
          <p className="text-sm text-destructive">{errorMessage(error)}</p>
        ) : !keys || keys.length === 0 ? (
          <div className="flex flex-col items-center gap-1 rounded-md border border-dashed py-8 text-center">
            <KeyRound className="size-6 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">No API keys yet.</p>
          </div>
        ) : (
          <ul className="divide-y rounded-md border">
            {keys.map((key) => (
              <li key={key.id} className="flex items-center gap-3 p-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{key.name}</span>
                    {key.revoked ? (
                      <Badge variant="muted">Revoked</Badge>
                    ) : (
                      <Badge variant="success">Active</Badge>
                    )}
                  </div>
                  <p className="mt-0.5 font-mono text-xs text-muted-foreground">
                    {key.prefix ?? ""}… · created {formatDate(key.createdAt)}
                  </p>
                </div>
                {!key.revoked && (
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Revoke ${key.name}`}
                    onClick={() => setToRevoke(key)}
                  >
                    <Trash2 className="size-4 text-destructive" />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      <CreatedKeyDialog created={created} onClose={() => setCreated(null)} />
      <RevokeDialog target={toRevoke} onClose={() => setToRevoke(null)} />
    </Card>
  );
}

function CreatedKeyDialog({
  created,
  onClose,
}: {
  created: CreatedApiKeyResponse | null;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.token ?? "");
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Couldn't copy to clipboard.");
    }
  }

  return (
    <Dialog open={created !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>API key created</DialogTitle>
          <DialogDescription>
            Copy this token now — it is shown only once and cannot be retrieved later.
          </DialogDescription>
        </DialogHeader>
        {created && (
          <div className="flex items-center gap-2 rounded-md border bg-muted/50 p-2">
            <code className="min-w-0 flex-1 break-all font-mono text-xs">{created.token}</code>
            <Button variant="outline" size="icon" onClick={copy} aria-label="Copy token">
              {copied ? <Check className="size-4 text-emerald-500" /> : <Copy className="size-4" />}
            </Button>
          </div>
        )}
        <DialogFooter>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RevokeDialog({ target, onClose }: { target: ApiKeyResponse | null; onClose: () => void }) {
  const revoke = useRevokeApiKey();

  async function confirm() {
    if (!target?.id) return;
    try {
      await revoke.mutateAsync(target.id);
      toast.success(`Revoked “${target.name}”.`);
      onClose();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Revoke API key</DialogTitle>
          <DialogDescription>
            {target
              ? `"${target.name}" will stop working immediately. Any client using it must be issued a new key. This cannot be undone.`
              : ""}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={revoke.isPending}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={confirm} disabled={revoke.isPending}>
            {revoke.isPending && <Loader2 className="size-4 animate-spin" />}
            Revoke
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "unknown";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
}
