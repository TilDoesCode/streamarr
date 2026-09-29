import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Clapperboard, Loader2, Play, Square } from "lucide-react";
import { ApiError, errorMessage } from "@/api/client";
import { HlsPlayer } from "@/components/hls-player";
import { PlanExplanation, PlanSummaryLine } from "@/components/transcode-plan";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { HEIGHT_OPTIONS } from "@/lib/transcoding";
import { useTranscodeSession } from "@/lib/use-transcode-session";
import { ErrorPanel, selectClassName } from "@/pages/transcoding/shared";

export type PlaybackMode = "direct" | "remux" | "transcode";

export function PlaybackModeSwitch({ mode, onChange }: { mode: PlaybackMode; onChange: (mode: PlaybackMode) => void }) {
  const options: { value: PlaybackMode; label: string; hint: string }[] = [
    { value: "direct", label: "Direct play", hint: "Original bytes; the browser must support the codecs." },
    { value: "remux", label: "Server remux (HLS)", hint: "Video copied into HLS; audio becomes AAC when the browser needs it." },
    { value: "transcode", label: "Server transcode (HLS)", hint: "ffmpeg converts to H.264/AAC HLS on this server." },
  ];
  return (
    <div role="radiogroup" aria-label="Playback mode" className="grid gap-2 sm:grid-cols-3">
      {options.map((option) => {
        const selected = option.value === mode;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(option.value)}
            className={
              selected
                ? "rounded-lg border border-primary bg-primary/5 px-3 py-2 text-left ring-1 ring-primary focus-visible:outline-none focus-visible:ring-2"
                : "rounded-lg border px-3 py-2 text-left hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            }
          >
            <span className="block text-sm font-medium">{option.label}</span>
            <span className="block text-xs text-muted-foreground">{option.hint}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Plays a resolved stream through the server's standalone ffmpeg → HLS path, as a full transcode or a stream copy (remux). */
export function TranscodePreview({ streamToken, mode = "transcode" }: { streamToken: string; mode?: "remux" | "transcode" }) {
  const [maxHeight, setMaxHeight] = useState(1080);
  const { session, startedAt, error, starting, start, stop } = useTranscodeSession();
  const remux = mode === "remux";
  const noun = remux ? "remux" : "transcode";

  function begin(height = maxHeight) {
    void start(remux
      ? { streamToken, mode: "remux", clientName: "web playback preview" }
      : { streamToken, maxHeight: height >= 4320 ? undefined : height, clientName: "web playback preview" });
  }

  useEffect(() => {
    begin();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streamToken]);

  const disabled = error instanceof ApiError && error.code === "transcoding_disabled";

  return (
    <Card>
      <CardContent className="space-y-4 pt-6">
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-end">
          <div className={remux ? "hidden" : "space-y-1.5"}>
            <Label htmlFor="transcode-height">Max height</Label>
            <select
              id="transcode-height"
              className={selectClassName}
              value={maxHeight}
              onChange={(event) => {
                const height = Number(event.target.value);
                setMaxHeight(height);
                begin(height);
              }}
            >
              {HEIGHT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </div>
          <Button type="button" onClick={() => begin()} disabled={starting}>
            {starting ? <Loader2 className="animate-spin" /> : <Play />}
            {session ? `Restart ${noun}` : `Start ${noun}`}
          </Button>
          <Button type="button" variant="outline" onClick={stop} disabled={!session && !starting}>
            <Square />Stop
          </Button>
        </div>

        {!!error && (
          <div className="space-y-2">
            <ErrorPanel message={errorMessage(error)} />
            {disabled && (
              <Button asChild size="sm" variant="outline">
                <Link to="/transcoding" search={{ tab: "settings" }}>
                  <Clapperboard />Open transcoding settings
                </Link>
              </Button>
            )}
          </div>
        )}

        {starting && !session && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />Probing the stream and starting ffmpeg…
          </p>
        )}

        {session && (
          <div className="space-y-4">
            <div className="space-y-1">
              <PlanSummaryLine plan={session.plan} />
              <p className="font-mono text-[11px] text-muted-foreground">
                session {session.handle} · {session.segmentCount} segments {session.mode === "remux" ? "on keyframes" : `× ${session.segmentLengthSeconds} s`}
              </p>
            </div>
            <HlsPlayer key={session.playlistUrl} src={session.playlistUrl ?? ""} label={remux ? "Remuxed preview" : "Transcoded preview"} startedAt={startedAt} />
            <details className="rounded-lg border">
              <summary className="cursor-pointer px-3 py-2 text-xs font-medium hover:bg-muted/40">Why and how the server delivers this</summary>
              <div className="border-t p-3"><PlanExplanation plan={session.plan} /></div>
            </details>
          </div>
        )}

        <p className="text-xs text-muted-foreground">
          Separate from direct play and Jellyfin: the server reads the same stream capability over loopback and serves
          HLS through its own short-lived capability. Leaving this view stops the transcode.
        </p>
      </CardContent>
    </Card>
  );
}
