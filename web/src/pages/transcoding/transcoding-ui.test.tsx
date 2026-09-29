import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { setSession } from "@/api/token";
import { renderWithProviders } from "@/test/render";
import { installFetchRoutes } from "@/test/fetch-routes";
import {
  benchmark,
  capabilities,
  config,
  liveSession,
  multiGpuCapabilities,
  remuxPlan,
  samples,
  vaapiNoDevice,
  videoToolboxReady,
} from "@/test/transcoding-fixtures";
import { PlanExplanation } from "@/components/transcode-plan";
import { OverviewTab } from "./overview-tab";
import { SettingsTab } from "./settings-tab";
import { SessionsTab } from "./sessions-tab";
import { TestLabTab } from "./test-lab-tab";

function future() {
  return new Date(Date.now() + 3_600_000).toISOString();
}

beforeEach(() => setSession({ username: "admin", role: "admin", expiresAt: future() }));
afterEach(() => vi.restoreAllMocks());

describe("Transcoding overview", () => {
  it("shows the verdict, the per-backend self-tests and setup hints", async () => {
    installFetchRoutes({
      "GET /api/v1/transcoding/capabilities": () => capabilities({ accelerators: [videoToolboxReady, vaapiNoDevice] }),
      "GET /api/v1/transcoding/config": () => config(),
    });
    renderWithProviders(<OverviewTab />);

    expect(await screen.findByText(/hardware accelerated via Apple VideoToolbox/i)).toBeVisible();
    const vt = screen.getByRole("article", { name: "Apple VideoToolbox" });
    expect(within(vt).getByText("Ready")).toBeVisible();
    expect(within(vt).getByRole("list", { name: /decode support/i })).toBeVisible();
    expect(screen.getByRole("note", { name: /VA-API \(Intel \/ AMD\) setup hints/i })).toHaveTextContent("--device /dev/dri");
  });

  it("offers the recommended backend and re-runs detection", async () => {
    const user = userEvent.setup();
    const { requests } = installFetchRoutes({
      "GET /api/v1/transcoding/capabilities": () => capabilities(),
      "GET /api/v1/transcoding/config": () => config({ acceleration: "none" }),
      "PUT /api/v1/transcoding/config": (request) => config(request.body as object),
      "POST /api/v1/transcoding/capabilities/refresh": () => ({ status: 202, body: capabilities({ detecting: true }) }),
    });
    renderWithProviders(<OverviewTab />);

    await user.click(await screen.findByRole("button", { name: /use apple videotoolbox/i }));
    await waitFor(() => expect(requests.some((r) => r.method === "PUT")).toBe(true));
    expect(requests.find((r) => r.method === "PUT")?.body).toEqual({ acceleration: "videotoolbox" });

    await user.click(screen.getByRole("button", { name: /re-run hardware detection/i }));
    await waitFor(() => expect(requests.some((r) => r.path.endsWith("/capabilities/refresh"))).toBe(true));
  });

  it("explains how to install ffmpeg when it is missing", async () => {
    installFetchRoutes({
      "GET /api/v1/transcoding/capabilities": () =>
        capabilities({ ffmpegFound: false, usable: false, version: null, error: "ffmpeg could not be started from 'ffmpeg'", accelerators: [] }),
      "GET /api/v1/transcoding/config": () => config({ acceleration: "none" }),
    });
    renderWithProviders(<OverviewTab />);

    expect(await screen.findByText("ffmpeg missing")).toBeVisible();
    expect(screen.getByText(/brew install ffmpeg/)).toBeVisible();
  });
});

