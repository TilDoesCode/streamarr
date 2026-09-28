import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type Hls from "hls.js";
import type { ErrorData } from "hls.js";
import { AlertTriangle, Cpu, Film, Gauge, Layers, MonitorPlay, RotateCcw, Timer } from "lucide-react";
import { SESSION_CLEARED_EVENT } from "@/api/token";
import { Button } from "@/components/ui/button";
import { formatMs } from "@/lib/utils";

export type HlsEngine = "hls.js" | "native";

export interface HlsPlayerStats {
  engine: HlsEngine | null;
  ttffMs: number | null;
  seekLatencyMs: number | null;
  bufferedAheadSeconds: number;
  droppedFrames: number | null;
  totalFrames: number | null;
  width: number;
  height: number;
  levelBitrate: number | null;
  bandwidthEstimate: number | null;
  currentTime: number;
  duration: number;
  waiting: boolean;
}

const EMPTY_STATS: HlsPlayerStats = {
  engine: null,
  ttffMs: null,
  seekLatencyMs: null,
  bufferedAheadSeconds: 0,
  droppedFrames: null,
  totalFrames: null,
  width: 0,
  height: 0,
  levelBitrate: null,
  bandwidthEstimate: null,
  currentTime: 0,
  duration: 0,
  waiting: false,
};

const FRAGMENT_LOAD_POLICY = {
  default: {
    // The server holds a segment request open until ffmpeg produces it (seeks restart ffmpeg).
    maxTimeToFirstByteMs: 60_000,
    maxLoadTimeMs: 120_000,
    timeoutRetry: { maxNumRetry: 2, retryDelayMs: 0, maxRetryDelayMs: 0 },
    errorRetry: { maxNumRetry: 6, retryDelayMs: 1_000, maxRetryDelayMs: 8_000 },
  },
};

/**
 * Safari (and other Apple WebKit) plays HLS natively. Recent Chromium also answers "maybe" to
 * the HLS MIME type, but hls.js over MSE exposes far better diagnostics there.
 */
export function prefersNativeHls(video: HTMLVideoElement, mseSupported: boolean): boolean {
  const native = video.canPlayType("application/vnd.apple.mpegurl") !== "";
  if (!native) return false;
  if (!mseSupported) return true;
  return typeof navigator !== "undefined" && /Apple/i.test(navigator.vendor ?? "");
}

function bufferedAhead(video: HTMLVideoElement): number {
  const t = video.currentTime;
  for (let i = 0; i < video.buffered.length; i++) {
    if (video.buffered.start(i) <= t + 0.1 && video.buffered.end(i) >= t) return Math.max(0, video.buffered.end(i) - t);
  }
  return 0;
}

function describeHlsError(data: ErrorData): string {
  const status = data.response?.code;
  if (status === 404 || status === 410) return "The transcode session has ended or expired. Start a new one.";
  if (status && status >= 500) return `The transcoder could not deliver media (HTTP ${status}, ${data.details}). Check the session's ffmpeg log.`;
  return `Playback failed: ${data.details}${data.error?.message ? ` — ${data.error.message}` : ""}.`;
}

/**
 * HTML5 player for the server's HLS transcode output. hls.js runs without a worker because the
 * server CSP does not allow blob: workers; Safari uses its native HLS stack.
 */
