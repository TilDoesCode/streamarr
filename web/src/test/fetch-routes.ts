import { vi } from "vitest";

export interface RecordedRequest {
  method: string;
  path: string;
  body: unknown;
}

type Handler = (request: RecordedRequest) => { status: number; body?: unknown } | unknown;

/** Route-table fetch stub: keys are "METHOD /path" (query stripped); plain return values mean 200. */
export function installFetchRoutes(routes: Record<string, Handler>) {
  const requests: RecordedRequest[] = [];
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const method = (init?.method ?? "GET").toUpperCase();
    const raw = typeof init?.body === "string" ? init.body : null;
    const request: RecordedRequest = { method, path: url.pathname, body: raw ? JSON.parse(raw) : null };
    requests.push(request);
    const handler = routes[`${method} ${url.pathname}`];
    if (!handler) return respond(404, { error: { code: "not_found", message: `No stub for ${method} ${url.pathname}` } });
    const result = handler(request);
    if (result && typeof result === "object" && "status" in result && typeof (result as { status: unknown }).status === "number") {
      const { status, body } = result as { status: number; body?: unknown };
      return respond(status, body);
    }
    return respond(200, result);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, requests };
}

function respond(status: number, body: unknown): Promise<Response> {
  const text = body === undefined ? "" : JSON.stringify(body);
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    headers: new Headers({ "content-type": "application/json" }),
    text: () => Promise.resolve(text),
    json: () => Promise.resolve(body),
    clone: () => ({ json: () => Promise.resolve(body) }),
  } as unknown as Response);
}