describe("Transcoding on a multi-GPU host", () => {
  it("lists every GPU with its encode test and switches VA-API to the render node that works", async () => {
    const user = userEvent.setup();
    const { requests } = installFetchRoutes({
      "GET /api/v1/transcoding/capabilities": () => multiGpuCapabilities(),
      "GET /api/v1/transcoding/config": () => config({ acceleration: "vaapi", vaapiDevice: "/dev/dri/renderD128" }),
      "PUT /api/v1/transcoding/config": (request) => config(request.body as object),
    });
    renderWithProviders(<OverviewTab />);

    const devices = await screen.findByRole("list", { name: "Graphics devices" });
    expect(within(devices).getByText("NVIDIA GeForce RTX 3060")).toBeVisible();
    expect(within(devices).getByText(/VA-API does not work here/)).toBeVisible();
    const hints = screen.getByRole("note", { name: /VA-API \(Intel \/ AMD\) setup hints/i });
    expect(hints).toHaveTextContent("no VA-API support");

    await user.click(within(hints).getByRole("button", { name: /use renderD129/i }));
    await waitFor(() => expect(requests.some((r) => r.method === "PUT")).toBe(true));
    expect(requests.find((r) => r.method === "PUT")?.body).toEqual({ acceleration: "vaapi", vaapiDevice: "/dev/dri/renderD129" });
  });

  it("selects a second NVIDIA GPU from the device list", async () => {
    const user = userEvent.setup();
    const { requests } = installFetchRoutes({
      "GET /api/v1/transcoding/capabilities": () => multiGpuCapabilities(),
      "GET /api/v1/transcoding/config": () => config({ acceleration: "nvenc", nvencDevice: 0 }),
      "PUT /api/v1/transcoding/config": (request) => config(request.body as object),
    });
    renderWithProviders(<OverviewTab />);

    await user.click(await screen.findByRole("button", { name: /use GPU 1 — NVIDIA T400.* for NVIDIA NVENC/i }));
    await waitFor(() => expect(requests.some((r) => r.method === "PUT")).toBe(true));
    expect(requests.find((r) => r.method === "PUT")?.body).toEqual({ acceleration: "nvenc", nvencDevice: 1 });
  });

  it("offers detected render nodes and NVIDIA GPUs in Settings", async () => {
    const user = userEvent.setup();
    const { requests } = installFetchRoutes({
      "GET /api/v1/transcoding/capabilities": () => multiGpuCapabilities(),
      "GET /api/v1/transcoding/config": () => config({ acceleration: "vaapi", vaapiDevice: "/dev/dri/renderD128" }),
      "PUT /api/v1/transcoding/config": (request) => config(request.body as object),
    });
    renderWithProviders(<SettingsTab />);

    const vaapi = await screen.findByRole("combobox", { name: "VA-API device" });
    expect(within(vaapi).getByRole("option", { name: /^✗ renderD128 .*NVIDIA driver, no VA-API$/ })).toBeInTheDocument();
    expect(within(vaapi).getByRole("option", { name: /^✓ renderD129 — Intel/ })).toBeInTheDocument();
    await user.selectOptions(vaapi, "/dev/dri/renderD129");
    expect(screen.getByText(/several GPUs/)).toBeVisible();

    await user.selectOptions(screen.getByLabelText("Acceleration"), "nvenc");
    const nvenc = await screen.findByRole("combobox", { name: "NVIDIA GPU" });
    await user.selectOptions(nvenc, "1");
    await user.click(screen.getByRole("button", { name: /save transcoding settings/i }));

    await waitFor(() => expect(requests.some((r) => r.method === "PUT")).toBe(true));
    expect(requests.find((r) => r.method === "PUT")!.body).toMatchObject({
      acceleration: "nvenc",
      vaapiDevice: "/dev/dri/renderD129",
      nvencDevice: 1,
    });
  });

  it("falls back to a manual render node when none are visible", async () => {
    installFetchRoutes({
      "GET /api/v1/transcoding/capabilities": () => capabilities({ devices: [] }),
      "GET /api/v1/transcoding/config": () => config({ acceleration: "vaapi" }),
    });
    renderWithProviders(<SettingsTab />);

    expect(await screen.findByRole("textbox", { name: "VA-API device" })).toHaveValue("/dev/dri/renderD128");
    expect(screen.getByText(/No render nodes are visible/)).toBeVisible();
  });
});

