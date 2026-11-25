import { test, expect } from "./fixture.mjs";
import { frames, open, settle, wheel } from "./timeline.mjs";
import { generateSecretKey, getPublicKey, finalizeEvent } from "nostr-tools";
import { animationsSettled } from "./animations.mjs";
import { markAllRead } from "./reading.mjs";

test.use({
  productionBroker: true,
  pluginFixtures: true,
  readState: true,
  threadUnread: true,
  historyCounts: { alpha: 2, beta: 1 },
  developmentReact: true,
});

// Browser-only: pane geometry and hit testing must follow the actual workspace
// and interface size, rather than the window's unscaled width.
test("thread stays beside the channel whenever both panes fit", async ({
  page,
  app,
}, testInfo) => {
  await open(page, app);
  await page.getByRole("separator", { name: "Resize sidebar" }).press("Home");
  // A narrow thread covers the channel, removing it from the accessibility
  // tree; its geometry still applies.
  const channel = page.getByRole("article", {
    name: "Conversation",
    exact: true,
    includeHidden: true,
  });
  const input = channel.getByRole("textbox", { name: "Message #Alpha" });
  const draft =
    "A long channel draft that must wrap before the thread pane. ".repeat(4);
  await input.fill(draft);
  const root = app.histories
    .get("primary/alpha")
    .find((row) => row.content.startsWith("Thread root"));
  await channel
    .locator(`[data-message-id="${root.id}"]`)
    .getByRole("button", { name: /^View thread:/ })
    .click();
  const thread = page.getByRole("complementary", {
    name: "Thread",
    exact: true,
  });
  await expect(thread).toBeVisible();
  const resize = page.getByRole("separator", {
    name: "Resize main and secondary panels",
  });
  await resize.focus();
  await resize.press("End");
  await thread
    .getByRole("textbox", { name: "Reply to thread", exact: true })
    .fill("A thread draft");

  for (const [width, scale, mode] of [
    [1000, 1, "light"],
    [900, 0.8, "dark"],
    [1440, 1.5, "light"],
  ]) {
    const layout = `${width}px, scale ${scale}, ${mode} mode`;
    await page.evaluate(
      ({ scale, mode }) => {
        localStorage.setItem("buzz-font-scale.v1", String(scale));
        localStorage.setItem("buzz-appearance.v1", mode);
        window.dispatchEvent(
          new StorageEvent("storage", { key: null, storageArea: localStorage }),
        );
      },
      { scale, mode },
    );
    await page.setViewportSize({ width, height: 900 });
    await expect(page.locator("html")).toHaveCSS(
      "font-size",
      `${16 * scale}px`,
    );
    await frames(page);
    await animationsSettled(page.locator(":has(> [data-panel-dock])"));
    const bounds = await channel.boundingBox();
    const pane = await thread.boundingBox();
    expect(
      bounds.x + bounds.width,
      `Channel and thread separation at ${layout}`,
    ).toBeLessThanOrEqual(pane.x);
    expect(
      pane.x + pane.width,
      `Thread right edge at ${layout}`,
    ).toBeLessThanOrEqual(width);
    await thread
      .getByRole("button", { name: "Send message", exact: true })
      .click({ trial: true });
    await expect(input).toHaveText(draft.trimEnd());
    await channel
      .getByRole("button", { name: "Send message", exact: true })
      .click({ trial: true });
    await page.screenshot({
      path: testInfo.outputPath(`thread-layout-${width}-${scale}-${mode}.png`),
    });
  }

  // At the physical navigation breakpoint the thread still fills the page,
  // even when the smaller interface would otherwise fit two columns.
  await page.evaluate(() => {
    localStorage.setItem("buzz-font-scale.v1", "0.8");
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "buzz-font-scale.v1",
        storageArea: localStorage,
      }),
    );
  });
  await page.setViewportSize({ width: 640, height: 900 });
  await expect(page.locator("html")).toHaveCSS("font-size", "12.8px");
  const narrowChannel = await channel.boundingBox();
  const narrowThread = await page.locator("[data-panel-dock]").boundingBox();
  expect(narrowThread.y).toBe(narrowChannel.y);
  expect(narrowThread.height).toBe(narrowChannel.height);
  await expect(
    page.getByRole("separator", { name: "Resize main and secondary panels" }),
  ).toBeHidden();
});

