import { ChevronRight, Eraser, Inbox, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { errorMessage } from "@/api/client";
import { useClearViewerOutbox, useUpdateViewerSettings, useViewerOutbox, useViewerSettings } from "@/api/queries";
import type { ViewerOutboxMessageResponse } from "@/api/types";
import { CopyButton } from "@/components/code-disclosure";
import { Button } from "@/components/ui/button";
import { timeAgo } from "@/lib/utils";
import { extractCodes } from "@/lib/viewers";
import { ErrorPanel, Hint, Panel, ToneBadge } from "../shared";

const POLL_MS = 3_000;

/** Mails captured by the server in test-outbox mode; polled while the harness is open. */
export function OutboxPanel({ onOpenSettings }: { onOpenSettings?: () => void }) {
  const settings = useViewerSettings();
  const isOutbox = settings.data?.email?.mode === "outbox";
  const outbox = useViewerOutbox({ enabled: isOutbox, refetchInterval: isOutbox ? POLL_MS : false });
  const clear = useClearViewerOutbox();
  const update = useUpdateViewerSettings();
  const messages = outbox.data ?? [];

  async function switchToOutbox() {
    try {
      await update.mutateAsync({ email: { mode: "outbox" } });
      toast.success("Email delivery switched to the test outbox.");
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  return (
    <Panel
      icon={<Inbox />}
      title="Test outbox"
      description="Sign-in, reset and verification mails captured by the server — nothing is sent."
      action={
        isOutbox && (
          <Button type="button" size="sm" variant="ghost" onClick={() => clear.mutate()} disabled={messages.length === 0 || clear.isPending}>
            <Eraser />Clear
          </Button>
        )
      }
    >
      {!settings.data ? null : !isOutbox ? (
        <div className="space-y-2">
          <Hint>
            Email mode is <span className="font-medium">{settings.data.email?.mode ?? "disabled"}</span>. Switch it to “Test outbox” in
            Settings to capture codes here instead of sending real mail.
          </Hint>
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="outline" onClick={switchToOutbox} disabled={update.isPending}>
              {update.isPending ? <Loader2 className="animate-spin" /> : <Inbox />}
              Use test outbox
            </Button>
            {onOpenSettings && (
              <Button type="button" size="sm" variant="ghost" onClick={onOpenSettings}>Open settings</Button>
            )}
          </div>
        </div>
      ) : outbox.isError ? (
        <ErrorPanel message={errorMessage(outbox.error)} />
      ) : messages.length === 0 ? (
        <p className="rounded-lg border border-dashed px-4 py-6 text-center text-xs text-muted-foreground">
          {outbox.isLoading ? "Loading…" : `No mail yet. Checking every ${POLL_MS / 1_000} s.`}
        </p>
      ) : (
        <ol className="-mx-1 max-h-[26rem] space-y-1.5 overflow-y-auto px-1" aria-label="Captured mails">
          {messages.map((message) => <OutboxMessage key={message.id} message={message} />)}
        </ol>
      )}
    </Panel>
  );
}

function OutboxMessage({ message }: { message: ViewerOutboxMessageResponse }) {
  const codes = extractCodes(message.text);
  return (
    <li className="space-y-2 rounded-md border bg-background/60 p-2.5 dark:bg-zinc-900/40">
      <div className="flex flex-wrap items-start gap-x-2 gap-y-1">
        <p className="min-w-0 flex-1 basis-40 text-sm font-medium">{message.subject}</p>
        {message.kind && <ToneBadge tone="muted" className="font-mono text-[10px]">{message.kind}</ToneBadge>}
      </div>
      <p className="truncate text-xs text-muted-foreground">
        to {message.to} · {timeAgo(message.createdAt)}
      </p>
      {codes.length > 0 && (
        <ul className="flex flex-wrap gap-2" aria-label="Codes in this mail">
          {codes.map((code) => (
            <li key={code} className="flex items-center gap-1.5 rounded-md border border-cyan-500/40 bg-cyan-500/10 py-0.5 pl-2 pr-0.5">
              <code className="font-mono text-sm font-semibold tracking-wider text-cyan-900 dark:text-cyan-100">{code}</code>
              <CopyButton text={code} label={`Copy code ${code}`} />
            </li>
          ))}
        </ul>
      )}
      <details className="group">
        <summary className="flex cursor-pointer list-none items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
          <ChevronRight className="size-3 transition-transform group-open:rotate-90" aria-hidden />
          Full text
        </summary>
        <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-muted/50 p-2 font-mono text-[11px] leading-4 dark:bg-black/30">
          {message.text}
        </pre>
      </details>
    </li>
  );
}