describe("Transcoding settings", () => {
  it("saves a validated partial update", async () => {
    const user = userEvent.setup();
    const { requests } = installFetchRoutes({
      "GET /api/v1/transcoding/config": () => config(),
      "GET /api/v1/transcoding/capabilities": () => capabilities(),
      "PUT /api/v1/transcoding/config": (request) => config(request.body as object),
    });
    renderWithProviders(<SettingsTab />);

    const crf = await screen.findByLabelText("CRF (quality)");
    await user.clear(crf);
    await user.type(crf, "20");
    await user.selectOptions(screen.getByLabelText("Encoder preset"), "faster");
    await user.click(screen.getByRole("button", { name: /save transcoding settings/i }));

    await waitFor(() => expect(requests.some((r) => r.method === "PUT")).toBe(true));
    const body = requests.find((r) => r.method === "PUT")!.body as Record<string, unknown>;
    expect(body).toMatchObject({ crf: 20, encoderPreset: "faster", acceleration: "videotoolbox", hardwareDecodingAuto: true });
    expect(body).not.toHaveProperty("hardwareDecodingCodecs");
  });

  it("edits the separate remux capacity", async () => {
    const user = userEvent.setup();
    const { requests } = installFetchRoutes({
      "GET /api/v1/transcoding/config": () => config(),
      "GET /api/v1/transcoding/capabilities": () => capabilities(),
      "PUT /api/v1/transcoding/config": (request) => config(request.body as object),
    });
    renderWithProviders(<SettingsTab />);

    const remuxes = await screen.findByLabelText("Concurrent remuxes");
    expect(remuxes).toHaveValue(8);
    await user.clear(remuxes);
    await user.type(remuxes, "99");
    await user.click(screen.getByRole("button", { name: /save transcoding settings/i }));
    expect(await screen.findByText(/must not exceed 64/i)).toBeVisible();

    await user.clear(remuxes);
    await user.type(remuxes, "12");
    await user.click(screen.getByRole("button", { name: /save transcoding settings/i }));
    await waitFor(() => expect(requests.some((r) => r.method === "PUT")).toBe(true));
    expect(requests.find((r) => r.method === "PUT")!.body).toMatchObject({ maxConcurrentRemuxes: 12, maxConcurrentTranscodes: 2 });
  });

  it("blocks out-of-range values before they reach the server", async () => {
    const user = userEvent.setup();
    const { requests } = installFetchRoutes({
      "GET /api/v1/transcoding/config": () => config(),
      "GET /api/v1/transcoding/capabilities": () => capabilities(),
    });
    renderWithProviders(<SettingsTab />);

    const segment = await screen.findByLabelText("Segment length");
    await user.clear(segment);
    await user.type(segment, "30");
    await user.click(screen.getByRole("button", { name: /save transcoding settings/i }));

    expect(await screen.findByText(/must not exceed 10/i)).toBeVisible();
    expect(requests.some((r) => r.method === "PUT")).toBe(false);
  });

  it("pins a manual hardware-decode codec list", async () => {
    const user = userEvent.setup();
    const { requests } = installFetchRoutes({
      "GET /api/v1/transcoding/config": () => config(),
      "GET /api/v1/transcoding/capabilities": () => capabilities(),
      "PUT /api/v1/transcoding/config": (request) => config(request.body as object),
    });
    renderWithProviders(<SettingsTab />);

    await user.click(await screen.findByRole("radio", { name: /choose codecs manually/i }));
    const list = screen.getByRole("list", { name: "Hardware-decoded codecs" });
    await user.click(within(list).getByRole("checkbox", { name: /VP9 10-bit/i }));
    await user.click(screen.getByRole("button", { name: /save transcoding settings/i }));

    await waitFor(() => expect(requests.some((r) => r.method === "PUT")).toBe(true));
    const body = requests.find((r) => r.method === "PUT")!.body as Record<string, unknown>;
    expect(body.hardwareDecodingAuto).toBe(false);
    expect(body.hardwareDecodingCodecs).toEqual(["h264", "hevc", "hevc10", "vp9"]);
  });
});

describe("Transcoding test lab", () => {
  it("lists samples, runs a benchmark and shows the graded result", async () => {
    const user = userEvent.setup();
    let runs: unknown[] = [];
    const { requests } = installFetchRoutes({
      "GET /api/v1/transcoding/samples": () => samples,
      "GET /api/v1/transcoding/capabilities": () => capabilities(),
      "GET /api/v1/transcoding/config": () => config(),
      "GET /api/v1/transcoding/benchmarks": () => runs,
      "GET /api/v1/transcoding/benchmarks/b3f1c2d4e5f6": () => benchmark(),
      "POST /api/v1/transcoding/benchmarks": () => {
        runs = [benchmark()];
        return { status: 202, body: benchmark({ state: "queued", result: undefined }) };
      },
    });
    renderWithProviders(<TestLabTab />);

    expect(await screen.findByText("4K HEVC HDR10 · E-AC-3 5.1")).toBeVisible();
    expect(screen.getByRole("progressbar", { name: /generating 4K HEVC HDR10/i })).toHaveAttribute("aria-valuenow", "42");
    expect(screen.getByRole("button", { name: /generate 1080p AV1/i })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: /run benchmark/i }));
    await waitFor(() => expect(requests.some((r) => r.method === "POST" && r.path.endsWith("/benchmarks"))).toBe(true));
    expect(requests.find((r) => r.method === "POST")!.body).toMatchObject({ sampleId: "h264-1080p-ac3" });

    const result = await screen.findByRole("article", { name: "Benchmark result" });
    expect(within(result).getByText("Excellent")).toBeVisible();
    expect(within(result).getByText(/11\.2× realtime/)).toBeVisible();
  });
});

