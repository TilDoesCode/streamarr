import { useId, useState } from "react";
import type { GpuDeviceResponse } from "@/api/types";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { deviceCheck, deviceOptionLabel } from "@/lib/transcoding";
import { selectClassName } from "./shared";

const CUSTOM = "__custom__";

/** Render-node picker for VA-API/QSV: detected nodes with vendor, driver and self-test result, or a manual path. */
export function VaapiDeviceField({
  value,
  onChange,
  onBlur,
  devices,
  backend,
  error,
}: {
  value: string;
  onChange: (value: string) => void;
  onBlur: () => void;
  devices: GpuDeviceResponse[];
  backend: string;
  error?: string;
}) {
  const id = useId();
  const nodes = devices.filter((device) => device.kind === "drm");
  const known = nodes.some((node) => node.id === value);
  const [manual, setManual] = useState(false);
  const custom = manual || nodes.length === 0 || !known;
  const selected = nodes.find((node) => node.id === value);
  const check = selected ? deviceCheck(selected, backend) : undefined;
  const hintId = `${id}-hint`;

  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{backend === "qsv" ? "QSV device (render node)" : "VA-API device"}</Label>
      {nodes.length > 0 && (
        <select
          id={custom ? undefined : id}
          aria-label={custom ? "Detected render nodes" : undefined}
          className={selectClassName}
          value={custom ? CUSTOM : value}
          aria-describedby={hintId}
          onBlur={onBlur}
          onChange={(event) => {
            if (event.target.value === CUSTOM) {
              setManual(true);
              return;
            }
            setManual(false);
            onChange(event.target.value);
          }}
        >
          {nodes.map((node) => (
            <option key={node.id} value={node.id ?? ""}>{deviceOptionLabel(node, backend)}</option>
          ))}
          <option value={CUSTOM}>Other path…</option>
        </select>
      )}
      {custom && (
        <Input
          id={id}
          className="font-mono"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onBlur={onBlur}
          aria-invalid={!!error}
          aria-describedby={hintId}
          autoComplete="off"
          spellCheck={false}
          placeholder="/dev/dri/renderD128"
        />
      )}
      <p id={hintId} className={error ? "text-xs text-destructive" : "text-xs leading-5 text-muted-foreground"}>
        {error
          ?? (nodes.length === 0
            ? "No render nodes are visible to the server. Pass /dev/dri into the container, then re-run detection."
            : check?.passed === false
              ? `This node failed the encode test: ${check.detail ?? "see Overview"}`
              : nodes.length > 1
                ? "This host has several GPUs. Each node shows its vendor, driver, PCI slot and encode self-test."
                : "The render node used by VA-API and QSV.")}
      </p>
    </div>
  );
}

/** NVIDIA GPU picker in nvidia-smi numbering; falls back to an index field when the GPUs cannot be listed. */
export function NvencDeviceField({
  value,
  onChange,
  onBlur,
  devices,
  error,
}: {
  value: number;
  onChange: (value: number) => void;
  onBlur: () => void;
  devices: GpuDeviceResponse[];
  error?: string;
}) {
  const id = useId();
  const gpus = devices.filter((device) => device.kind === "cuda");
  const selected = gpus.find((gpu) => gpu.index === value);
  const check = selected ? deviceCheck(selected, "nvenc") : undefined;
  const hintId = `${id}-hint`;

  return (
    <div className="space-y-2">
      <Label htmlFor={id}>NVIDIA GPU</Label>
      {gpus.length > 0 ? (
        <select
          id={id}
          className={selectClassName}
          value={String(value)}
          onChange={(event) => onChange(Number(event.target.value))}
          onBlur={onBlur}
          aria-describedby={hintId}
        >
          {!selected && <option value={String(value)}>GPU {value} — not detected</option>}
          {gpus.map((gpu) => (
            <option key={gpu.id} value={String(gpu.index ?? 0)}>{deviceOptionLabel(gpu, "nvenc")}</option>
          ))}
        </select>
      ) : (
        <Input
          id={id}
          type="number"
          inputMode="numeric"
          min={0}
          max={15}
          value={Number.isFinite(value) ? value : 0}
          onChange={(event) => onChange(event.target.valueAsNumber)}
          onBlur={onBlur}
          aria-invalid={!!error}
          aria-describedby={hintId}
        />
      )}
      <p id={hintId} className={error ? "text-xs text-destructive" : "text-xs leading-5 text-muted-foreground"}>
        {error
          ?? (gpus.length === 0
            ? "The server cannot list NVIDIA GPUs (no nvidia-smi). Enter the index nvidia-smi shows on the host."
            : check?.passed === false
              ? `This GPU failed the encode test: ${check.detail ?? "see Overview"}`
              : "Numbered like nvidia-smi (PCI bus order). With several GPUs, pick the one that should transcode.")}
      </p>
    </div>
  );
}
