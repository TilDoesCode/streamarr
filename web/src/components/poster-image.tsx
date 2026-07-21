import { useCallback, useEffect, useRef, useState } from "react";
import { ImageOff } from "lucide-react";
import { cn } from "@/lib/utils";

const MAX_RETRIES = 3;
const BASE_RETRY_DELAY_MS = 400;

type PosterImageProps = {
  src: string | null | undefined;
  alt: string;
  className?: string;
  /** Class names applied to the placeholder shown when there is no art or retries are exhausted. */
  fallbackClassName?: string;
};

/**
 * Renders a poster/cover image that transparently retries transient load failures before
 * giving up. A single dropped request to the image CDN would otherwise leave one card with a
 * broken image while its neighbours render fine, so on `error` we re-request with an
 * exponential, jittered backoff and a cache-busting query param (to bypass a cached negative
 * response) up to {@link MAX_RETRIES} times, then fall back to the {@link ImageOff} placeholder.
 */
export function PosterImage({
  src,
  alt,
  className,
  fallbackClassName,
}: PosterImageProps) {
  const attemptsRef = useRef(0);
  const timerRef = useRef<number | null>(null);
  // Bumping this remounts the <img> and re-issues the request; 0 = pristine first load.
  const [reloadKey, setReloadKey] = useState(0);
  const [failed, setFailed] = useState(false);

  // Reset retry state whenever the source changes so a new poster starts fresh.
  useEffect(() => {
    attemptsRef.current = 0;
    setReloadKey(0);
    setFailed(false);
  }, [src]);

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  const onError = useCallback(() => {
    if (attemptsRef.current >= MAX_RETRIES) {
      setFailed(true);
      return;
    }
    const current = attemptsRef.current;
    attemptsRef.current = current + 1;
    const backoff = BASE_RETRY_DELAY_MS * 2 ** current;
    const jitter = backoff * 0.25 * Math.random();
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      setReloadKey(attemptsRef.current);
    }, backoff + jitter);
  }, []);

  if (!src || failed) {
    return (
      <div
        className={cn(
          "flex h-full min-h-56 items-center justify-center text-muted-foreground",
          fallbackClassName,
        )}
      >
        <ImageOff className="size-7" />
      </div>
    );
  }

  // Append a cache-busting param only on retries so the first (usually cached) load is untouched.
  const resolvedSrc = reloadKey === 0 ? src : withRetryParam(src, reloadKey);

  return (
    <img
      key={reloadKey}
      src={resolvedSrc}
      alt={alt}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={onError}
      className={className}
    />
  );
}

function withRetryParam(src: string, attempt: number): string {
  try {
    const url = new URL(src, window.location.origin);
    url.searchParams.set("_r", String(attempt));
    return url.toString();
  } catch {
    // Malformed URL: fall back to a naive suffix that still busts the cache.
    const separator = src.includes("?") ? "&" : "?";
    return `${src}${separator}_r=${attempt}`;
  }
}