describe("Transcoding sessions", () => {
  it("shows the live ffmpeg job and stops a session by handle", async () => {
    const user = userEvent.setup();
    const { requests } = installFetchRoutes({
      "GET /api/v1/transcoding/sessions": () => [liveSession()],
      "DELETE /api/v1/transcoding/sessions/a53f5b44829f": () => ({ status: 204 }),
    });
    renderWithProviders(<SessionsTab />);

    const list = await screen.findByRole("list", { name: "Live transcode sessions" });
    expect(within(list).getByText("Example.Movie.2021.1080p.WEB-DL.x264")).toBeVisible();
    expect(within(list).getByText("Running")).toBeVisible();
    expect(list).not.toHaveTextContent("cap-token");
    expect(within(list).getByLabelText("Startup breakdown")).toHaveTextContent("Startup 640 ms = probe 48 ms + ffmpeg start 24 ms + first segment encoded 540 ms + delivered 28 ms");

    await user.click(within(list).getByRole("button", { name: /stop/i }));
    await waitFor(() => expect(requests.some((r) => r.method === "DELETE")).toBe(true));
  });

  it("labels each session's mode and describes a remux as a keyframe-aligned stream copy", async () => {
    installFetchRoutes({
      "GET /api/v1/transcoding/sessions": () => [
        liveSession(),
        liveSession({ handle: "b61c2e7f9a01", mode: "remux", title: "Big.Buck.Bunny.2008.2160p.HDR10", segmentCount: 10, segmentLengthSeconds: 6, plan: remuxPlan() }),
      ],
    });
    renderWithProviders(<SessionsTab />);

    const list = await screen.findByRole("list", { name: "Live transcode sessions" });
    const [transcode, remux] = within(list).getAllByRole("listitem");
    expect(within(transcode).getByText("Transcode")).toBeVisible();
    expect(within(remux).getByText("Remux")).toBeVisible();
    expect(within(remux).getByText("HEVC 4K HDR10 · stream copy (remux) · audio TrueHD 5.1 → E-AC-3 5.1 · 640 kbps")).toBeVisible();
    expect(within(remux).getByText("10 keyframe-aligned segments (~6 s)")).toBeVisible();
  });

  it("explains a remux plan: reasons, copied HDR output, keyframe index and subtitle delivery", () => {
    renderWithProviders(<PlanExplanation plan={remuxPlan()} />);

    expect(screen.getByText("Output (HLS fMP4, stream copy)")).toBeVisible();
    expect(screen.getByText("HEVC level 5.0 · copied")).toBeVisible();
    expect(screen.getByText("3840×2160 · 10-bit HDR10 (PQ)")).toBeVisible();
    expect(screen.getByText("hvc1.2.4.L150.90,ec-3")).toBeVisible();
    expect(screen.getByText("10 keyframe-aligned, up to 6.005 s")).toBeVisible();
    expect(screen.getByText("Matroska Cues · 30 keyframes")).toBeVisible();
    expect(screen.getByText("Why remux")).toBeVisible();
    expect(screen.getByText(/converted to 'eac3' 6 ch/)).toBeVisible();
    expect(screen.queryByText("Hardware decode")).toBeNull();
    expect(screen.queryByText("Why direct play is not possible")).toBeNull();
    expect(screen.getByText(/#2 English \(SRT\) — WebVTT rendition/)).toBeVisible();
    expect(screen.getByText(/#4 French \(PGS\) — not delivered/)).toBeVisible();
  });

  it("explains how sessions come about when none are live", async () => {
    installFetchRoutes({ "GET /api/v1/transcoding/sessions": () => [] });
    renderWithProviders(<SessionsTab />);
    expect(await screen.findByText("No live transcodes")).toBeVisible();
  });
});
