import { Terminal } from "lucide-react";
import { LogViewer } from "@/components/log-viewer";
import { SectionHeading } from "./shared";

/** The "Logs" sub screen: correlated core/Jellyfin runtime output for this stream. */
export function LogsTab({ token }: { token: string }) {
  return (
    <section aria-label="Stream logs">
      <SectionHeading
        icon={<Terminal />}
        eyebrow="Correlated runtime output"
        title="Core & Jellyfin logs"
        detail="Raw operator messages and exceptions attributed to this stream, newest first."
      />
      <div className="mt-6">
        <LogViewer streamToken={token} compact />
      </div>
    </section>
  );
}
