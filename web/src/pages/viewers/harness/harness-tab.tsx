import { useCallback, useState } from "react";
import { FlaskConical } from "lucide-react";
import { ModuleDisabledCallout } from "../shared";
import { AccountSecurity } from "./account-security";
import { ApiLogPanel } from "./api-log";
import { OutboxPanel } from "./outbox-panel";
import { PlayerSimulator, type PlayerLoad } from "./player-simulator";
import { ForcedPasswordChange, SessionPanel } from "./session-panel";
import { SignInPanel } from "./sign-in-panel";
import { HarnessContext, useViewerProfile, type Harness } from "./use-harness";
import { WatchLists } from "./watch-lists";

/** A simulated viewer app: its own in-memory bearer tokens, never the admin cookie, every call logged. */
export function HarnessTab({ harness, onOpenSettings }: { harness: Harness; onOpenSettings?: () => void }) {
  return (
    <HarnessContext.Provider value={harness}>
      <div className="space-y-4">
        <ModuleDisabledCallout />
        <p className="flex items-start gap-2 px-1 text-xs leading-5 text-muted-foreground">
          <FlaskConical className="mt-0.5 size-3.5 shrink-0 text-cyan-600 dark:text-cyan-400" aria-hidden />
          <span>
            Behaves like a real viewer app: it holds its own viewer tokens in memory only (gone when you leave this page), never sends the
            admin cookie, and records every call in the API log.
          </span>
        </p>
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,26rem)] 2xl:grid-cols-[minmax(0,1fr)_minmax(0,32rem)]">
          <div className="min-w-0 space-y-4">{harness.tokens ? <SignedIn key={harness.tokens.sessionId} /> : <SignInPanel />}</div>
          <aside className="min-w-0 space-y-4 xl:sticky xl:top-20 xl:self-start" aria-label="Harness diagnostics">
            <ApiLogPanel />
            <OutboxPanel onOpenSettings={onOpenSettings} />
          </aside>
        </div>
      </div>
    </HarnessContext.Provider>
  );
}

function SignedIn() {
  const profile = useViewerProfile();
  const [load, setLoad] = useState<PlayerLoad | null>(null);
  const loadIntoPlayer = useCallback((next: Omit<PlayerLoad, "nonce">) => setLoad({ ...next, nonce: Date.now() }), []);
  const mustChange = profile.data?.mustChangePassword === true;

  return (
    <>
      <SessionPanel />
      {profile.data &&
        (mustChange ? (
          <ForcedPasswordChange />
        ) : (
          <>
            <PlayerSimulator load={load} />
            <WatchLists onLoad={loadIntoPlayer} />
            <AccountSecurity />
          </>
        ))}
    </>
  );
}