test("thread splitter tracks the conversation reserve as interface size changes", async ({
  page,
  app,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, app);
  await page.getByRole("separator", { name: "Resize sidebar" }).press("Home");
  const conversation = page.getByRole("article", {
    name: "Conversation",
    exact: true,
  });
  const root = app.histories
    .get("primary/alpha")
    .find((row) => row.content.startsWith("Thread root"));
  await conversation
    .locator(`[data-message-id="${root.id}"]`)
    .getByRole("button", { name: /^View thread:/ })
    .click();
  const resize = page.getByRole("separator", {
    name: "Resize main and secondary panels",
  });
  await expect(resize).toBeVisible();
  const surface = page.getByRole("region", { name: "Channels", exact: true });
  await surface.evaluate((element) => {
    element.style.inlineSize = `${element.clientWidth}px`;
  });
  const board = page.locator(":has(> [data-panel-dock])");
  const measure = async (step) => {
    await frames(page);
    await animationsSettled(board);
    await frames(page);
    const geometry = await resize.evaluate((handle) => {
      const dock = handle.parentElement;
      const workspace = dock.parentElement;
      const { x, right, width } = dock.getBoundingClientRect();
      return {
        available: workspace.clientWidth,
        min: Number(handle.getAttribute("aria-valuemin")),
        max: Number(handle.getAttribute("aria-valuemax")),
        now: Number(handle.getAttribute("aria-valuenow")),
        pane: { x, right, width },
        main: workspace
          .querySelector('[aria-label="Conversation"]')
          .getBoundingClientRect().width,
      };
    });
    console.log(`Thread splitter ${step}: ${JSON.stringify(geometry)}`);
    return geometry;
  };

  await expect(page.locator("html")).toHaveCSS("font-size", "16px");
  await resize.press("ArrowLeft");
  const normal = await measure("100% submax");
  expect(normal.max).toBe(normal.available - 320);
  expect(normal.now).toBeLessThan(normal.max);

  await page.evaluate(() => {
    document.documentElement.style.setProperty("--buzz-text-scale", "1.5");
  });
  await expect(page.locator("html")).toHaveCSS("font-size", "24px");
  const scaled = await measure("150% submax (root change only)");
  expect.soft(scaled.available).toBe(normal.available);
  expect.soft(scaled.now).toBe(normal.now);
  expect.soft(scaled.max).toBe(scaled.available - 480);

  await surface.evaluate((element) => {
    element.style.removeProperty("inline-size");
  });
  await measure("150% unpinned submax");
  await resize.press("End");
  const end = await measure("150% End");
  expect.soft(end.now).toBe(Math.round(end.pane.width));
  expect.soft(end.max).toBe(end.now);
  expect.soft(end.pane.right).toBeLessThanOrEqual(1440);
  expect.soft(end.main).toBeCloseTo(480);

  await resize.press("Home");
  await measure("150% Home");

  const thread = page.getByRole("complementary", {
    name: "Thread",
    exact: true,
  });
  await thread
    .getByRole("textbox", { name: "Reply to thread", exact: true })
    .fill("A thread draft");
  for (const [viewport, scale] of [
    [808, 0.8],
    [872, 0.9],
    [808, 12.825 / 16],
  ]) {
    await page.evaluate((scale) => {
      document.documentElement.style.setProperty("--buzz-text-scale", scale);
    }, String(scale));
    await page.setViewportSize({ width: viewport, height: 900 });
    await expect(page.locator("html")).toHaveCSS(
      "font-size",
      `${16 * scale}px`,
    );
    const sidebar = page.getByRole("separator", { name: "Resize sidebar" });
    await sidebar.press("Home");
    await expect(sidebar).toHaveAttribute(
      "aria-valuenow",
      await sidebar.getAttribute("aria-valuemin"),
    );
    await expect(resize).toBeVisible();
    await resize.press("End");
    const narrow = await measure(`${scale * 100}% ${viewport}px End`);
    if (scale === 12.825 / 16) {
      const precision = await board.evaluate((workspace) => {
        const container = workspace.closest('[aria-label="Channels"]');
        const insets = (element) => {
          const style = getComputedStyle(element);
          return [
            style.paddingLeft,
            style.paddingRight,
            style.borderLeftWidth,
            style.borderRightWidth,
          ].map(Number.parseFloat);
        };
        const probe = document.createElement("div");
        probe.style.cssText = "position:absolute;width:100cqw;height:0";
        workspace.append(probe);
        const cqw = probe.getBoundingClientRect().width;
        probe.remove();
        return {
          fontSize: getComputedStyle(document.documentElement).fontSize,
          queryContainer: getComputedStyle(container).containerType,
          containerWidth: container.getBoundingClientRect().width,
          containerInsets: insets(container),
          boardWidth: workspace.getBoundingClientRect().width,
          boardInsets: insets(workspace),
          clientWidth: workspace.clientWidth,
          cqw,
        };
      });
      console.log(`Thread fractional workspace: ${JSON.stringify(precision)}`);
      expect(precision.fontSize).toBe("12.825px");
      expect(precision.queryContainer).toBe("inline-size");
      expect(precision.containerInsets).toEqual([0, 0, 0, 0]);
      expect(precision.boardInsets).toEqual([0, 0, 0, 0]);
      expect(precision.containerWidth).toBe(539.546875);
      expect(precision.boardWidth).toBe(precision.cqw);
      expect(precision.boardWidth).toBe(precision.containerWidth);
      expect(precision.clientWidth).toBe(540);
    }
    expect.soft(narrow.min).toBeLessThanOrEqual(narrow.now);
    expect.soft(narrow.now).toBe(narrow.max);
    expect.soft(narrow.max).toBe(Math.round(narrow.pane.width));
    expect.soft(narrow.pane.right).toBeLessThanOrEqual(viewport);
    await thread
      .getByRole("button", { name: "Send message", exact: true })
      .click({ trial: true });
    await expect(resize).toBeVisible();
  }
});

