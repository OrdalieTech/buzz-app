import { test, expect, repeats, timeline } from "./runner.mjs";
import { scrollCadence } from "./cadence.mjs";

const count = 640;
// Each variant changes one condition of scroll-paging-fast or -delayed.
for (const [name, olderPageDelayMs, modality, options] of [
  ["scroll-paging-fast", 100, "pointer", {}],
  ["scroll-paging-delayed", 500, "pointer", {}],
  ["scroll-paging-delayed-short", 500, "pointer", { shortMessages: true }],
  ["scroll-paging-fast-keyboard", 100, "keyboard", {}],
  ["scroll-paging-fast-markdown", 100, "pointer", { markdownMessages: true }],
  ["scroll-paging-fast-first-seen", 100, "pointer", { firstSeenHistory: true }],
])
  test.describe(name, () => {
    test.use({
      historyCounts: { alpha: count, beta: 1 },
      olderPageDelayMs,
      ...options,
    });
    for (let i = 1; i <= repeats; i++)
      test(`${name} sample ${i}`, async ({ page, app, perf }) => {
        await perf.setup("alpha");
        const scroller = page.locator(timeline("alpha"));
        const oldestId = app.histories.get("primary/alpha")[0].id;
        const point = await perf.gutter("alpha", modality);
        await perf.settle("alpha");
        // Input starts as soon as the opening settles, with any read-ahead
        // still in flight: a reader scrolling back at once.
        const olderReadsBefore = app.pending.length;
        const head = app.report.queries.find(
          ({ filter }) =>
            filter.top_level &&
            filter["#h"]?.includes("alpha") &&
            filter.until === undefined,
        ).filter;
        const expectedOlderIds = app.histories
          .get("primary/alpha")
          .slice(0, -head.limit)
          .map(({ id }) => id);
        // Served events are in the app's proof memo; first-seen ones verify.
        // The visit's own older pages, read ahead, verify as they arrive.
        const paged = new Set(
          app.pending.flatMap(({ events }) => events.map(({ id }) => id)),
        );
        const olderRowsServedBefore = expectedOlderIds.filter(
          (id) => app.served.has(id) && !paged.has(id),
        ).length;
        if (options.firstSeenHistory)
          expect(olderRowsServedBefore, "older history is first-seen").toBe(0);
        let gestures = 0;
        let reachedOldest = false;
        const sample = await perf.measure("alpha", {
          timeoutMs: 60_000,
          work: {
            modality,
            olderRowsServedBefore,
            historyCount: count,
            requestedPxPerGesture: 2500,
            speedPxPerSecond: 25000,
            olderResponseDelayMs: olderPageDelayMs,
          },
          act: async () => {
            // No page/idle waits between gestures: arrivals must compete with
            // scrolling and the virtualizer's pending position corrections.
            // Finish a fixed amount of history, not a fixed time that rewards stalls.
            while (!reachedOldest && gestures < 200) {
              await perf.cdp.send("Input.synthesizeScrollGesture", {
                ...point,
                xDistance: 0,
                yDistance: 2500,
                speed: 25000,
                gestureSourceType: "mouse",
                preventFling: true,
              });
              gestures++;
              reachedOldest = await scroller.evaluate((element, id) => {
                const row = element.querySelector(`[data-message-id="${id}"]`);
                if (!row) return false;
                const box = row.getBoundingClientRect();
                const viewport = element.getBoundingClientRect();
                return box.bottom > viewport.top && box.top < viewport.bottom;
              }, oldestId);
            }
          },
        });
        Object.assign(sample.metrics, scrollCadence(sample.recording));
        // Time the reader spent held at the top edge, waiting for history.
        const { frames, gestureStartMs, gestureEndMs } = sample.recording;
        sample.metrics.edgeWaitMs = frames
          .slice(1)
          .reduce(
            (sum, { t }, i) =>
              frames[i].top <= 1 &&
              frames[i].t >= gestureStartMs &&
              t <= gestureEndMs
                ? sum + t - frames[i].t
                : sum,
            0,
          );
        const received = new Set(
          app.pending
            .filter(({ releaseDelayMs }) => releaseDelayMs !== undefined)
            .flatMap(({ events }) => events.map(({ id }) => id)),
        );
        Object.assign(sample.work, {
          gestures,
          wheels: sample.recording.wheels,
          olderReadsBefore,
          olderReadsDuring: app.pending.length - olderReadsBefore,
          olderReleaseDelaysMs: app.pending.map(
            ({ releaseDelayMs }) => releaseDelayMs,
          ),
          olderRowsReceived: received.size,
          reachedOldest,
          oldestId,
        });
        await perf.save(sample);
        expect(reachedOldest, "input reaches the oldest message").toBe(true);
        expect([...received], "no middle history range was skipped").toEqual(
          expect.arrayContaining(expectedOlderIds),
        );
        expect(sample.work.wheels, "real wheel input").toBeGreaterThan(0);
        expect(app.pending.length, "history arrives in pages").toBeGreaterThan(
          1,
        );
        expect(
          sample.recording.frames.at(-1).rows.map(([id]) => id),
          "oldest message remains visible after settling",
        ).toContain(oldestId);
        await expect(
          scroller.getByText("History window limit reached", { exact: true }),
        ).toHaveCount(0);
      });
  });