export function HlsPlayer({
  src,
  label = "Transcoded stream",
  autoPlay = true,
  startedAt,
  footer,
}: {
  src: string;
  label?: string;
  autoPlay?: boolean;
  /** performance.now() of the user action that started this stream, so TTFF includes creating the session. */
  startedAt?: number;
  footer?: ReactNode;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const loadStart = useRef(0);
  const seekStart = useRef<number | null>(null);
  const ttffRecorded = useRef(false);
  const [stats, setStats] = useState<HlsPlayerStats>(EMPTY_STATS);
  const [error, setError] = useState<string | null>(null);
  const [canRetry, setCanRetry] = useState(false);

  const patch = useCallback((next: Partial<HlsPlayerStats>) => setStats((current) => ({ ...current, ...next })), []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    let cancelled = false;
    let hls: Hls | null = null;
    let mediaRecoveries = 0;
    loadStart.current = startedAt ?? performance.now();
    ttffRecorded.current = false;
    seekStart.current = null;
    setStats(EMPTY_STATS);
    setError(null);
    setCanRetry(false);

    const play = () => {
      if (!autoPlay) return;
      const attempt = video.play() as Promise<void> | undefined;
      attempt?.catch((reason: unknown) => {
        // Without a recent user gesture browsers only autoplay muted media.
        if (reason instanceof DOMException && reason.name === "NotAllowedError" && !video.muted) {
          video.muted = true;
          (video.play() as Promise<void> | undefined)?.catch(() => undefined);
        }
      });
    };

    const useNative = (mseSupported: boolean) => {
      if (!prefersNativeHls(video, mseSupported)) return false;
      video.src = src;
      patch({ engine: "native" });
      play();
      return true;
    };

    const hasMse = typeof window !== "undefined" && ("MediaSource" in window || "ManagedMediaSource" in window);
    if (!useNative(hasMse)) {
      void import("hls.js/light")
        .then(({ default: HlsClass }) => {
          if (cancelled) return;
          if (!HlsClass.isSupported()) {
            if (!useNative(false)) setError("This browser supports neither Media Source Extensions nor native HLS playback.");
            return;
          }
          const instance = new HlsClass({ enableWorker: false, fragLoadPolicy: FRAGMENT_LOAD_POLICY });
          hls = instance;
          hlsRef.current = instance;
          instance.on(HlsClass.Events.MANIFEST_PARSED, play);
          instance.on(HlsClass.Events.ERROR, (_event, data) => {
            if (!data.fatal) return;
            if (data.type === HlsClass.ErrorTypes.MEDIA_ERROR && mediaRecoveries < 2) {
              mediaRecoveries++;
              instance.recoverMediaError();
              return;
            }
            setError(describeHlsError(data));
            setCanRetry(data.type === HlsClass.ErrorTypes.NETWORK_ERROR && data.response?.code !== 404 && data.response?.code !== 410);
          });
          instance.loadSource(src);
          instance.attachMedia(video);
          patch({ engine: "hls.js" });
        })
        .catch(() => {
          if (!cancelled) setError("The HLS player could not be loaded.");
        });
    }

    return () => {
      cancelled = true;
      hls?.destroy();
      hlsRef.current = null;
      try {
        video.pause();
        video.removeAttribute("src");
        video.load();
      } catch {
        // jsdom and detached elements may not implement media loading.
      }
    };
  }, [autoPlay, patch, src, startedAt]);

  // Signing out stops media immediately, like the direct-play preview.
  useEffect(() => {
    const stop = () => {
      hlsRef.current?.destroy();
      hlsRef.current = null;
      videoRef.current?.pause();
    };
    window.addEventListener(SESSION_CLEARED_EVENT, stop);
    return () => window.removeEventListener(SESSION_CLEARED_EVENT, stop);
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const video = videoRef.current;
      if (!video) return;
      const quality = typeof video.getVideoPlaybackQuality === "function" ? video.getVideoPlaybackQuality() : null;
      const hls = hlsRef.current;
      const level = hls && hls.currentLevel >= 0 ? hls.levels[hls.currentLevel] : undefined;
      patch({
        bufferedAheadSeconds: bufferedAhead(video),
        droppedFrames: quality ? quality.droppedVideoFrames : null,
        totalFrames: quality ? quality.totalVideoFrames : null,
        width: video.videoWidth,
        height: video.videoHeight,
        levelBitrate: level?.bitrate ?? null,
        bandwidthEstimate: hls && Number.isFinite(hls.bandwidthEstimate) ? hls.bandwidthEstimate : null,
        currentTime: video.currentTime,
        duration: Number.isFinite(video.duration) ? video.duration : 0,
      });
    }, 500);
    return () => window.clearInterval(timer);
  }, [patch]);

  const recordFirstFrame = useCallback(() => {
    if (ttffRecorded.current) return;
    ttffRecorded.current = true;
    patch({ ttffMs: performance.now() - loadStart.current });
  }, [patch]);

  const onLoadedData = useCallback(() => {
    const video = videoRef.current;
    if (video && "requestVideoFrameCallback" in video) video.requestVideoFrameCallback(() => recordFirstFrame());
    else recordFirstFrame();
  }, [recordFirstFrame]);

  const retry = useCallback(() => {
    setError(null);
    setCanRetry(false);
    hlsRef.current?.startLoad();
  }, []);

  const resolution = stats.width > 0 ? `${stats.width}×${stats.height}` : "—";
  const dropped = stats.droppedFrames == null
    ? "n/a"
    : `${stats.droppedFrames}${stats.totalFrames ? ` / ${stats.totalFrames}` : ""}`;

  return (
    <div className="space-y-3">
      <video
        ref={videoRef}
        aria-label={label}
        controls
        playsInline
        preload="auto"
        className="aspect-video w-full rounded-lg bg-zinc-950"
        onLoadedData={onLoadedData}
        onPlaying={() => {
          recordFirstFrame();
          patch({ waiting: false });
        }}
        onWaiting={() => patch({ waiting: true })}
        onSeeking={() => {
          seekStart.current = performance.now();
        }}
        onSeeked={() => {
          if (seekStart.current != null) {
            patch({ seekLatencyMs: performance.now() - seekStart.current });
            seekStart.current = null;
          }
        }}
        onError={() => {
          if (stats.engine === "native") setError("The browser could not play this HLS stream.");
        }}
      />

      {error && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive" role="alert">
          <AlertTriangle className="size-4 shrink-0" />
          <span className="min-w-0 flex-1">{error}</span>
          {canRetry && (
            <Button type="button" size="sm" variant="outline" onClick={retry}>
              <RotateCcw />Retry
            </Button>
          )}
        </div>
      )}

      <div className="grid grid-cols-2 gap-2 lg:grid-cols-3" aria-label="Player statistics" role="group">
        <PlayerStat
          icon={<Timer />}
          label="Time to first frame"
          value={stats.ttffMs == null ? "measuring…" : formatMs(stats.ttffMs)}
          detail={startedAt != null ? "incl. starting ffmpeg" : undefined}
        />
        <PlayerStat
          icon={<Layers />}
          label="Buffered ahead"
          value={`${stats.bufferedAheadSeconds.toFixed(1)} s`}
          detail={stats.waiting ? "buffering…" : undefined}
        />
        <PlayerStat
          icon={<Film />}
          label="Resolution"
          value={resolution}
          detail={stats.levelBitrate ? `level ${(stats.levelBitrate / 1_000_000).toFixed(1)} Mbps` : undefined}
        />
        <PlayerStat icon={<MonitorPlay />} label="Dropped frames" value={dropped} />
        <PlayerStat icon={<Gauge />} label="Last seek latency" value={stats.seekLatencyMs == null ? "seek to measure" : formatMs(stats.seekLatencyMs)} />
        <PlayerStat
          icon={<Cpu />}
          label="Engine"
          value={stats.engine ?? "loading…"}
          detail={stats.bandwidthEstimate ? `~${(stats.bandwidthEstimate / 1_000_000).toFixed(1)} Mbps throughput` : undefined}
        />
      </div>
      {footer}
    </div>
  );
}

function PlayerStat({ icon, label, value, detail }: { icon: ReactNode; label: string; value: string; detail?: string }) {
  return (
    <div className="min-w-0 rounded-md border bg-background/60 px-3 py-2 dark:bg-zinc-900/40">
      <div className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground [&_svg]:size-3">
        {icon}
        <span className="truncate">{label}</span>
      </div>
      <p className="mt-0.5 truncate font-mono text-sm tabular-nums" title={value}>{value}</p>
      {detail && <p className="truncate text-[10px] text-muted-foreground">{detail}</p>}
    </div>
  );
}
