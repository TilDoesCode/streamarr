import { useState } from "react";
import { ArrowRight, Check, Copy, HardDrive, MonitorPlay, Server, ShieldCheck, Terminal, Wifi } from "lucide-react";
import { SectionHeading } from "./shared";

export function DataPath({ client, connections, globalConnections, connectionBudget, cachedChunks, providers }: {
  client: string;
  connections: number;
  globalConnections: number;
  connectionBudget: number;
  cachedChunks: number;
  providers: Array<{ name: string | null; tripped?: boolean; activeConnections?: number }>;
}) {
  const providerLabel = providers.length ? `${providers.filter((provider) => !provider.tripped).length}/${providers.length} providers ready` : "provider pool";
  const nodes = [
    { icon: <MonitorPlay />, label: "Client", value: client, detail: "byte-range consumer" },
    { icon: <ShieldCheck />, label: "Session gate", value: "admitted", detail: "capability verified" },
    { icon: <Server />, label: "NNTP pool", value: `${connections} active`, detail: `${globalConnections}/${connectionBudget || "—"} global · ${providerLabel}` },
    { icon: <HardDrive />, label: "Segment cache", value: `${cachedChunks} resident`, detail: "decoded article chunks" },
  ];
  return (
    <div className="grid min-w-0 grid-cols-1 gap-2 md:grid-cols-[1fr_auto_1fr_auto_1fr_auto_1fr] md:items-center">
      {nodes.map((node, index) => (
        <div className="contents" key={node.label}>
          <div className="min-w-0 rounded-xl border bg-muted/20 p-4 dark:bg-muted/15">
            <div className="flex items-center justify-between text-muted-foreground [&_svg]:size-4 [&_svg]:text-primary"><span className="font-mono text-[9px] uppercase tracking-wider">{node.label}</span>{node.icon}</div>
            <p className="mt-4 truncate font-mono text-sm font-medium text-foreground">{node.value}</p>
            <p className="mt-1 truncate text-[10px] text-muted-foreground/80">{node.detail}</p>
          </div>
          {index < nodes.length - 1 && (
            <span className="flex h-5 items-center justify-center text-primary/60 md:h-auto md:w-5">
              <ArrowRight className="size-3.5 rotate-90 md:rotate-0" />
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

export function DetailCell({ icon, label, value, detail }: { icon: React.ReactNode; label: string; value: string; detail: string }) {
  return (
    <div className="min-w-0 bg-card p-4 sm:p-5">
      <div className="flex items-center gap-2 font-mono text-[9px] uppercase tracking-wider text-muted-foreground [&_svg]:size-3.5 [&_svg]:text-primary">{icon}{label}</div>
      <p className="mt-3 truncate font-mono text-sm text-foreground" title={value}>{value}</p>
      <p className="mt-1 truncate text-[10px] text-muted-foreground/80">{detail}</p>
    </div>
  );
}

export function LedgerRow({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="grid grid-cols-[7rem_minmax(0,1fr)] gap-3 py-3 font-mono text-[11px]">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right"><span className="block truncate text-foreground">{value}</span><span className="block text-[9px] uppercase tracking-wider text-muted-foreground/70">{detail}</span></dd>
    </div>
  );
}

export function Identifier({ label, value, secret = false }: { label: string; value: string; secret?: boolean }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  }
  const display = secret && value.length > 24 ? `${value.slice(0, 12)}••••••••${value.slice(-8)}` : value;
  return (
    <div className="rounded-lg border bg-muted/20 p-3">
      <div className="flex items-center justify-between gap-3">
        <p className="font-mono text-[9px] uppercase tracking-[0.15em] text-muted-foreground">{label}</p>
        <button type="button" onClick={copy} className="flex size-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-primary active:translate-y-px" aria-label={`Copy ${label}`}>
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        </button>
      </div>
      <p className="mt-2 break-all font-mono text-[10px] leading-5 text-muted-foreground">{display}</p>
    </div>
  );
}

/** The "Network & session" sub screen: live delivery topology plus identity/lifecycle ledger. */
export function NetworkTab({
  dataPath,
  detailCells,
  ledgerRows,
  identifiers,
}: {
  dataPath?: React.ReactNode;
  detailCells: React.ReactNode;
  ledgerRows: React.ReactNode;
  identifiers: React.ReactNode;
}) {
  return (
    <div className="grid min-w-0 grid-cols-1 gap-8 xl:grid-cols-[minmax(0,1.18fr)_minmax(23rem,.82fr)]">
      <div className="min-w-0">
        {dataPath && (
          <>
            <SectionHeading
              icon={<Wifi />}
              eyebrow="Delivery topology"
              title="The live data path"
              detail="A single request traced from player to pooled Usenet transport."
            />
            <div className="mt-8">{dataPath}</div>
          </>
        )}
        <div className={dataPath ? "mt-10 grid gap-px overflow-hidden rounded-xl border bg-border sm:grid-cols-2" : "grid gap-px overflow-hidden rounded-xl border bg-border sm:grid-cols-2"}>
          {detailCells}
        </div>
      </div>

      <aside className="min-w-0">
        <SectionHeading
          icon={<Terminal />}
          eyebrow="Session ledger"
          title="Identity & lifecycle"
          detail="Exact values for correlating UI symptoms with server logs."
        />
        <dl className="mt-7 divide-y border-y">{ledgerRows}</dl>
        <div className="mt-7 space-y-3">{identifiers}</div>
      </aside>
    </div>
  );
}
