import { useNavigate, useSearch } from "@tanstack/react-router";
import { useViewerSettings, useViewers } from "@/api/queries";
import { OpsHero, OpsMetric, OpsMetrics } from "@/components/ops-page";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { emailModeLabel } from "@/lib/viewers";
import { AccountsTab } from "./accounts-tab";
import { HarnessTab } from "./harness/harness-tab";
import { useHarnessState } from "./harness/use-harness";
import { SettingsTab } from "./settings-tab";

export const VIEWER_TABS = ["accounts", "harness", "settings"] as const;
export type ViewerTab = (typeof VIEWER_TABS)[number];

export function isViewerTab(value: unknown): value is ViewerTab {
  return typeof value === "string" && (VIEWER_TABS as readonly string[]).includes(value);
}

export function ViewersPage() {
  const { tab } = useSearch({ strict: false }) as { tab?: string };
  const navigate = useNavigate();
  const active: ViewerTab = isViewerTab(tab) ? tab : "accounts";
  const settings = useViewerSettings();
  const viewers = useViewers();
  const harness = useHarnessState();

  const list = viewers.data ?? [];
  const devices = list.reduce((sum, viewer) => sum + (viewer.activeSessions ?? 0), 0);
  const disabled = list.filter((viewer) => viewer.disabled).length;
  const signedIn = list.filter((viewer) => (viewer.activeSessions ?? 0) > 0).length;
  const mode = settings.data?.email?.mode;
  const goTo = (value: ViewerTab) => void navigate({ to: "/viewers", search: { tab: value }, replace: true });

  return (
    <div className="space-y-5">
      <OpsHero
        eyebrow="Optional module · watch accounts"
        title="Viewers"
        description="Separate accounts for the people who watch — with their own sign-in, devices, age limits and watch state. Viewers are not administrators: they use viewer apps and cannot sign in to this console."
        accent="cyan"
      >
        <OpsMetrics>
          <OpsMetric
            label="Module"
            value={settings.data ? (settings.data.enabled ? "Enabled" : "Disabled") : settings.isError ? "Unavailable" : "—"}
            detail={settings.data ? (settings.data.enabled ? `as “${settings.data.serverName}”` : "viewer API answers 404") : undefined}
          />
          <OpsMetric
            label="Viewers"
            value={viewers.data ? String(list.length) : "—"}
            detail={viewers.data ? (disabled > 0 ? `${disabled} disabled` : "all active") : undefined}
          />
          <OpsMetric
            label="Active devices"
            value={viewers.data ? String(devices) : "—"}
            detail={viewers.data ? `${signedIn} viewer${signedIn === 1 ? "" : "s"} signed in` : undefined}
          />
          <OpsMetric
            label="Email"
            value={settings.data ? emailModeLabel(mode) : "—"}
            detail={settings.data ? (settings.data.emailDeliveryReady ? "delivery ready" : mode === "smtp" ? "not configured" : "codes unavailable") : undefined}
          />
        </OpsMetrics>
      </OpsHero>

      <Tabs value={active} onValueChange={(value) => isViewerTab(value) && goTo(value)}>
        <TabsList className="h-auto max-w-full justify-start overflow-x-auto">
          <TabsTrigger value="accounts">Accounts{viewers.data ? ` (${list.length})` : ""}</TabsTrigger>
          <TabsTrigger value="harness">
            Test harness
            {harness.tokens && (
              <>
                <span className="ml-1.5 size-1.5 rounded-full bg-cyan-500" aria-hidden />
                <span className="sr-only"> (viewer signed in)</span>
              </>
            )}
          </TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
        </TabsList>
        <TabsContent value="accounts" className="mt-4">
          <AccountsTab />
        </TabsContent>
        <TabsContent value="harness" className="mt-4">
          <HarnessTab harness={harness} onOpenSettings={() => goTo("settings")} />
        </TabsContent>
        <TabsContent value="settings" className="mt-4">
          <SettingsTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