// Browser-only: child-only activity layout and composer resizing must preserve
// bottom/reading intent, including intermediate rendering opportunities.
test("thread preserves bottom and reading position through activity and composer resizing", async ({
  page,
  app,
}, testInfo) => {
  const key = generateSecretKey();
  await page.route("**/agent-library", (route) =>
    route.fulfill({
      json: {
        definitions: [],
        identities: [{ pubkey: getPublicKey(key), name: "Diagnostic Agent" }],
      },
    }),
  );
  const root = app.histories
    .get("primary/alpha")
    .find((row) => row.content.startsWith("Thread root"));
  for (let i = 0; i < 30; i++) app.reply(root.id, false, false);
  await open(page, app);
  await markAllRead(page);
  await expect.poll(() => app.relay.hasRoute("primary", "observer")).toBe(true);
  app.serveProfile(key, { name: "Diagnostic Agent", is_agent: true });
  const rootRow = page.locator(
    `[data-channel-timeline] [data-message-id="${root.id}"]`,
  );
  await rootRow.hover();
  await rootRow.getByRole("button", { name: /^View thread:/ }).click();
  const thread = page.getByRole("complementary", {
    name: "Thread",
    exact: true,
  });
  const history = thread.getByRole("region", { name: "Thread messages" });
  const input = thread.getByRole("textbox", {
    name: "Reply to thread",
    exact: true,
  });
  const gap = () =>
    history.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop);
  // The thread corrects each resize in its ResizeObserver, which runs only in
  // a rendering update. Those can be sparse (Linux WebKit under load), so
  // geometry can rest with a correction still pending; render before settling.
  const settled = async () => {
    await frames(page);
    await settle(page, history);
  };
  // Activity grows in and leaves over several rendering updates. Leaving hides
  // its region at once, but it stays mounted until its animation ends; its
  // removal is the last resize.
  const arrived = (row) =>
    animationsSettled(row.locator("[data-message-activity]"));
  const left = (row) =>
    expect(row.locator("[data-message-activity]")).toHaveCount(0);
  await expect(history.locator("[data-message-id]")).toHaveCount(33);
  await expect.poll(gap).toBeLessThan(4);
  await settled();

  // Observe layout delivery after the app's observer, before paint. Sampling
  // in a task can instead catch a newer DOM mutation awaiting its next layout.
  const sampling = await history.evaluateHandle((el) => {
    const samples = [];
    const observer = new ResizeObserver(() => {
      samples.push(el.scrollHeight - el.clientHeight - el.scrollTop);
    });
    observer.observe(el);
    observer.observe(el.querySelector("[data-thread-rows]"));
    return {
      samples,
      stop() {
        observer.disconnect();
      },
    };
  });
  const start = (id, turnId) =>
    app.observer(
      {
        kind: "turn_started",
        seq: 1,
        timestamp: new Date().toISOString(),
        channelId: "alpha",
        sessionId: "resize",
        turnId,
        payload: { triggeringEventIds: [id] },
      },
      key,
    );
  const stop = (turnId) =>
    app.observer(
      {
        kind: "turn_completed",
        seq: 2,
        timestamp: new Date().toISOString(),
        channelId: "alpha",
        sessionId: "resize",
        turnId,
        payload: {},
      },
      key,
    );
  try {
    await input.fill("Short send");
    await input.press("Enter");
    await expect(input).toHaveText("");
    await expect(
      history.getByText("Short send", { exact: true }),
    ).toBeVisible();
    await settled();
    await input.fill(
      `Multiline send\n${"Another line of the draft\n".repeat(8)}`,
    );
    await settled();
    expect(await gap()).toBeLessThan(4);
    await input.press("Enter");
    await expect(input).toHaveText("");
    const sent = history
      .locator("[data-message-id]")
      .filter({ hasText: "Multiline send" })
      .last();
    await expect(sent).toBeVisible();
    const id = await sent.getAttribute("data-message-id");
    start(id, "bottom");
    await expect(
      sent.getByRole("region", { name: "Agent activity on this message" }),
    ).toBeVisible();
    await arrived(sent);
    await settled();
    expect(await gap()).toBeLessThan(4);
    stop("bottom");
    await left(sent);
    await settled();
    expect(await gap()).toBeLessThan(4);
    const samples = await sampling.evaluate((state) => {
      state.stop();
      return state.samples;
    });
    await testInfo.attach("bottom-frame-gaps", {
      body: JSON.stringify(samples),
      contentType: "application/json",
    });
    expect(samples.length).toBeGreaterThan(0);
    expect(Math.max(...samples), "no intermediate bottom cutoff").toBeLessThan(
      4,
    );
  } finally {
    await sampling.evaluate((state) => state.stop());
    await sampling.dispose();
  }

  // Hovering reveals a top-layer message toolbar that consumes wheel input
  // without scrolling the thread. It can span a short received bubble and the
  // avatar gutter, so aim at the empty trailing side of these received rows.
  const probe = await history.evaluate((element) => ({
    x: element.clientWidth - 48,
    y: 80,
  }));
  await history.hover({ position: probe });
  expect(
    await history.evaluate((element, probe) => {
      const bounds = element.getBoundingClientRect();
      const hit = document.elementFromPoint(
        bounds.left + probe.x,
        bounds.top + probe.y,
      );
      return !!hit && element.contains(hit) && !hit.closest("[popover]");
    }, probe),
  ).toBe(true);
  await wheel(page, -350, history);
  expect(await gap()).toBeGreaterThan(200);
  const anchor = await history.evaluate((el) => {
    const top = el.getBoundingClientRect().top;
    const row = [...el.querySelectorAll("[data-message-id]")].find(
      (row) => row.getBoundingClientRect().bottom > top,
    );
    return {
      id: row.dataset.messageId,
      y: row.getBoundingClientRect().top - top,
    };
  });
  const unchanged = async () => {
    await settled();
    expect(
      await history.evaluate((el, anchor) => {
        const row = el.querySelector(`[data-message-id="${anchor.id}"]`);
        return Math.abs(
          row.getBoundingClientRect().top -
            el.getBoundingClientRect().top -
            anchor.y,
        );
      }, anchor),
    ).toBeLessThan(4);
  };
  // Activity above the reader is a child-only reflow, not a thread snapshot.
  const threadRoot = history.locator(`[data-message-id="${root.id}"]`);
  start(root.id, "reading");
  await expect(
    threadRoot.getByRole("region", { name: "Agent activity on this message" }),
  ).toHaveCount(1);
  await arrived(threadRoot);
  await unchanged();
  await input.fill("Growing draft\n".repeat(8));
  await unchanged();
  await input.fill("");
  await unchanged();
  stop("reading");
  await left(threadRoot);
  await unchanged();
});

