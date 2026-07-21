import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { PosterImage } from "./poster-image";

describe("PosterImage", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it("renders the ImageOff placeholder when there is no source", () => {
    render(<PosterImage src={null} alt="Dune poster" />);
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("loads the pristine URL on first paint without a cache-busting param", () => {
    render(<PosterImage src="https://img.example/dune.jpg" alt="Dune poster" />);
    expect(screen.getByRole("img", { name: "Dune poster" })).toHaveAttribute(
      "src",
      "https://img.example/dune.jpg",
    );
  });

  it("retries transient load failures with a cache-busting param, then falls back", () => {
    render(<PosterImage src="https://img.example/dune.jpg" alt="Dune poster" />);

    // First failure schedules a retry; advancing the backoff re-issues a cache-busted request.
    act(() => {
      fireEvent.error(screen.getByRole("img"));
    });
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(screen.getByRole("img", { name: "Dune poster" }).getAttribute("src")).toContain("_r=1");

    // Exhaust the remaining retries (MAX_RETRIES = 3 total).
    act(() => {
      fireEvent.error(screen.getByRole("img"));
      vi.advanceTimersByTime(4_000);
    });
    act(() => {
      fireEvent.error(screen.getByRole("img"));
      vi.advanceTimersByTime(8_000);
    });
    expect(screen.getByRole("img", { name: "Dune poster" }).getAttribute("src")).toContain("_r=3");

    // The next failure has no retries left, so the placeholder replaces the image.
    act(() => {
      fireEvent.error(screen.getByRole("img"));
    });
    expect(screen.queryByRole("img")).toBeNull();
  });
});
