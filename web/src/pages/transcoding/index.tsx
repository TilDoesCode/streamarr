import { useNavigate, useSearch } from "@tanstack/react-router";
import { useTranscodeSessions, useTranscodingCapabilities, useTranscodingConfig } from "@/api/queries";
import { OpsHero, OpsMetric, OpsMetrics } from "@/components/ops-page";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { accelerationShortLabel, transcodingHealth, type HealthVerdict } from "@/lib/transcoding";
import { OverviewTab } from "./overview-tab";
import { SessionsTab } from "./sessions-tab";
import { SettingsTab } from "./settings-tab";
import { TestLabTab } from "./test-lab-tab";

export const TRANSCODING_TABS = ["overview", "lab", "settings", "sessions"] as const;
export type TranscodingTab = (typeof TRANSCODING_TABS)[number];

export function isTranscodingTab(value: unknown): value is TranscodingTab {
  return typeof value === "string" && (TRANSCODING_TABS as readonly string[]).includes(value);
}

export function TranscodingPage() {
  const { tab } = useSearch({ strict: false }) as { tab?: string };
  const navigate = useNavigate();
  const active: TranscodingTab = isTranscodingTab(tab) ? tab : "overview";
  const caps = useTranscodingCapabilities();
  const config = useTranscodingConfig();
  const sessions = useTranscodeSessions();

  const verdict = caps.data ? transcodingHealth(caps.data, config.data) : null;
  const live = sessions.data ?? [];
  const running = live.filter((session) => session.job?.running).length;

  return (
    <div className="space-y-5">
      <OpsHero
        eyebrow="Server-side · ffmpeg → HLS"
        title="Transcoding"
        description="Converts streams that a player cannot decode (MKV, AC-3, HEVC, HDR, interlaced) into browser-safe HLS on this server. It is independent of Jellyfin and of direct play; nothing here changes how existing streams are served."
        accent="lime"
      >
        <OpsMetrics>
          <OpsMetric
            label="Status"
            value={verdict ? shortStatus(verdict) : caps.isError ? "Unavailable" : "—"}
            detail={config.data ? (config.data.enabled ? "enabled" : "disabled in settings") : undefined}
          />
          <OpsMetric
            label="Backend"
            value={config.data ? accelerationShortLabel(config.data.acceleration) : "—"}
            detail={caps.data?.recommended ? `recommended: ${accelerationShortLabel(caps.data.recommended)}` : undefined}
          />
          <OpsMetric
            label="ffmpeg"
            value={caps.data?.version ?? (caps.data?.detected ? "missing" : "—")}
            detail={caps.data?.platform ? `${caps.data.platform.os} · ${caps.data.platform.architecture}` : undefined}
          />
          <OpsMetric label="Live transcodes" value={String(live.length)} detail={`${running} ffmpeg running`} />
        </OpsMetrics>
      </OpsHero>

      <Tabs
        value={active}
        onValueChange={(value) => {
          if (isTranscodingTab(value)) void navigate({ to: "/transcoding", search: { tab: value }, replace: true });
        }}
      >
        <TabsList className="h-auto max-w-full justify-start overflow-x-auto">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="lab">Test lab</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
          <TabsTrigger value="sessions">
            Sessions{live.length > 0 ? ` (${live.length})` : ""}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="overview" className="mt-4">
          <OverviewTab />
        </TabsContent>
        <TabsContent value="lab" className="mt-4">
          <TestLabTab />
        </TabsContent>
        <TabsContent value="settings" className="mt-4">
          <SettingsTab />
        </TabsContent>
        <TabsContent value="sessions" className="mt-4">
          <SessionsTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function shortStatus(verdict: HealthVerdict): string {
  switch (verdict.tone) {
    case "success":
      return "Ready";
    case "info":
      return "Ready (CPU)";
    case "warning":
      return /^software only/i.test(verdict.title) ? "CPU only" : /fallback/i.test(verdict.title) ? "Fallback" : "Partial";
    case "danger":
      return "Not working";
    case "pending":
      return "Detecting…";
    default:
      return "Disabled";
  }
}
