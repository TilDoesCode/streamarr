/** HTTP status of a failed direct-play source; the engines ask the server when the player names none. */

/** A HEAD that does not answer by then counts as no answer; the media error goes on regardless. */
export const PROBE_TIMEOUT_MS = 5_000;
/** Statuses that tell what happened to a plain media URL; any other answer says nothing (D09). */
const TELLING_STATUS = new Set([0, 404, 410, 416, 500, 502, 503, 504]);

/** HTTP status of a direct-play URL (HEAD, which only that route answers); undefined when it says nothing. */
export async function probeStatus(uri: string): Promise<number | undefined> {
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      abort.abort();
      reject(new Error('probe_timeout'));
    }, PROBE_TIMEOUT_MS);
  });
  try {
    const { status } = await Promise.race([
      fetch(uri, { method: 'HEAD', signal: abort.signal }),
      timeout,
    ]);
    return TELLING_STATUS.has(status) ? status : undefined;
  } catch {
    return 0;
  } finally {
    clearTimeout(timer);
  }
}
