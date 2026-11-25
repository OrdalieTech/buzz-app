import { WINDOW_PAGE_SIZE } from "../relay/window";

// The relay serves at most 200 rows a read.
export const MAX_PAGE = 200;
// Until a page has been timed, assume a slow round trip.
const FIRST_ROUND_TRIP_MS = 500;
// A retried read's backoff is not page latency.
const MAX_ROUND_TRIP_MS = 1500;
// Upward speed halves each second without faster movement, so a reader held
// at the top edge still asks for pages sized to their last pace.
const SPEED_HALF_LIFE_MS = 1000;
// Scroll events this far apart start a new movement rather than measure one.
const MAX_SAMPLE_GAP_MS = 250;
const MIN_SPEED_WINDOW_MS = 80;

/** An upward reader's pace: `speed` in px/ms, and older pages' smoothed round
 * trip from request to rendered rows. */
export type HistoryPace = {
  top: number;
  at: number;
  windowTop: number;
  windowAt: number;
  speed: number;
  roundTripMs: number;
};

export const historyPace = (): HistoryPace => ({
  top: 0,
  at: 0,
  windowTop: 0,
  windowAt: 0,
  speed: 0,
  roundTripMs: FIRST_ROUND_TRIP_MS,
});

const speedAt = (pace: HistoryPace, at: number) =>
  pace.speed * 0.5 ** (Math.max(0, at - pace.at) / SPEED_HALF_LIFE_MS);

/** Record a scroll offset at time `at` (ms). */
export function observePace(pace: HistoryPace, top: number, at: number) {
  const elapsed = at - pace.at;
  if (
    !pace.at ||
    elapsed <= 0 ||
    elapsed > MAX_SAMPLE_GAP_MS ||
    top > pace.top
  ) {
    pace.speed = speedAt(pace, at);
    pace.top = top;
    pace.at = at;
    pace.windowTop = top;
    pace.windowAt = at;
    return;
  }
  const span = at - pace.windowAt;
  const upward = (pace.windowTop - top) / Math.max(span, MIN_SPEED_WINDOW_MS);
  pace.speed = Math.max(upward, speedAt(pace, at));
  pace.top = top;
  pace.at = at;
  if (span >= MIN_SPEED_WINDOW_MS) {
    pace.windowTop = top;
    pace.windowAt = at;
  }
}

/** Record a page's round trip; one slow or fast page moves the estimate halfway. */
export function observeRoundTrip(pace: HistoryPace, ms: number) {
  pace.roundTripMs =
    (pace.roundTripMs + Math.min(Math.max(0, ms), MAX_ROUND_TRIP_MS)) / 2;
}

/** Read older history ahead of the reader. Within `distance` of the top, read
 * `rows`: enough to refill that distance plus twice what the reader scrolls
 * during one round trip. A slow reader keeps the base distance. */
export function historyAhead(
  pace: HistoryPace,
  at: number,
  top: number,
  viewport: number,
  rowPx: number,
) {
  const row = Math.max(1, rowPx);
  const reach = 2 * speedAt(pace, at) * pace.roundTripMs;
  // Never ahead of what one page can supply, which would chain reads.
  const distance = Math.max(
    3000,
    viewport * 4,
    Math.min(reach, MAX_PAGE * row),
  );
  return {
    distance,
    rows: Math.min(
      MAX_PAGE,
      Math.max(
        WINDOW_PAGE_SIZE,
        Math.ceil((distance - Math.max(0, top) + reach) / row),
      ),
    ),
  };
}
