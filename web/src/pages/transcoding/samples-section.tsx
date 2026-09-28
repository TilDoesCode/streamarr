import { Clapperboard, Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { errorMessage } from "@/api/client";
import { useGenerateTranscodingSample, useTranscodingSamples } from "@/api/queries";
import type { TranscodingSampleResponse } from "@/api/types";
import { Button } from "@/components/ui/button";
import { sampleStateMeta } from "@/lib/transcoding";
import { formatBytes, formatSeconds } from "@/lib/utils";
import { ErrorPanel, LoadingBlock, ProgressBar, SectionHeading, ToneBadge } from "./shared";

export function SampleLibrary() {
  const samples = useTranscodingSamples();
  const generate = useGenerateTranscodingSample();

  async function start(sample: TranscodingSampleResponse) {
    try {
      await generate.mutateAsync(sample.id ?? "");
      toast.success(`Generating ${sample.title}.`);
    } catch (error) {
      toast.error(errorMessage(error));
    }
  }

  return (
    <section aria-labelledby="samples-heading" className="space-y-3">
      <SectionHeading
        id="samples-heading"
        icon={<Clapperboard />}
        title="Test samples"
        detail="Synthetic clips generated with ffmpeg on first use and cached in the samples folder — no media ships with Streamarr. Benchmarks generate missing samples automatically."
      />
      {samples.isLoading ? (
        <LoadingBlock label="Loading test samples" />
      ) : samples.isError ? (
        <ErrorPanel message={errorMessage(samples.error)} />
      ) : (
        <ul className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
          {(samples.data ?? []).map((sample) => (
            <SampleCard
              key={sample.id}
              sample={sample}
              pending={generate.isPending && generate.variables === sample.id}
              onGenerate={() => start(sample)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function SampleCard({
  sample,
  pending,
  onGenerate,
}: {
  sample: TranscodingSampleResponse;
  pending: boolean;
  onGenerate: () => void;
}) {
  const state = sampleStateMeta(sample.state);
  const headingId = `sample-${sample.id}`;
  const canGenerate = sample.state === "missing" || sample.state === "failed";

  return (
    <li className="flex min-w-0 flex-col rounded-xl border bg-card p-4" aria-labelledby={headingId}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h4 id={headingId} className="text-sm font-semibold leading-snug">{sample.title}</h4>
          <p className="font-mono text-[10px] text-muted-foreground">{sample.id}</p>
        </div>
        <ToneBadge tone={state.tone}>{state.label}</ToneBadge>
      </div>
      <p className="mt-2 text-xs leading-5 text-muted-foreground">{sample.description}</p>
      <dl className="mt-3 space-y-1 text-xs">
        <div className="grid grid-cols-[3.5rem_minmax(0,1fr)] gap-2">
          <dt className="text-muted-foreground">Video</dt>
          <dd>{sample.video}</dd>
        </div>
        <div className="grid grid-cols-[3.5rem_minmax(0,1fr)] gap-2">
          <dt className="text-muted-foreground">Audio</dt>
          <dd>{sample.audio}</dd>
        </div>
        <div className="grid grid-cols-[3.5rem_minmax(0,1fr)] gap-2">
          <dt className="text-muted-foreground">Length</dt>
          <dd>{formatSeconds(sample.durationSeconds)}{sample.sizeBytes ? ` · ${formatBytes(sample.sizeBytes)}` : ""}</dd>
        </div>
      </dl>
      <div className="mt-auto pt-3">
        {sample.state === "generating" && (
          <div className="space-y-1">
            <ProgressBar value={sample.progress} label={`Generating ${sample.title}`} />
            <p className="font-mono text-[10px] text-muted-foreground">{Math.round(sample.progress * 100)}% encoded</p>
          </div>
        )}
        {sample.error && (sample.state === "failed" || sample.state === "unsupported") && (
          <p className="whitespace-pre-wrap break-words text-xs text-destructive">{sample.error}</p>
        )}
        {canGenerate && (
          <Button type="button" size="sm" variant="outline" className="mt-2" onClick={onGenerate} disabled={pending} aria-label={`Generate ${sample.title}`}>
            {pending ? <Loader2 className="animate-spin" /> : <Sparkles />}
            {sample.state === "failed" ? "Retry generation" : "Generate"}
          </Button>
        )}
      </div>
    </li>
  );
}
