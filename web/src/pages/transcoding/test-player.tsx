import { useState } from "react";
import { Loader2, MonitorPlay, Play, Square } from "lucide-react";
import { errorMessage } from "@/api/client";
import type { TranscodingSampleResponse } from "@/api/types";
import { HlsPlayer } from "@/components/hls-player";
import { PlanExplanation, PlanSummaryLine } from "@/components/transcode-plan";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { HEIGHT_OPTIONS } from "@/lib/transcoding";
import { useTranscodeSession } from "@/lib/use-transcode-session";
import { ErrorPanel, SectionHeading, selectClassName } from "./shared";

export function TestPlayer({ samples }: { samples: TranscodingSampleResponse[] }) {
  const ready = samples.filter((sample) => sample.state === "ready");
  const [sampleId, setSampleId] = useState("");
  const [maxHeight, setMaxHeight] = useState(720);
  const { session, startedAt, error, starting, start, stop } = useTranscodeSession();
  const chosen = ready.some((sample) => sample.id === sampleId) ? sampleId : ready[0]?.id ?? "";

  function play() {
    if (!chosen) return;
    void start({
      sampleId: chosen,
      maxHeight: maxHeight >= 4320 ? undefined : maxHeight,
      clientName: "web test player",
    });
  }

  return (
    <section aria-labelledby="test-player-heading" className="space-y-3">
      <SectionHeading
        id="test-player-heading"
        icon={<MonitorPlay />}
        title="Test player"
        detail="Starts a real transcode session for a sample and plays it through hls.js (native HLS on Safari) — the same path a client takes. The session stops when you leave or press Stop."
      />
      <div className="space-y-4 rounded-xl border bg-card p-4">
        <div className="grid gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_auto_auto] sm:items-end">
          <div className="space-y-1.5">
            <Label htmlFor="player-sample">Ready sample</Label>
            <select id="player-sample" className={selectClassName} value={chosen} onChange={(event) => setSampleId(event.target.value)} disabled={ready.length === 0}>
              {ready.length === 0 && <option value="">Generate a sample first</option>}
              {ready.map((sample) => <option key={sample.id} value={sample.id ?? ""}>{sample.title}</option>)}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="player-height">Max height</Label>
            <select id="player-height" className={selectClassName} value={maxHeight} onChange={(event) => setMaxHeight(Number(event.target.value))}>
              {HEIGHT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </div>
          <Button type="button" onClick={play} disabled={!chosen || starting}>
            {starting ? <Loader2 className="animate-spin" /> : <Play />}
            {session ? "Restart transcode" : "Start transcode"}
          </Button>
          <Button type="button" variant="outline" onClick={stop} disabled={!session && !starting}>
            <Square />Stop
          </Button>
        </div>

        {!!error && <ErrorPanel message={errorMessage(error)} />}

        {session ? (
          <div className="space-y-4">
            <div className="space-y-1">
              <PlanSummaryLine plan={session.plan} />
              <p className="font-mono text-[11px] text-muted-foreground">
                session {session.handle} · {session.segmentCount} segments × {session.segmentLengthSeconds} s
              </p>
            </div>
            <HlsPlayer key={session.playlistUrl} src={session.playlistUrl ?? ""} label="Transcoding test player" startedAt={startedAt} />
            <details className="rounded-lg border">
              <summary className="cursor-pointer px-3 py-2 text-xs font-medium hover:bg-muted/40">Why and how this is transcoded</summary>
              <div className="border-t p-3"><PlanExplanation plan={session.plan} /></div>
            </details>
          </div>
        ) : (
          <p className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
            {ready.length === 0
              ? "Generate a sample above, then start a transcode to watch it here."
              : "Pick a sample and start a transcode. Time to first frame, buffer and seek latency are measured live."}
          </p>
        )}
      </div>
    </section>
  );
}
