import type { ReactNode } from "react";
import { AlertTriangle, ArrowRight, Check, Copy, Cpu, Minus, Play, X } from "lucide-react";
import type { TranscodePlanResponse } from "@/api/types";
import {
  audioSummary,
  channelLabel,
  codecLabel,
  formatBitrate,
  hdrLabel,
  indexSourceLabel,
  isHdr,
  modeMeta,
  planSummary,
  toneTextClass,
} from "@/lib/transcoding";
import { cn } from "@/lib/utils";

/** ✓ / ✗ / – for a self-test or a yes/no decision, with a screen-reader word. */
export function CheckMark({ passed, className }: { passed: boolean | null | undefined; className?: string }) {
  if (passed === true) {
    return (
      <span className={cn("inline-flex text-emerald-600 dark:text-emerald-400", className)}>
        <Check className="size-4" aria-hidden />
        <span className="sr-only">passed</span>
      </span>
    );
  }
  if (passed === false) {
    return (
      <span className={cn("inline-flex text-red-600 dark:text-red-400", className)}>
        <X className="size-4" aria-hidden />
        <span className="sr-only">failed</span>
      </span>
    );
  }
  return (
    <span className={cn("inline-flex text-muted-foreground", className)}>
      <Minus className="size-4" aria-hidden />
      <span className="sr-only">not tested</span>
    </span>
  );
}

export function PlanSummaryLine({ plan, className }: { plan: TranscodePlanResponse; className?: string }) {
  const mode = (plan.mode ?? "transcode").toLowerCase();
  const Icon = mode === "remux" ? Copy : mode === "direct" ? Play : Cpu;
  return (
    <p className={cn("flex items-start gap-2 text-sm font-medium", className)}>
      <Icon className={cn("mt-0.5 size-4 shrink-0", mode === "transcode" ? "text-lime-600 dark:text-lime-400" : toneTextClass[modeMeta(mode).tone])} aria-hidden />
      <span>{planSummary(plan)}</span>
    </p>
  );
}

const RANGE_LABELS: Record<string, string> = { PQ: "HDR10 (PQ)", HLG: "HLG", SDR: "SDR" };

const DELIVERY_LABELS: Record<string, string> = { webvtt: "WebVTT rendition", embedded: "in the original file", none: "not delivered" };