test.describe("exact history resize ownership", () => {
  test.use({
    exactMessages: true,
    historyCounts: { alpha: 103, beta: 0 },
  });
  test("held exact target resize followed by live reply", ({ page, app }) =>
    heldResizeThenReply({ page, app }, "before reply"));
  // The shift lands in the live reply's own commit, before ResizeObserver
  // delivery. Browser scroll anchoring must not correct it ahead of the
  // thread's exact-target anchor, which would then apply it a second time.
  test("exact target shift committed with a live reply", ({ page, app }) =>
    heldResizeThenReply({ page, app }, "with reply"));
  // A reader gesture retires the exact-target anchor. The thread's ordinary
  // reading anchor must then own the same-commit shift, since native
  // anchoring is off.
  test("reading position shift committed with a live reply", ({ page, app }) =>
    heldResizeThenReply({ page, app }, "with reply after reading"));
  // Content above the reader shrinks in the reply's commit far enough that
  // the browser clamps scrollTop to the new maximum. That clamp is layout, not
  // reader intent, so the reading anchor must still own the shift.
  test("reading position contraction clamped with a live reply", ({
    page,
    app,
  }) => heldResizeThenReply({ page, app }, "contraction after reading"));

  async function heldResizeThenReply({ page, app }, shift) {
    const key = generateSecretKey();
    await page.route("**/agent-library", (route) =>
      route.fulfill({
        json: {
          definitions: [],
          identities: [{ pubkey: getPublicKey(key), name: "Review Agent" }],
        },
      }),
    );
    await open(page, app);
    await expect
      .poll(() => app.relay.hasRoute("primary", "observer"))
      .toBe(true);
    app.serveProfile(key, { name: "Review Agent", is_agent: true });
    let release, intercepted;
    const held = new Promise((r) => (release = r)),
      seen = new Promise((r) => (intercepted = r));
    let first = true;
    await page.route("**/api/relay/primary/query", async (route) => {
      if (
        !first ||
        !route
          .request()
          .postDataJSON()
          .some((f) => f.depth_limit)
      )
        return route.continue();
      first = false;
      intercepted();
      await held;
      await route.continue().catch(() => {});
    });
    const history = page.getByRole("region", {
      name: "Thread messages",
      exact: true,
    });
    const target = history.locator(
      `[data-message-id="${app.exact.target.id}"]`,
    );
    let n = 0;
    const reply = () => {
      const event = finalizeEvent(
        {
          kind: 9,
          tags: [
            ["h", "alpha"],
            ["e", app.exact.root.id, "", "reply"],
          ],
          content: `Review live reply ${n++}`,
          created_at: Math.floor(Date.now() / 1000) + n,
        },
        key,
      );
      app.relay.publish("primary", event);
      return event;
    };
    // Hold the reveal's completion frame while live replies commit, so resize
    // ownership cannot rely on a later parent render to finish initialization.
    await page.evaluate((targetId) => {
      const raf = window.requestAnimationFrame;
      const cancel = window.cancelAnimationFrame;
      const heldFrames = new Map();
      let holding = true;
      window.requestAnimationFrame = (callback) => {
        const id = raf((time) => {
          if (
            holding &&
            document.activeElement?.getAttribute("data-message-id") === targetId
          )
            heldFrames.set(id, callback);
          else callback(time);
        });
        return id;
      };
      window.cancelAnimationFrame = (id) => {
        heldFrames.delete(id);
        cancel(id);
      };
      window.releaseExactReveal = () => {
        holding = false;
        window.requestAnimationFrame = raf;
        window.cancelAnimationFrame = cancel;
        for (const callback of heldFrames.values()) raf(callback);
        heldFrames.clear();
      };
    }, app.exact.target.id);
    try {
      await page.evaluate(
        (value) => {
          void window.fixtureNavigation.open(value);
        },
        {
          version: 1,
          kind: "conversation",
          channelId: "alpha",
          messageId: app.exact.target.id,
          threadRootId: app.exact.root.id,
          scope: {
            viewer: app.viewer,
            communityOrigin: "https://primary.example",
          },
        },
      );
      await seen;
      await expect(target).toBeFocused();
      // Enough replies to fill the history well past its viewport, so the
      // target at its top is not also at the latest reply.
      for (let i = 0; i < 30; i++) reply();
      await expect(
        history.getByText("Review live reply 29", { exact: true }),
      ).toHaveCount(1);
      await page.evaluate(() => window.releaseExactReveal());
      await settle(page, history);
      let anchor = target;
      const reading = shift.endsWith("after reading");
      if (reading) {
        await history.hover();
        await page.mouse.wheel(0, 200);
        await settle(page, history);
        const id = await history.evaluate((scroller) => {
          const top = scroller.getBoundingClientRect().top;
          return [...scroller.querySelectorAll("[data-message-id]")].find(
            (row) => row.getBoundingClientRect().bottom > top,
          )?.dataset.messageId;
        });
        expect(id).toBeTruthy();
        anchor = history.locator(`[data-message-id="${id}"]`);
      }
      if (shift === "contraction after reading") {
        await anchor.evaluate((el) => {
          const spacer = document.createElement("div");
          spacer.dataset.contraction = "";
          spacer.style.height = "700px";
          el.before(spacer);
        });
        await settle(page, history);
      }
      const y = () =>
        anchor.evaluate(
          (el) =>
            el.getBoundingClientRect().top -
            el.closest('[aria-label="Thread messages"]').getBoundingClientRect()
              .top,
        );

      // Controlled child-only geometry change above the exact row; no React parent commit.
      let resized;
      if (shift === "before reply") {
        await target.evaluate((el) => {
          const spacer = document.createElement("div");
          spacer.style.height = "37px";
          el.before(spacer);
        });
        await settle(page, history);
        resized = await y();
      } else {
        resized = await y();
        // Shift the layout when React inserts the next reply's row: inside
        // that commit and before its layout effects run.
        await anchor.evaluate((el, contract) => {
          const originals = {
            appendChild: Node.prototype.appendChild,
            insertBefore: Node.prototype.insertBefore,
          };
          for (const [name, original] of Object.entries(originals))
            Node.prototype[name] = function (node, ...rest) {
              const result = original.call(this, node, ...rest);
              if (node?.textContent?.includes("Review live reply 30")) {
                Object.assign(Node.prototype, originals);
                if (contract) {
                  const scroller = el.closest('[aria-label="Thread messages"]');
                  const before = scroller.scrollTop;
                  scroller.querySelector("[data-contraction]").remove();
                  window.contractionClamped = scroller.scrollTop < before;
                } else {
                  const spacer = document.createElement("div");
                  spacer.style.height = "37px";
                  el.before(spacer);
                  el.getBoundingClientRect();
                }
              }
              return result;
            };
        }, shift === "contraction after reading");
      }
      reply();
      await expect(
        history.getByText("Review live reply 30", { exact: true }),
      ).toHaveCount(1);
      await settle(page, history);
      if (shift === "contraction after reading")
        expect(
          await page.evaluate(() => window.contractionClamped),
          "the contraction must clamp scrollTop",
        ).toBe(true);
      const later = await y();
      expect(
        Math.abs(later - resized),
        "later update must not repeat resize correction",
      ).toBeLessThan(4);
    } finally {
      await page.evaluate(() => window.releaseExactReveal());
      release();
    }
  }
});
