import { abortError, MiB, SpeedTestBusyError, type PingInfo, type SpeedTestTransport } from "./speedtest";

const BASE = "/api/v1/diagnostics";

async function failure(res: Response): Promise<Error> {
  let code = `http_${res.status}`;
  let message = `Request failed (${res.status}).`;
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    code = body.error?.code ?? code;
    message = body.error?.message ?? message;
  } catch {
    // non-JSON body
  }
  if (res.status === 429 && code === "speedtest_busy") return new SpeedTestBusyError();
  if (res.status === 401) return new Error("Your session has expired. Sign in again to run the speed test.");
  return new Error(message);
}

let uploadPayload: Blob | null = null;

/** One random, incompressible payload reused (sliced) by every upload request. */
function payload(bytes: number): Blob {
  if (!uploadPayload || uploadPayload.size < bytes) {
    const size = Math.max(bytes, 8 * MiB);
    const data = new Uint8Array(size);
    for (let offset = 0; offset < size; offset += 65_536) {
      crypto.getRandomValues(data.subarray(offset, Math.min(size, offset + 65_536)));
    }
    uploadPayload = new Blob([data], { type: "application/octet-stream" });
  }
  return uploadPayload.slice(0, bytes, "application/octet-stream");
}

/** Same-origin transport using the admin cookie; downloads stream through `body.getReader()`. */
export const browserSpeedTestTransport: SpeedTestTransport = {
  async ping(signal) {
    const res = await fetch(`${BASE}/ping`, {
      credentials: "same-origin",
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal,
    });
    if (!res.ok) throw await failure(res);
    return (await res.json()) as PingInfo;
  },

  async download(bytes, signal, onBytes) {
    const res = await fetch(`${BASE}/speed/download?bytes=${bytes}`, {
      credentials: "same-origin",
      cache: "no-store",
      signal,
    });
    if (!res.ok) throw await failure(res);
    if (!res.body) {
      onBytes((await res.arrayBuffer()).byteLength);
      return;
    }
    const reader = res.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        onBytes(value.byteLength);
      }
    } catch (error) {
      reader.cancel().catch(() => undefined);
      throw error;
    }
  },

  upload(bytes, signal, onBytes) {
    return new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(abortError());
      const xhr = new XMLHttpRequest();
      let sent = 0;
      const onAbort = () => xhr.abort();
      const settle = () => signal.removeEventListener("abort", onAbort);
      xhr.open("POST", `${BASE}/speed/upload`);
      xhr.withCredentials = true;
      xhr.setRequestHeader("Content-Type", "application/octet-stream");
      xhr.setRequestHeader("Accept", "application/json");
      xhr.upload.onprogress = (event) => {
        if (event.loaded > sent) {
          onBytes(event.loaded - sent);
          sent = event.loaded;
        }
      };
      xhr.onload = () => {
        settle();
        if (xhr.status >= 200 && xhr.status < 300) {
          if (sent < bytes) onBytes(bytes - sent);
          return resolve();
        }
        let code = "";
        let message = `Upload failed (${xhr.status}).`;
        try {
          const body = JSON.parse(xhr.responseText) as { error?: { code?: string; message?: string } };
          code = body.error?.code ?? "";
          message = body.error?.message ?? message;
        } catch {
          // non-JSON body
        }
        if (xhr.status === 429 && code === "speedtest_busy") return reject(new SpeedTestBusyError());
        reject(new Error(message));
      };
      xhr.onerror = () => {
        settle();
        reject(new Error("The upload failed — the connection to the server was interrupted."));
      };
      xhr.onabort = () => {
        settle();
        reject(abortError());
      };
      signal.addEventListener("abort", onAbort, { once: true });
      xhr.send(payload(bytes));
    });
  },
};