/** Why the server delivers the stream this way and how: mode and reasons, source vs output, hardware decisions, subtitles, warnings. */
export function PlanExplanation({ plan }: { plan: TranscodePlanResponse }) {
  const source = plan.source;
  const target = plan.target;
  const audio = audioSummary(plan);
  const toneMap = (plan.toneMap ?? "notneeded").toLowerCase();
  const blockers = plan.directPlayBlockers ?? [];
  const warnings = plan.warnings ?? [];
  const mode = (plan.mode ?? "transcode").toLowerCase();
  const meta = modeMeta(mode);
  const copy = mode === "remux";
  const direct = mode === "direct";
  const reasons = plan.reasons ?? [];
  const subtitles = plan.subtitles ?? [];
  const renditions = plan.audioRenditions ?? [];
  const index = plan.keyframeIndex;

  return (
    <div className="space-y-4 text-sm">
      <PlanSummaryLine plan={plan} />

      <div className="grid gap-3 sm:grid-cols-[1fr_auto_1fr] sm:items-stretch">
        <MediaBox title="Source">
          <MediaLine label="Video" value={`${codecLabel(source.videoCodec)}${source.videoProfile ? ` ${source.videoProfile}` : ""}`} />
          <MediaLine label="Frame" value={`${source.width}×${source.height} · ${source.bitDepth}-bit ${hdrLabel(source.hdr)}${source.interlaced ? " · interlaced" : ""}`} />
          {source.frameRate != null && <MediaLine label="Rate" value={`${source.frameRate} fps`} />}
          {source.bitrateKbps != null && <MediaLine label="Bitrate" value={formatBitrate(source.bitrateKbps)} />}
          {source.container && <MediaLine label="Container" value={source.container.toUpperCase()} />}
          {(source.audio ?? []).length > 0 && (
            <MediaLine
              label="Audio"
              value={(source.audio ?? [])
                .map((track) => `#${track.index} ${codecLabel(track.codec)} ${channelLabel(track.channels)}${track.language ? ` (${track.language})` : ""}`)
                .join(", ")}
            />
          )}
        </MediaBox>
        <div className="flex items-center justify-center text-muted-foreground" aria-hidden>
          <ArrowRight className="size-4 rotate-90 sm:rotate-0" />
        </div>
        <MediaBox title={copy ? "Output (HLS fMP4, stream copy)" : direct ? "Output (original file)" : "Output (HLS fMP4)"}>
          {copy || direct ? (
            <>
              <MediaLine label="Video" value={`${codecLabel(target.videoCodec)}${target.level ? ` level ${target.level}` : ""} · ${copy ? "copied" : "original"}`} />
              <MediaLine label="Frame" value={`${target.width}×${target.height} · ${source.bitDepth}-bit ${RANGE_LABELS[target.videoRange ?? "SDR"] ?? target.videoRange}`} />
            </>
          ) : (
            <>
              <MediaLine label="Video" value={`${codecLabel(target.videoCodec)} level ${target.level ?? "—"}`} />
              <MediaLine label="Frame" value={`${target.width}×${target.height} · 8-bit ${isHdr(source.hdr) && (toneMap === "hardware" || toneMap === "software") ? "SDR (tone-mapped)" : isHdr(source.hdr) ? hdrLabel(source.hdr) : "SDR"}`} />
            </>
          )}
          <MediaLine label="Rate" value={`${target.frameRate} fps`} />
          <MediaLine label="Bitrate" value={formatBitrate(target.videoBitrateKbps)} />
          {audio && <MediaLine label="Audio" value={audio} />}
          {target.codecs && <MediaLine label="CODECS" value={target.codecs} mono />}
          {index && <MediaLine label="Segments" value={`${index.segments} keyframe-aligned, up to ${index.maxSegmentSeconds} s`} />}
        </MediaBox>
      </div>

      <dl className="grid gap-2 rounded-lg border bg-muted/20 p-3 text-xs sm:grid-cols-2 dark:bg-zinc-900/40">
        <Decision label="Mode" value={meta.label} reason={meta.hint} />
        {copy ? (
          <>
            <Decision
              label="Keyframe index"
              value={index ? `${indexSourceLabel(index.source)} · ${index.keyframes} keyframes` : "—"}
              reason={index ? `built in ${index.buildMs} ms` : undefined}
            />
            <Decision label="Encoder" value="None — video and copied audio are not re-encoded" />
          </>
        ) : direct ? (
          <Decision label="Encoder" value="None — the player reads the original file" />
        ) : (
          <>
            <Decision label="Hardware decode" passed={plan.hardwareDecode} reason={plan.hardwareDecodeReason} />
            <Decision label="Hardware encode" passed={plan.hardwareEncode} reason={plan.hardwareEncodeReason} />
            <Decision label="Encoder" value={plan.encoder ?? "—"} reason={plan.accelerationLabel ?? undefined} />
            <Decision
              label="Tone mapping"
              value={{ notneeded: "Not needed (SDR source)", hardware: "On the GPU", software: "On the CPU (zscale)", disabled: "Disabled in settings", unavailable: "Unavailable" }[toneMap] ?? toneMap}
              passed={toneMap === "notneeded" ? null : toneMap === "hardware" || toneMap === "software"}
            />
            <Decision label="Deinterlace" value={plan.deinterlace ? "Yes" : "No"} />
          </>
        )}
        <Decision label="Direct play" value={plan.directPlayPossible ? "Possible — the client could play the source as-is" : `Not possible (${blockers.length} ${blockers.length === 1 ? "blocker" : "blockers"})`} />
        {!copy && !direct && (
          <Decision label="Remux (stream copy)" passed={plan.remuxPossible} value={plan.remuxPossible ? "Possible" : "Not possible — the video must be re-encoded"} />
        )}
        {plan.videoFilters && (
          <div className="sm:col-span-2">
            <dt className="font-medium text-muted-foreground">Video filters</dt>
            <dd className="mt-0.5 break-all font-mono text-[11px]">{plan.videoFilters}</dd>
          </div>
        )}
      </dl>

      {reasons.length > 0 && (
        <div>
          <p className="text-xs font-medium text-muted-foreground">Why {meta.label.toLowerCase()}</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs">
            {reasons.map((reason) => <li key={`${reason.code}-${reason.message}`}>{reason.message}</li>)}
          </ul>
        </div>
      )}

      {!copy && blockers.length > 0 && (
        <div>
          <p className="text-xs font-medium text-muted-foreground">Why direct play is not possible</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs">
            {blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}
          </ul>
        </div>
      )}

      {subtitles.length > 0 && (
        <div>
          <p className="text-xs font-medium text-muted-foreground">Subtitles</p>
          <ul className="mt-1 space-y-0.5 text-xs">
            {subtitles.map((track) => (
              <li key={track.index} className="flex items-start gap-1.5">
                <CheckMark passed={track.deliveredAs !== "none"} className="mt-px [&_svg]:size-3.5" />
                <span>
                  #{track.index} {track.name} ({codecLabel(track.codec)}) — {DELIVERY_LABELS[track.deliveredAs ?? "none"] ?? track.deliveredAs}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {renditions.length > 0 && (
        <div>
          <p className="text-xs font-medium text-muted-foreground">Audio renditions (HLS audio group)</p>
          <ul className="mt-1 space-y-0.5 text-xs">
            {renditions.map((rendition) => (
              <li key={rendition.id} className="flex items-start gap-1.5">
                <CheckMark passed={rendition.default ? true : null} className="mt-px [&_svg]:size-3.5" />
                <span>
                  #{rendition.streamIndex} {rendition.name} — {rendition.copy ? "copied" : "converted"}
                  {rendition.default ? " · default" : ""}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {warnings.length > 0 && (
        <ul className="space-y-1 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-900 dark:text-amber-200">
          {warnings.map((warning) => (
            <li key={warning} className="flex gap-2">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              {warning}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function MediaBox({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="min-w-0 rounded-lg border bg-background/60 p-3 dark:bg-zinc-900/40">
      <p className="mb-2 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">{title}</p>
      <dl className="space-y-1 text-xs">{children}</dl>
    </div>
  );
}

function MediaLine({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn("break-words", mono && "font-mono text-[11px]")}>{value}</dd>
    </div>
  );
}

function Decision({ label, value, passed, reason }: { label: string; value?: string; passed?: boolean | null; reason?: string | null }) {
  return (
    <div className="min-w-0">
      <dt className="font-medium text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 flex items-start gap-1.5">
        {passed !== undefined && <CheckMark passed={passed} className="mt-px [&_svg]:size-3.5" />}
        <span className="min-w-0">
          {value ?? (passed ? "Yes" : "No")}
          {reason && <span className="block text-muted-foreground">{reason}</span>}
        </span>
      </dd>
    </div>
  );
}
