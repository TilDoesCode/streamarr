import { useTranscodingCapabilities, useTranscodingConfig, useTranscodingSamples } from "@/api/queries";
import { BenchmarkLab } from "./benchmark-section";
import { SampleLibrary } from "./samples-section";
import { TestPlayer } from "./test-player";

export function TestLabTab() {
  const samples = useTranscodingSamples();
  const caps = useTranscodingCapabilities();
  const config = useTranscodingConfig();
  return (
    <div className="space-y-8">
      <SampleLibrary />
      <BenchmarkLab samples={samples.data ?? []} caps={caps.data} config={config.data} />
      <TestPlayer samples={samples.data ?? []} />
    </div>
  );
}
