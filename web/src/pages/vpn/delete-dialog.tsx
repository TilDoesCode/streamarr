import { useState } from "react";
import { Database, Loader2, Server, Unplug } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useDeleteTunnel } from "@/api/queries";
import type { TunnelResponse } from "@/api/types";
import { ApiError, errorMessage } from "@/api/client";

interface Dependents {
  providers: string[];
  indexers: string[];
}

function namesFrom(value?: string | null): string[] {
  return (value ?? "").split(",").map((name) => name.trim()).filter(Boolean);
}

/** Prefer the structured `usedBy` lists (names may contain commas); older servers only send the joined params. */
function dependentsFrom(error: ApiError): Dependents {
  const detail = error.envelope?.error;
  const usedBy = detail?.usedBy;
  if (usedBy)
    return {
      providers: (usedBy.providers ?? []).map((p) => p.name ?? "").filter(Boolean),
      indexers: (usedBy.indexers ?? []).map((i) => i.name ?? "").filter(Boolean),
    };
  const params = detail?.params ?? {};
  return { providers: namesFrom(params.providers), indexers: namesFrom(params.indexers) };
}

/** Confirm a delete; a `409 tunnel_in_use` turns it into "set them to direct and delete" (`?force=true`). */
export function DeleteTunnelDialog({ target, onClose }: { target: TunnelResponse | null; onClose: () => void }) {
  const del = useDeleteTunnel();
  const [inUse, setInUse] = useState<Dependents | null>(null);

  function close() {
    setInUse(null);
    onClose();
  }

  async function confirm(force: boolean) {
    if (!target?.id) return;
    try {
      await del.mutateAsync({ id: target.id, force });
      toast.success(force ? `Removed “${target.name}”; its connections are direct again.` : `Removed “${target.name}”.`);
      close();
    } catch (err) {
      if (err instanceof ApiError && err.code === "tunnel_in_use") {
        setInUse(dependentsFrom(err));
        return;
      }
      toast.error(errorMessage(err));
    }
  }

  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{inUse ? "This tunnel is still in use" : "Remove tunnel"}</DialogTitle>
          <DialogDescription>
            {inUse
              ? `These connections go through “${target?.name}”. Removing it sets them back to direct, so their traffic leaves without a VPN.`
              : target
                ? `“${target.name}” and its keys will be deleted. This cannot be undone.`
                : ""}
          </DialogDescription>
        </DialogHeader>

        {inUse && (
          <ul className="space-y-1.5 rounded-lg border bg-muted/30 p-3 text-sm" aria-label="Routed through this tunnel">
            {inUse.indexers.map((name, index) => (
              <li key={`i-${index}`} className="flex items-center gap-2">
                <Database className="size-3.5 text-muted-foreground" />
                {name}
                <span className="text-xs text-muted-foreground">indexer</span>
              </li>
            ))}
            {inUse.providers.map((name, index) => (
              <li key={`p-${index}`} className="flex items-center gap-2">
                <Server className="size-3.5 text-muted-foreground" />
                {name}
                <span className="text-xs text-muted-foreground">Usenet provider</span>
              </li>
            ))}
          </ul>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={close} disabled={del.isPending}>
            Cancel
          </Button>
          {inUse ? (
            <Button variant="destructive" onClick={() => confirm(true)} disabled={del.isPending}>
              {del.isPending ? <Loader2 className="size-4 animate-spin" /> : <Unplug className="size-4" />}
              Set them to direct and delete
            </Button>
          ) : (
            <Button variant="destructive" onClick={() => confirm(false)} disabled={del.isPending}>
              {del.isPending && <Loader2 className="size-4 animate-spin" />}
              Remove
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

