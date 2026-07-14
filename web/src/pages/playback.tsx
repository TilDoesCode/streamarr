import { useCallback, useEffect, useRef, useState } from "react";
import { useSearch } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Gauge, Loader2, PlayCircle, Timer } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ResolveOutcome } from "@/components/resolve-outcome";
import { queryKeys, useCloseSession, useResolve } from "@/api/queries";
import type { ResolveResponse } from "@/api/types";
import { errorMessage, streamUrlForPlayback } from "@/api/client";
import { SESSION_CLEARED_EVENT } from "@/api/token";
import { formatMs } from "@/lib/utils";

export function PlaybackPage() {
  // Decoupled from the router (avoids a page↔router import cycle); the playback route
  // validates `releaseId` into the search params.
  const { releaseId: initialReleaseId } = useSearch({ strict: false }) as { releaseId?: string };
  const queryClient = useQueryClient();
  const resolve = useResolve();
  const closeSession = useCloseSession();
  const cached = initialReleaseId
    ? queryClient.getQueryData<ResolveResponse>(queryKeys.resolvedRelease(initialReleaseId)) ?? null
    : null;
  const [releaseId, setReleaseId] = useState(initialReleaseId ?? "");
  const [resolved, setResolved] = useState<ResolveResponse | null>(cached);
  const autoResolveAttempt = useRef<string | null>(cached ? initialReleaseId ?? null : null);

  // Search stores the resolve result in the shared query cache. Reusing it here preserves the
  // already-open session; direct links still resolve once, including under React StrictMode.
  useEffect(() => {
    if (!initialReleaseId) return;
    setReleaseId(initialReleaseId);
    const handedOff = queryClient.getQueryData<ResolveResponse>(
      queryKeys.resolvedRelease(initialReleaseId),
    );
    if (handedOff) {
      autoResolveAttempt.current = initialReleaseId;
      setResolved(handedOff);
    } else if (autoResolveAttempt.current !== initialReleaseId) {
      autoResolveAttempt.current = initialReleaseId;
      void doResolve(initialReleaseId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialReleaseId]);

  async function doResolve(id: string) {
    const trimmed = id.trim();
    if (!trimmed) {
      toast.error("Enter a release id to resolve.");
      return;
    }
    const previous = resolved;
    try {
      const data = await resolve.mutateAsync({ releaseId: trimmed, client: "web" });
      setResolved(data);
      if (previous?.streamUrl && previous.streamUrl !== data.streamUrl) {
        const oldToken = streamTokenFromUrl(previous.streamUrl);
        if (oldToken) void closeSession.mutateAsync(oldToken).catch(() => undefined);
      }
      if (!data.streamUrl) {
        toast.error(`Release is ${data.status ?? "not ready"} — nothing to play.`);
      }
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">Playback preview</h2>
        <p className="text-sm text-muted-foreground">
          Direct-play a resolved stream in a plain HTML5 <code>&lt;video&gt;</code> element. This is
          the <strong>architectural canary</strong> (BRIEF §3.1 rule 4): it plays with Jellyfin
          absent — proving the API is truly interface-agnostic.
        </p>
      </div>

      <Card>
        <CardContent className="pt-6">
          <form
            className="flex flex-col gap-2 sm:flex-row"
            onSubmit={(e) => {
              e.preventDefault();
              void doResolve(releaseId);
            }}
          >
            <div className="flex-1 space-y-1">
              <Label htmlFor="releaseId" className="sr-only">
                Release id
              </Label>
              <Input
                id="releaseId"
                placeholder="Release id (from the Search / Debug playground)"
                maxLength={256}
                value={releaseId}
                onChange={(e) => setReleaseId(e.target.value)}
              />
            </div>
            <Button type="submit" disabled={resolve.isPending}>
              {resolve.isPending ? <Loader2 className="size-4 animate-spin" /> : <PlayCircle className="size-4" />}
              Resolve & load
            </Button>
          </form>
        </CardContent>
      </Card>

      {resolve.isError && (
        <Card>
          <CardContent className="flex items-center gap-2 pt-6 text-sm text-destructive">
            <AlertTriangle className="size-4" />
            {errorMessage(resolve.error)}
          </CardContent>
        </Card>
      )}

      {resolved && (
        <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
          <div className="space-y-4">
            {resolved.streamUrl ? (
              <Player streamUrl={resolved.streamUrl} />
            ) : (
              <Card>
                <CardContent className="flex items-center gap-2 pt-6 text-sm text-muted-foreground">
                  <AlertTriangle className="size-4" />
                  This release resolved as <strong>{resolved.status}</strong> and has no stream URL.
                </CardContent>
              </Card>
            )}
          </div>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Resolve outcome</CardTitle>
              <CardDescription>Health check + server pre-probed media info.</CardDescription>
            </CardHeader>
            <CardContent>
              <ResolveOutcome resolve={resolved} />
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}

function Player({ streamUrl }: { streamUrl: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const loadStart = useRef<number | null>(null);
  const seekStart = useRef<number | null>(null);
  const ttffRecorded = useRef(false);
  const [ttff, setTtff] = useState<number | null>(null);
  const [seekLatency, setSeekLatency] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // A fresh stream URL means a fresh measurement.
  const src = streamUrlForPlayback(streamUrl);

  useEffect(() => {
    const stopPlayback = () => {
      const video = videoRef.current;
      if (!video) return;
      video.pause();
      video.removeAttribute("src");
      video.load();
    };
    window.addEventListener(SESSION_CLEARED_EVENT, stopPlayback);
    return () => window.removeEventListener(SESSION_CLEARED_EVENT, stopPlayback);
  }, []);

  useEffect(() => {
    loadStart.current = performance.now();
    ttffRecorded.current = false;
    setTtff(null);
    setSeekLatency(null);
    setError(null);
  }, [src]);

  const recordFirstFrame = useCallback(() => {
    if (ttffRecorded.current || loadStart.current == null) return;
    ttffRecorded.current = true;
    setTtff(performance.now() - loadStart.current);
  }, []);

  const onLoadedData = useCallback(() => {
    // Prefer a real presented-frame signal where the browser supports it.
    const v = videoRef.current;
    if (v && "requestVideoFrameCallback" in v) v.requestVideoFrameCallback(() => recordFirstFrame());
    else recordFirstFrame();
  }, [recordFirstFrame]);

  const onSeeking = useCallback(() => {
    seekStart.current = performance.now();
  }, []);

  const onSeeked = useCallback(() => {
    if (seekStart.current != null) {
      setSeekLatency(performance.now() - seekStart.current);
      seekStart.current = null;
    }
  }, []);

  const onError = useCallback(() => {
    setError("The browser could not play this stream. Check the server logs and the session health.");
  }, []);

  return (
    <Card>
      <CardContent className="space-y-4 pt-6">
        <video
          ref={videoRef}
          src={src}
          controls
          playsInline
          preload="auto"
          className="aspect-video w-full rounded-md bg-zinc-950"
          onLoadedData={onLoadedData}
          onPlaying={recordFirstFrame}
          onSeeking={onSeeking}
          onSeeked={onSeeked}
          onError={onError}
        />

        {error && (
          <p className="flex items-center gap-2 text-sm text-destructive">
            <AlertTriangle className="size-4" /> {error}
          </p>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <Metric
            icon={<Timer className="size-4" />}
            label="Time to first frame"
            value={ttff == null ? "measuring…" : formatMs(ttff)}
            hint="From loading the stream to the first decoded frame."
          />
          <Metric
            icon={<Gauge className="size-4" />}
            label="Last seek latency"
            value={seekLatency == null ? "seek to measure" : formatMs(seekLatency)}
            hint="Drag the scrubber — measured from seeking to seeked."
          />
        </div>

        <p className="text-xs text-muted-foreground">
          Direct play only — no transcode. The opaque path token grants access only to this
          playback session; administrator credentials are never placed in the media URL.
        </p>
      </CardContent>
    </Card>
  );
}

function streamTokenFromUrl(streamUrl: string): string | null {
  try {
    const url = new URL(streamUrl, "http://localhost");
    const match = url.pathname.match(/\/stream\/([^/]+)$/);
    return match ? decodeURIComponent(match[1]) : null;
  } catch {
    return null;
  }
}

function Metric({
  icon,
  label,
  value,
  hint,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <div className="rounded-md border p-3">
      <div className="flex items-center gap-2 text-xs font-medium uppercase text-muted-foreground">
        {icon}
        {label}
      </div>
      <div className="mt-1 font-mono text-lg tabular-nums">{value}</div>
      <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}
