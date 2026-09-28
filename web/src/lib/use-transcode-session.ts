import { useCallback, useEffect, useRef, useState } from "react";
import { stopTranscodePlayback, useCreateTranscodeSession } from "@/api/queries";
import type { TranscodeSessionCreateRequest, TranscodeSessionCreatedResponse } from "@/api/types";

/**
 * Owns one player's transcode session: starting a new one stops the previous, and unmounting,
 * `stop()` or closing the tab ends it through its playlist capability.
 */
export function useTranscodeSession() {
  const { mutateAsync } = useCreateTranscodeSession();
  const [session, setSession] = useState<TranscodeSessionCreatedResponse | null>(null);
  const [startedAt, setStartedAt] = useState<number | undefined>(undefined);
  const [error, setError] = useState<unknown>(null);
  const [starting, setStarting] = useState(false);
  const active = useRef<string | null>(null);
  const generation = useRef(0);
  const mounted = useRef(true);

  const release = useCallback(() => {
    const playlistUrl = active.current;
    active.current = null;
    if (playlistUrl) void stopTranscodePlayback(playlistUrl);
  }, []);

  const stop = useCallback(() => {
    generation.current++;
    release();
    setSession(null);
    setStarting(false);
  }, [release]);

  const start = useCallback(async (body: TranscodeSessionCreateRequest) => {
    const id = ++generation.current;
    const requestedAt = performance.now();
    release();
    setSession(null);
    setError(null);
    setStarting(true);
    try {
      const created = await mutateAsync(body);
      if (id !== generation.current || !mounted.current) {
        if (created.playlistUrl) void stopTranscodePlayback(created.playlistUrl);
        return null;
      }
      active.current = created.playlistUrl;
      setStartedAt(requestedAt);
      setSession(created);
      return created;
    } catch (reason) {
      if (id === generation.current && mounted.current) setError(reason);
      return null;
    } finally {
      if (id === generation.current && mounted.current) setStarting(false);
    }
  }, [mutateAsync, release]);

  useEffect(() => {
    mounted.current = true;
    window.addEventListener("pagehide", release);
    return () => {
      mounted.current = false;
      window.removeEventListener("pagehide", release);
      release();
    };
  }, [release]);

  return { session, startedAt, error, starting, start, stop };
}
