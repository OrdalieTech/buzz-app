import { describe, expect, it } from "vitest";
import {
  historyAhead,
  historyPace,
  observePace,
  observeRoundTrip,
} from "./history-prefetch";

// An upward scroll of `px` over `ms`, sampled at its start and end.
function scrolled(px: number, ms: number, at = 1000) {
  const pace = historyPace();
  observePace(pace, 20_000, at);
  observePace(pace, 20_000 - px, at + ms);
  return pace;
}

describe("history prefetch", () => {
  it("refills the base distance for a reader who is not scrolling up", () => {
    const pace = historyPace();
    observePace(pace, 1000, 1000);
    observePace(pace, 1400, 1100);
    // 4 × 900px viewport, 2600px of it missing above a reader at 1000px.
    expect(historyAhead(pace, 1100, 1000, 900, 40)).toEqual({
      distance: 3600,
      rows: 65,
    });
    // A reader past the distance with its rows above needs only the base page.
    expect(historyAhead(pace, 1100, 3600, 900, 40).rows).toBe(20);
  });

  it("covers twice the distance scrolled during a smoothed round trip", () => {
    // 5000px/s upward.
    const pace = scrolled(500, 100);
    observeRoundTrip(pace, 300);
    expect(pace.roundTripMs).toBe(400);
    // 2 × 5px/ms × 400ms = 4000px ahead, plus 4000px of reach.
    expect(historyAhead(pace, 1100, 4000, 900, 40)).toEqual({
      distance: 4000,
      rows: 100,
    });
  });

  it("decays the pace while a reader waits at the top edge without scrolling", () => {
    const pace = scrolled(1000, 100);
    expect(historyAhead(pace, 1100, 3600, 900, 40).rows).toBe(200);
    // Two seconds later, with no scroll event between, the pace is a quarter.
    expect(historyAhead(pace, 3100, 3600, 900, 40).rows).toBe(63);
  });

  it("measures no speed across a gap between scroll events", () => {
    // A jump of 10,000px between samples a second apart is not movement.
    expect(historyAhead(scrolled(10_000, 1000), 2000, 3600, 900, 40).rows).toBe(
      20,
    );
  });

  it("bounds a round trip that waited out retries", () => {
    const pace = historyPace();
    observeRoundTrip(pace, 7000);
    expect(pace.roundTripMs).toBe(1000);
  });

  it("stays within one capped page", () => {
    const pace = scrolled(50_000, 16);
    // The distance is what one 200-row page of 20px rows supplies.
    expect(historyAhead(pace, 1016, 0, 900, 20)).toEqual({
      distance: 4000,
      rows: 200,
    });
  });

  it("ignores bunched scroll events after a gap during steady upward scrolling", () => {
    const pace = historyPace();
    let top = 7345;
    let at = 2000;
    observePace(pace, top, at);
    for (const [elapsed, delta] of [
      [16, 26],
      [16, 26],
      [38, 25],
      [5, 28],
      [7, 41],
      [16, 26],
      [38, 28],
      [4, 28],
      [7, 39],
      [16, 26],
    ] as const) {
      at += elapsed;
      top -= delta;
      observePace(pace, top, at);
    }
    expect(historyAhead(pace, at, top, 740, 404).distance).toBe(3000);
  });
});
