import { useState, type ReactNode } from "react";
import { Check, ChevronRight, Copy } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function CopyButton({ text, label, className }: { text: string; label: string; className?: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      if (!navigator.clipboard) throw new Error("Clipboard access is not available in this context.");
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not copy to the clipboard.");
    }
  }

  return (
    <Button type="button" size="sm" variant="outline" className={cn("h-7 bg-background/90 px-2 text-xs", className)} onClick={copy} aria-label={label}>
      {copied ? <Check /> : <Copy />}
      {copied ? "Copied" : "Copy"}
    </Button>
  );
}

/** Collapsible monospace block (ffmpeg command, log tail) with a copy action. */
export function CodeDisclosure({
  title,
  text,
  meta,
  defaultOpen = false,
  emptyText = "Nothing captured.",
}: {
  title: string;
  text: string;
  meta?: ReactNode;
  defaultOpen?: boolean;
  emptyText?: string;
}) {
  return (
    <details className="group rounded-lg border bg-muted/20 dark:bg-zinc-900/40" open={defaultOpen}>
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
        <span>{title}</span>
        {meta && <span className="ml-auto truncate font-mono text-[10px] font-normal text-muted-foreground">{meta}</span>}
      </summary>
      <div className="relative border-t">
        {text ? (
          <>
            <CopyButton text={text} label={`Copy ${title.toLowerCase()}`} className="absolute right-2 top-2" />
            <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all p-3 pr-24 font-mono text-[11px] leading-5 text-foreground/90">
              {text}
            </pre>
          </>
        ) : (
          <p className="p-3 text-xs text-muted-foreground">{emptyText}</p>
        )}
      </div>
    </details>
  );
}
