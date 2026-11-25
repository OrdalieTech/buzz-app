import { test, expect } from "./source-fixture.mjs";

// Browser-only: the file card retains the dark stage surface across host themes.
test("file previews keep dark stage colors when host appearance changes", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/relay-composer.html?attachments");
  const form = page.getByRole("form", {
    name: "Send a message to General",
    exact: true,
  });
  await form.getByLabel("Choose attachments").setInputFiles({
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Preview notes"),
  });
  await expect(form.getByText(/Ready$/)).toHaveCount(1);
  await form.getByRole("button", { name: "Preview notes.txt" }).click();
  const dialog = page.getByRole("dialog", {
    name: "Attachment preview",
    exact: true,
  });
  const file = dialog.getByRole("link", { name: /notes.txt/ });
  for (const mode of ["light", "dark", "light"]) {
    await page.evaluate((mode) => {
      document.documentElement.dataset.colorMode = mode;
    }, mode);
    await expect(
      dialog.getByRole("heading", { name: "notes.txt", exact: true }),
    ).toHaveCSS(
      "color",
      mode === "light" ? "rgb(15, 15, 15)" : "rgb(255, 255, 255)",
    );
    await expect(file).toHaveCSS("background-color", "rgb(16, 16, 16)");
    await expect(file).toHaveCSS("color", "rgb(255, 255, 255)");
    await file.hover();
    await expect(file).toHaveCSS("background-color", "rgb(46, 46, 46)");
    await page.mouse.move(0, 0);
  }
});

// Browser-only: container-grid cascade and a native CSS transition sampled at
// controlled progress. A DOM emulator cannot prove the sidebar retains width.
for (const kind of ["image", "video"]) {
  test(`narrow ${kind} comments slide downward while retaining their full width`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(
      `/tests/fixtures/media-review.html?${kind === "image" ? "photo" : "review"}`,
    );
    const dialog = page.getByRole("dialog");
    const comments = dialog.locator('aside[aria-label="Media comments"]');
    await expect(
      dialog.getByRole("heading", { name: "Comments" }),
    ).toBeVisible();
    for (const mode of ["light", "dark"]) {
      await page.evaluate((mode) => {
        document.documentElement.dataset.colorMode = mode;
      }, mode);
      const width = await comments.evaluate(
        (el) => el.getBoundingClientRect().width,
      );
      // Extend only the transform duration so the runner can pause the native
      // transition deterministically while preserving its production curve.
      await comments.evaluate((el) => {
        el.style.transitionDuration = "60s, 0s";
      });
      try {
        await dialog.getByRole("button", { name: "Hide comments" }).click();
        await expect(dialog).toHaveAttribute("data-comments-hidden");
        await expect
          .poll(() =>
            comments.evaluate((el) => {
              const transition = el
                .getAnimations()
                .find(
                  (animation) => animation.transitionProperty === "transform",
                );
              if (!transition) return false;
              transition.pause();
              transition.currentTime =
                transition.effect.getTiming().duration * 0.4;
              return true;
            }),
          )
          .toBe(true);
        const state = await comments.evaluate((el) => {
          const style = getComputedStyle(el);
          const transform = new DOMMatrix(style.transform);
          return {
            width: el.getBoundingClientRect().width,
            x: transform.m41,
            y: transform.m42,
            height: el.offsetHeight,
          };
        });
        expect(state.width).toBeCloseTo(width, 1);
        expect(state.x).toBe(0);
        expect(state.y).toBeGreaterThan(0);
        expect(state.y).toBeLessThan(state.height);
        expect(
          await dialog.evaluate(
            (el) =>
              getComputedStyle(el).gridTemplateColumns.split(/\s+/).length,
          ),
        ).toBe(1);
      } finally {
        await comments.evaluate((el) => {
          el.getAnimations().forEach((animation) => {
            animation.finish();
          });
          el.style.removeProperty("transition-duration");
        });
      }
      await expect(comments).toHaveCSS("visibility", "hidden");
      await dialog
        .getByRole("button", { name: "Show comments" })
        .press("Enter");
      await expect(comments).toBeVisible();
      await expect(comments).toHaveCSS("transform", "none");
    }
  });
}

// Browser-only: CSS layout, clipping, focus visibility, and paused control opacity
// cannot be established by jsdom. Playback/zoom logic stays in component tests.
for (const kind of ["image", "video"]) {
  test(`${kind} review keeps its header and controls usable across panel widths`, async ({
    page,
  }) => {
    await page.goto(
      `/tests/fixtures/media-review.html?${kind === "image" ? "gallery&photo" : "review"}`,
    );
    const dialog = page.getByRole("dialog");
    const heading = dialog.getByRole("heading", {
      name: kind === "image" ? "Photo preview" : "Review clip.mp4",
      exact: true,
    });
    await expect(heading).toBeVisible();
    await expect(dialog.locator("[data-review-stage]")).toHaveCSS(
      "background-color",
      "rgb(0, 0, 0)",
    );
    await expect(heading).toHaveCSS("color", "rgb(15, 15, 15)");
    await expect(heading).toHaveCSS("font-size", "14px");
    const header = heading.locator("xpath=ancestor::header");
    await expect(header.locator(".panel-header-title svg")).toHaveCount(0);
    await expect(header).toHaveCSS("border-bottom-width", "1px");
    await expect(header).toHaveCSS("border-bottom-style", "solid");
    await expect(
      dialog.getByRole("heading", { name: "Comments" }),
    ).toBeVisible();
    if (kind === "video") {
      const video = dialog.locator("video");
      await expect
        .poll(() => video.evaluate((el) => el.readyState))
        .toBeGreaterThanOrEqual(2);
      await video.evaluate((el) => el.pause());
      await expect(
        dialog.getByRole("button", { name: "Play video", exact: true }),
      ).toBeVisible();
      // Portrait artwork must fill its avatar, independently of the video's fit.
      const portrait = dialog
        .getByRole("button", { name: "Seek to 00:00.5, Alex", exact: true })
        .locator("img");
      await expect(portrait).toHaveAttribute("data-loaded", "true");
      await expect(portrait).toHaveCSS("object-fit", "cover");
    }
    const comments = dialog.getByRole("complementary", {
      name: "Media comments",
    });
    const composer = comments.getByRole("textbox", { name: "Reply to thread" });
    await composer.fill("Keep this draft through theme changes");
    const composerNode = await composer.elementHandle();
    for (const width of [320, 800, 1280]) {
      await page.setViewportSize({ width, height: 720 });
      for (const mode of ["light", "dark", "light"]) {
        await page.evaluate((mode) => {
          document.documentElement.dataset.colorMode = mode;
        }, mode);
        const foreground =
          mode === "light" ? "rgb(15, 15, 15)" : "rgb(255, 255, 255)";
        const surface =
          mode === "light" ? "rgb(255, 255, 255)" : "rgb(26, 26, 26)";
        await expect(heading).toHaveCSS("color", foreground);
        await expect(comments).toHaveCSS("background-color", surface);
        await expect(
          comments.getByRole("heading", { name: "Comments" }),
        ).toHaveCSS("color", foreground);
        await expect(composer).toHaveCSS("color", foreground);
        await expect(
          dialog.getByRole("button", { name: "Hide comments" }),
        ).toHaveCSS("color", foreground);
        await expect(dialog.locator("[data-review-stage]")).toHaveCSS(
          "background-color",
          "rgb(0, 0, 0)",
        );
        await expect(
          dialog.getByRole("button", {
            name: kind === "image" ? /^Image zoom:/ : "Play video",
            exact: true,
          }),
        ).toHaveCSS("color", "rgb(255, 255, 255)");
        expect(
          await composerNode.evaluate(
            (node) =>
              node ===
              document.querySelector(
                '[aria-label="Media comments"] [role="textbox"]',
              ),
          ),
        ).toBe(true);
        await expect(composer).toHaveText(
          "Keep this draft through theme changes",
        );
      }
      if (kind === "video") {
        await page.evaluate(() =>
          window.dispatchEvent(new Event("fixture-typing")),
        );
        const typing = dialog
          .locator('[aria-hidden="true"]')
          .filter({ hasText: "Alex is typing" });
        await expect(
          dialog.getByRole("status", { name: "Conversation activity" }),
        ).toHaveText("Alex is typing");
        const frameOption = dialog.getByRole("checkbox", {
          name: "Comment at current frame",
        });
        await expect(typing).toContainText("Alex is typing");
        const typingBox = await typing.boundingBox();
        const optionBox = await frameOption.boundingBox();
        expect(typingBox.y).toBeGreaterThan(optionBox.y + optionBox.height);
      }
      const control = dialog.getByRole("button", {
        name: kind === "image" ? /^Image zoom:/ : "Play video",
        exact: true,
      });
      if (kind === "image") {
        await control.focus();
        await page.keyboard.press("Tab");
      } else {
        await dialog.focus();
        await page.mouse.move(0, 0);
      }
      const controls =
        kind === "image"
          ? dialog.locator("[data-image-controls]")
          : dialog
              .getByRole("slider", { name: "Video timeline" })
              .locator("..")
              .locator("..");
      await expect(controls).toHaveCSS("opacity", "1");
      await expect
        .poll(() =>
          controls.evaluate((el) => {
            const bounds = el
              .closest('[role="dialog"]')
              .getBoundingClientRect();
            return [...el.querySelectorAll("button, input, a")].every(
              (item) => {
                const rect = item.getBoundingClientRect();
                return (
                  rect.width >= 24 &&
                  rect.height >= 24 &&
                  rect.left >= bounds.left &&
                  rect.right <= bounds.right &&
                  rect.top >= bounds.top &&
                  rect.bottom <= bounds.bottom
                );
              },
            );
          }),
        )
        .toBe(true);
    }
  });
}

test("unavailable media keeps its explanation readable and recovery visible", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto("/tests/fixtures/media-review.html?photo&missing-root");
  const dialog = page.getByRole("dialog", { name: "Image viewer" });
  const message = dialog
    .getByRole("alert")
    .filter({ has: page.getByRole("button", { name: "Retry", exact: true }) });
  await expect(message).toContainText("Original message unavailable.");
  await expect(message).toHaveCSS("color", "rgb(255, 255, 255)");
  await expect(
    message.getByRole("button", { name: "Retry", exact: true }),
  ).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Comments" })).toBeVisible();
});

// Browser-only: avatar and pill geometry, where the engines size an absolutely
// positioned avatar slot differently.
for (const [working, query, row] of [
  ["conversation indicator", "agent-working", ""],
  // The step follows the viewer's own comment, inside its own comment row.
  ["recorded step", "agent-working&agent-update", "[data-review-comment] "],
])
  test(`media comments keep a working agent's ${working} avatar in the comment avatar column`, async ({
    page,
  }) => {
    await page.goto(`/tests/fixtures/media-review.html?photo&${query}`);
    const drawer = page
      .getByRole("dialog", { name: "Image viewer", exact: true })
      .getByRole("complementary", { name: "Media comments" });
    // The agent's comment is first; the viewer's own comment is the last.
    const comment = drawer.locator("[data-review-comment]").first();
    const indicator = drawer.locator(`${row}[data-agent-response-preview]`);
    await expect(indicator).toBeVisible();
    // A recorded step replaces the conversation indicator: one pill, not two.
    await expect(drawer.locator("[data-agent-response-preview]")).toHaveCount(
      1,
    );
    for (const density of ["default", "compact"]) {
      await page.evaluate((density) => {
        document.documentElement.dataset.messageDensity = density;
      }, density);
      await expect
        .poll(
          async () => {
            const [avatar, bubble, agentAvatar, pill] = await Promise.all(
              [
                comment.locator("[data-avatar-shape]").first(),
                comment.locator('[class*="messageBubble"]').first(),
                indicator.locator("[data-avatar-shape]").first(),
                indicator.locator('[class*="messageBubble"]').first(),
              ].map((part) => part.boundingBox()),
            );
            return {
              size: [agentAvatar.width, agentAvatar.height],
              column: agentAvatar.x - avatar.x,
              pillEdge: pill.x - bubble.x,
              gap: pill.x - (agentAvatar.x + agentAvatar.width),
              commentGap: bubble.x - (avatar.x + avatar.width),
              // Beside its pill, not on top of it.
              clear:
                agentAvatar.x + agentAvatar.width <= pill.x ||
                agentAvatar.y + agentAvatar.height <= pill.y ||
                agentAvatar.y >= pill.y + pill.height,
              // Bubbles end on the avatar's bottom edge; a flat list centres
              // the avatar on the first line's top edge.
              block:
                density === "compact"
                  ? agentAvatar.y + agentAvatar.height / 2 - pill.y
                  : agentAvatar.y + agentAvatar.height - pill.y - pill.height,
              commentBlock:
                density === "compact"
                  ? avatar.y + avatar.height / 2 - bubble.y
                  : avatar.y + avatar.height - bubble.y - bubble.height,
            };
          },
          { message: density },
        )
        .toEqual({
          size: [24, 24],
          column: 0,
          pillEdge: 0,
          gap: density === "compact" ? 10 : 4,
          commentGap: density === "compact" ? 10 : 4,
          clear: true,
          block: 0,
          commentBlock: 0,
        });
    }
  });

test("media comments stack a working agent's recorded step under its own comment", async ({
  page,
}) => {
  await page.goto(
    "/tests/fixtures/media-review.html?photo&agent-working&agent-update=own",
  );
  const drawer = page
    .getByRole("dialog", { name: "Image viewer", exact: true })
    .getByRole("complementary", { name: "Media comments" });
  const rows = drawer.locator("[data-review-comment]");
  await expect(rows).toHaveCount(4);
  // The agent's comment, then its working step: one group, named once.
  const own = rows.nth(2);
  const step = rows.nth(3);
  const pill = step.locator("[data-agent-response-preview]");
  await expect(pill).toBeVisible();
  await expect(drawer.locator("[data-agent-response-preview]")).toHaveCount(1);
  await expect(own.locator('[class*="byline"]')).toHaveText(/Alex/);
  await expect(step.locator('[class*="byline"]')).toHaveCount(0);
  for (const density of ["default", "compact"]) {
    await page.evaluate((density) => {
      document.documentElement.dataset.messageDensity = density;
    }, density);
    // Bubbles end the group with its avatar; a flat list starts with it.
    const [bare, held] = density === "compact" ? [step, own] : [own, step];
    await expect(bare.locator('[class*="messageAvatar"]'), density).toHaveCount(
      0,
    );
    await expect
      .poll(
        async () => {
          const [column, avatar, bubble, stepPill] = await Promise.all(
            [
              rows.first().locator("[data-avatar-shape]").first(),
              held.locator('[class*="messageAvatar"] [data-avatar-shape]'),
              own.locator('[class*="messageBubble"]').first(),
              pill.locator('[class*="messageBubble"]').first(),
            ].map((part) => part.boundingBox()),
          );
          return {
            size: [avatar.width, avatar.height],
            column: avatar.x - column.x,
            pillEdge: stepPill.x - bubble.x,
            // The thread's stacked-row gap, not the space between comments.
            gap: stepPill.y - (bubble.y + bubble.height),
          };
        },
        { message: density },
      )
      .toEqual({
        size: [24, 24],
        column: 0,
        pillEdge: 0,
        gap: density === "compact" ? 8 : 2,
      });
  }
});

// Earlier steps are history lines here, so a working step under one is not
// part of a drawn group: it names its agent and shows its avatar itself.
for (const [order, query] of [
  ["an earlier step of its run", "steps"],
  ["its own comment and an earlier step", "own-steps"],
  // Sam has no picture and Alex has one, so the image is Alex's.
  ["another agent's step", "agents"],
])
  test(`media comments attribute a working agent's recorded step after ${order}`, async ({
    page,
  }) => {
    await page.goto(
      `/tests/fixtures/media-review.html?photo&agent-working&agent-update=${query}`,
    );
    const drawer = page
      .getByRole("dialog", { name: "Image viewer", exact: true })
      .getByRole("complementary", { name: "Media comments" });
    const rows = drawer.locator("[data-review-comment]");
    const step = rows.last();
    const pill = step.locator("[data-agent-response-preview]");
    await expect(pill).toBeVisible();
    await expect(drawer.locator("[data-agent-response-preview]")).toHaveCount(
      1,
    );
    const history = rows.nth(-2);
    await expect(history).toContainText("Opening the clip");
    await expect(
      drawer.locator("[data-stack-next], [data-stack-previous]"),
    ).toHaveCount(0);
    for (const density of ["default", "compact"]) {
      await page.evaluate((density) => {
        document.documentElement.dataset.messageDensity = density;
      }, density);
      await expect(step.locator('[class*="byline"]'), density).toHaveText(
        /Alex/,
      );
      const avatar = step.locator(
        '[class*="messageAvatar"] [data-avatar-shape]',
      );
      await expect(avatar.locator("img"), density).toHaveCount(1);
      if (query === "own-steps")
        await expect(
          rows.nth(-3).locator('[class*="messageAvatar"] [data-avatar-shape]'),
          density,
        ).toHaveCount(1);
      await expect
        .poll(
          async () => {
            const [column, box] = await Promise.all(
              [rows.first().locator("[data-avatar-shape]").first(), avatar].map(
                (part) => part.boundingBox(),
              ),
            );
            return { size: [box.width, box.height], column: box.x - column.x };
          },
          { message: density },
        )
        .toEqual({ size: [24, 24], column: 0 });
    }
  });

// Browser-only: where focus goes when its element is removed, and where the
// next Tab starts from, are the engine's sequential focus navigation.
test("media comments keep keyboard focus on a recorded step when its agent's work ends", async ({
  page,
}) => {
  await page.goto(
    "/tests/fixtures/media-review.html?photo&agent-working&agent-update",
  );
  const dialog = page.getByRole("dialog", {
    name: "Image viewer",
    exact: true,
  });
  const drawer = dialog.getByRole("complementary", { name: "Media comments" });
  const step = drawer.locator("[data-review-comment]").last();
  const disclosure = step.getByRole("button", {
    name: /Rechecking the second cut/,
  });
  await expect(step.locator("[data-agent-response-preview]")).toBeVisible();
  await disclosure.focus();
  await expect(disclosure).toBeFocused();
  await page.evaluate(() =>
    window.dispatchEvent(new Event("fixture-agent-done")),
  );
  // The step is now a history line: the same row, a replacement disclosure.
  await expect(drawer.locator("[data-agent-response-preview]")).toHaveCount(0);
  await expect(step).toContainText("Rechecking the second cut");
  await expect(disclosure).toBeFocused();
  // Tab moves on from the row to the composer below it, not to the viewer's
  // first control.
  await page.keyboard.press("Tab");
  await expect
    .poll(() =>
      page.evaluate(() => {
        const comments = document.querySelector(
          '[aria-label="Media comments"]',
        );
        const row = [...comments.querySelectorAll("[data-review-comment]")].at(
          -1,
        );
        const active = document.activeElement;
        return {
          inComments: comments.contains(active),
          afterRow: !!(
            row.compareDocumentPosition(active) &
            Node.DOCUMENT_POSITION_FOLLOWING
          ),
          inRow: row.contains(active),
        };
      }),
    )
    .toEqual({ inComments: true, afterRow: true, inRow: false });
});

// Browser-only, as above: the focused link is removed with the row's old
// container, by either route that makes a working step a history line.
for (const [route, event] of [
  ["its agent's work ends", "fixture-agent-done"],
  ["a newer step arrives", "fixture-agent-step"],
]) {
  const open = async (page) => {
    await page.goto(
      "/tests/fixtures/media-review.html?photo&agent-working&agent-update=link",
    );
    const drawer = page
      .getByRole("dialog", { name: "Image viewer", exact: true })
      .getByRole("complementary", { name: "Media comments" });
    const step = drawer
      .locator("[data-review-comment]")
      .filter({ hasText: "Rechecking the second cut" });
    const link = step.getByRole("link", { name: "https://example.org/cut" });
    await expect(step.locator("[data-agent-response-preview]")).toBeVisible();
    await step.getByRole("button", { name: /Rechecking/ }).click();
    await expect(link).toBeVisible();
    return {
      drawer,
      link,
      // The step is then a history line: the same row, replacement details.
      async change() {
        await page.evaluate(
          (event) => window.dispatchEvent(new Event(event)),
          event,
        );
        await expect(step.locator("[data-agent-response-preview]")).toHaveCount(
          0,
        );
        await expect(link).toBeVisible();
      },
    };
  };

  test(`media comments keep keyboard focus on a link in a step's open details when ${route}`, async ({
    page,
  }) => {
    const { link, change } = await open(page);
    await link.focus();
    await expect(link).toBeFocused();
    await change();
    await expect(link).toBeFocused();
  });

  test(`media comments leave focus outside a step's open details when ${route}`, async ({
    page,
  }) => {
    const { drawer, link, change } = await open(page);
    const composer = drawer.getByRole("textbox", { name: "Reply to thread" });
    // Focus that has left the row is not pulled back into it.
    await link.focus();
    await composer.focus();
    await expect(composer).toBeFocused();
    await change();
    await expect(composer).toBeFocused();
  });
}

// Browser-only: the measured gaps come from wrapper spacing the stylesheet
// picks by selector.
test("media comments keep a finished step's spacing when its details open", async ({
  page,
}) => {
  await page.goto(
    "/tests/fixtures/media-review.html?photo&agent-update=between",
  );
  const drawer = page
    .getByRole("dialog", { name: "Image viewer", exact: true })
    .getByRole("complementary", { name: "Media comments" });
  const rows = drawer.locator("[data-review-comment]");
  await expect(rows).toHaveCount(4);
  const step = rows.nth(2);
  const disclosure = step.getByRole("button", {
    name: /Rechecking the second cut/,
  });
  const entry = step.locator("[data-message-id]").first();
  // One read of one layout. The details open and close over a height
  // transition and are removed when the close ends, which shortens the line
  // in a single step; separate reads can land on either side of that step.
  const read = () =>
    rows.evaluateAll((nodes) => {
      const step = nodes[2];
      const line = step.querySelector("button[aria-expanded]");
      const box = step
        .querySelector("[data-message-id]")
        .getBoundingClientRect();
      const panel = step.querySelector('[class*="audienceBody"]');
      // The row's content box: its own spacing is what is measured.
      const content = (node) => {
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return {
          top: rect.top + Number.parseFloat(style.paddingTop),
          bottom: rect.bottom - Number.parseFloat(style.paddingBottom),
        };
      };
      const moving =
        panel?.hasAttribute("data-starting-style") ||
        step.getAnimations({ subtree: true }).length > 0;
      return {
        // Settled closed: the details are gone. Settled open: they are in
        // place and nothing in the row is still animating.
        state:
          line.getAttribute("aria-expanded") === "true"
            ? moving
              ? "opening"
              : "open"
            : panel
              ? "closing"
              : "closed",
        above:
          Math.round(
            (line.getBoundingClientRect().top - content(nodes[1]).bottom) * 2,
          ) / 2,
        below: Math.round((content(nodes[3]).top - box.bottom) * 2) / 2,
      };
    });
  for (const density of ["default", "compact"]) {
    await page.evaluate((density) => {
      document.documentElement.dataset.messageDensity = density;
    }, density);
    await expect
      .poll(async () => (await read()).state, { message: density })
      .toBe("closed");
    const closed = await read();
    expect(closed.state, density).toBe("closed");
    await disclosure.click();
    await expect(
      entry.getByText("Rechecking the second cut").last(),
      density,
    ).toBeVisible();
    await expect
      .poll(read, { message: density })
      .toEqual({ ...closed, state: "open" });
    await disclosure.click();
    await expect(disclosure, density).toHaveAttribute("aria-expanded", "false");
  }
});

// Inline previews have a much shorter media area than the expanded player.
test("narrow video thumbnails keep play clear of the progress controls", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto("/tests/fixtures/media-review.html");
  const preview = page.locator("[data-video-preview]");
  await expect(preview.locator("video")).toHaveCSS("object-fit", "contain");
  await expect(preview).toHaveCSS("clip-path", "none");
  await expect(preview.locator("[data-image-outline]")).toHaveCSS(
    "overflow",
    "visible",
  );
  const play = preview.getByRole("button", { name: "Play video", exact: true });
  // Metadata enables the timeline; do not tab past its initial disabled state.
  await expect(
    preview.getByRole("slider", { name: "Video progress" }),
  ).toBeEnabled();
  const expand = preview.getByRole("button", { name: "Open video fullscreen" });
  await page.mouse.move(0, 0);
  await expect(expand).toHaveCSS("opacity", "0");
  await preview.hover();
  await expect(expand).toHaveCSS("opacity", "1");
  await page.mouse.move(0, 0);
  await expand.focus();
  await page.keyboard.press("Shift+Tab");
  await expect(expand).toHaveCSS("opacity", "1");
  await play.focus();
  await page.keyboard.press("Tab");
  await expect(
    preview.getByRole("button", { name: "Video volume", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  const controls = preview
    .getByRole("slider", { name: "Video progress" })
    .locator("..")
    .locator("..");
  await expect
    .poll(() =>
      controls.evaluate((el) => {
        const play = el.parentElement.querySelector(
          'button[aria-label="Play video"]',
        );
        const frame = el.parentElement.getBoundingClientRect();
        const button = play.getBoundingClientRect();
        return (
          Math.abs(button.x + button.width / 2 - (frame.x + frame.width / 2)) <
            1 &&
          Math.abs(
            button.y + button.height / 2 - (frame.y + frame.height / 2),
          ) < 1 &&
          el.getBoundingClientRect().top >= button.bottom
        );
      }),
    )
    .toBe(true);
  await expect(
    preview.getByRole("slider", { name: "Video progress" }),
  ).toBeFocused();
});

// CSS transitions and their reduced-motion override need a real rendering engine.
test("mute glides the volume knob and keyboard changes stay immediate", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/media-review.html?review");
  const dialog = page.getByRole("dialog", {
    name: "Video review",
    exact: true,
  });
  // Playback hides the controls and, on CI's Linux WebKit, restarts the ended
  // clip when it is muted. Keep the clip still so only the volume UI moves.
  await dialog.locator("[data-review-media]").evaluate((video) => {
    video.autoplay = false;
    video.pause();
  });
  await dialog
    .getByRole("button", { name: "Video volume", exact: true })
    .hover();
  const popup = page.getByRole("dialog", {
    name: "Video volume controls",
    exact: true,
  });
  const volume = page.getByRole("slider", { name: "Video volume" });
  await expect(volume).toBeVisible();
  const knob = volume
    .locator("..")
    .locator('[aria-hidden="true"] > span')
    .last();
  await expect(volume).toHaveValue("1");
  // Hold the actual CSS transition at its midpoint instead of racing its duration.
  // Pause from the poll, not a transitionrun listener, and stretch the 120ms
  // glide so a slow runner cannot finish it before the first poll.
  await knob.evaluate((el) => el.style.setProperty("--duration-fast", "60s"));
  try {
    await popup
      .getByRole("button", { name: "Mute video", exact: true })
      .click();
    await expect(volume).toHaveValue("0");
    await expect
      .poll(() =>
        knob.evaluate((el) => {
          const animation = el.getAnimations()[0];
          if (!animation) return false;
          animation.pause();
          animation.currentTime = animation.effect.getTiming().duration / 2;
          const y = new DOMMatrix(getComputedStyle(el).transform).m42;
          return y < 0 && y > -el.getBoundingClientRect().height;
        }),
      )
      .toBe(true);
  } finally {
    await knob.evaluate((el) => {
      el.getAnimations().forEach((animation) => {
        animation.finish();
      });
      el.style.removeProperty("--duration-fast");
    });
  }
  await popup
    .getByRole("button", { name: "Unmute video", exact: true })
    .click();
  await expect(volume).toHaveValue("1");
  await volume.press("ArrowDown");
  await expect(volume).toHaveValue("0.95");
  await expect(knob).toHaveCSS("transition-duration", "0s");
  await popup
    .getByRole("button", { name: "Mute video", exact: true })
    .press("Enter");
  await expect(volume).toHaveValue("0");
  await expect(knob).toHaveCSS("transition-duration", "0s");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await popup
    .getByRole("button", { name: "Unmute video", exact: true })
    .click();
  await expect(volume).toHaveValue("0.95");
  await expect(knob).toHaveCSS("transition-duration", "0s");
});

// Native hover, portal hit testing, and vertical range geometry are browser contracts.
test("media popovers support hover and keyboard without stealing playback focus", async ({
  page,
}) => {
  // Linux media backends return float32 volume values (0.8 becomes 0.8000000119).
  // Keep that precision boundary covered on every runner, including macOS.
  await page.addInitScript(() => {
    const volume = Object.getOwnPropertyDescriptor(
      HTMLMediaElement.prototype,
      "volume",
    );
    Object.defineProperty(HTMLMediaElement.prototype, "volume", {
      ...volume,
      get() {
        return Math.fround(volume.get.call(this));
      },
    });
  });
  await page.goto("/tests/fixtures/media-review.html?review");
  const review = page.getByRole("dialog", {
    name: "Video review",
    exact: true,
  });
  const trigger = review.getByRole("button", {
    name: "Video volume",
    exact: true,
  });
  await expect(
    review.getByRole("slider", { name: "Video timeline" }),
  ).toBeEnabled();
  // Enter the video before its controls: autoplay can hide chrome during startup.
  await review
    .locator("[data-review-stage]")
    .hover({ position: { x: 8, y: 8 } });
  await expect(trigger.locator("..")).toHaveCSS("opacity", "1");
  await trigger.hover();
  const volumePopup = page.getByRole("dialog", {
    name: "Video volume controls",
    exact: true,
  });
  const volume = volumePopup.getByRole("slider", { name: "Video volume" });
  await expect(volume).toBeVisible();
  await volume.hover();
  await expect(volumePopup).toBeVisible();
  const geometry = await volume.boundingBox();
  expect(geometry.height).toBeGreaterThan(geometry.width);
  const popupGeometry = await volumePopup.boundingBox();
  expect(popupGeometry.width).toBeLessThanOrEqual(44);
  expect(
    await volumePopup.evaluate((el) =>
      Number.parseFloat(getComputedStyle(el).borderTopLeftRadius),
    ),
  ).toBeGreaterThanOrEqual(popupGeometry.width / 2);
  // Native vertical input: the upper part raises volume and the lower part lowers it.
  await volume.click({
    position: { x: geometry.width / 2, y: 4 + (geometry.height - 8) * 0.2 },
  });
  await expect.poll(() => volume.inputValue()).toBe("0.8");
  await volume.press("ArrowDown");
  await expect(volume).toBeFocused();
  await expect(volume).toHaveValue("0.75");
  await expect(review.locator("video")).toHaveJSProperty("volume", 0.75);
  await volume.press("Escape");
  await expect(volumePopup).toBeHidden();
  await expect(review).toBeVisible();
  await expect(trigger).toBeFocused();
  await trigger.press("Enter");
  await expect(volume).toBeFocused();
  await expect(volume).toHaveValue("0.75");
  await expect(review.locator("video")).toHaveJSProperty("muted", false);
  await volume.press("Escape");
  await expect(volumePopup).toBeHidden();
  await expect(trigger).toBeFocused();
  await expect(review.locator("video")).toHaveJSProperty("muted", false);
  await expect(review.locator("video")).toHaveJSProperty("volume", 0.75);
  await trigger.press("Space");
  await expect(volume).toBeFocused();
  await expect(volume).toHaveValue("0.75");
  await volume.press("ArrowDown");
  await expect(volume).toHaveValue("0.7");
  await expect
    .poll(() => review.locator("video").evaluate((video) => video.volume))
    .toBeCloseTo(0.7, 6);
  await volume.press("Tab");
  const mute = volumePopup.getByRole("button", {
    name: "Mute video",
    exact: true,
  });
  await expect(mute).toBeFocused();
  await mute.press("Enter");
  await expect(volume).toHaveValue("0");
  await expect(review.locator("video")).toHaveJSProperty("muted", true);
  const unmute = volumePopup.getByRole("button", {
    name: "Unmute video",
    exact: true,
  });
  await unmute.press("Space");
  await expect(volume).toHaveValue("0.7");
  await expect(review.locator("video")).toHaveJSProperty("muted", false);
  await mute.press("Tab");
  await expect(
    review.getByRole("slider", { name: "Video timeline" }),
  ).toBeFocused();
  const speed = review.getByRole("button", { name: "Playback speed: 1x" });
  await speed.hover();
  const menu = page.getByRole("menu", { name: /^Playback speed:/ });
  await expect(menu).toBeVisible();
  expect((await menu.boundingBox()).width).toBeLessThan(120);
  await menu.getByRole("menuitemradio", { name: "1.5x", exact: true }).click();
  await expect(review.locator("video")).toHaveJSProperty("playbackRate", 1.5);
  await expect(menu).toBeHidden();
});

test("timeline hover marks the click position without seeking until clicked", async ({
  page,
}) => {
  await page.goto("/tests/fixtures/media-review.html?review");
  const review = page.getByRole("dialog", {
    name: "Video review",
    exact: true,
  });
  const video = review.locator("video");
  await expect
    .poll(() => video.evaluate((el) => el.readyState))
    .toBeGreaterThanOrEqual(2);
  await video.evaluate((el) => {
    el.pause();
  });
  const before = await video.evaluate((el) => el.currentTime);
  const timeline = review.getByRole("slider", { name: "Video timeline" });
  const bounds = await timeline.boundingBox();
  await expect(timeline).toHaveCSS("background-size", "100% 2px");
  const x = bounds.x + 1 + (bounds.width - 2) * 0.4;
  await page.mouse.move(x, bounds.y + bounds.height / 2);
  const preview = review.locator("[data-seek-preview]");
  await expect(preview).toBeVisible();
  await expect(preview).toHaveCSS("width", "2px");
  const marker = await preview.boundingBox();
  expect(Math.abs(marker.x + marker.width / 2 - x)).toBeLessThan(1);
  expect(
    await preview.evaluate((el) => getComputedStyle(el, "::before").opacity),
  ).toBe("0.5");
  await expect(video).toHaveJSProperty("currentTime", before);
  await page.mouse.click(x, bounds.y + bounds.height / 2);
  await expect
    .poll(() => video.evaluate((el) => el.currentTime))
    .toBeCloseTo((await video.evaluate((el) => el.duration)) * 0.4, 1);
  await page.mouse.move(0, 0);
  await expect(preview).toBeHidden();
});

// Native touch activation must disclose the controls without mutating media.
test.describe("touch volume controls", () => {
  test.use({ hasTouch: true });

  test("opening and dismissing volume preserves sound until an explicit mute", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 320, height: 320 });
    await page.goto("/tests/fixtures/media-review.html?review");
    const review = page.getByRole("dialog", {
      name: "Video review",
      exact: true,
    });
    const video = review.locator("video");
    await expect(
      review.getByRole("slider", { name: "Video timeline" }),
    ).toBeEnabled();
    await video.evaluate((element) => {
      element.volume = 0.75;
    });
    const trigger = review.getByRole("button", {
      name: "Video volume",
      exact: true,
    });
    await trigger.tap();
    const popup = page.getByRole("dialog", {
      name: "Video volume controls",
      exact: true,
    });
    await expect(
      popup.getByRole("slider", { name: "Video volume" }),
    ).toHaveValue("0.75");
    await expect(video).toHaveJSProperty("muted", false);
    await expect(video).toHaveJSProperty("volume", 0.75);
    await expect
      .poll(() =>
        popup.evaluate((element) => {
          const bounds = element.getBoundingClientRect();
          return [...element.querySelectorAll("input, button")].every(
            (control) => {
              const rect = control.getBoundingClientRect();
              return (
                rect.width >= 24 &&
                rect.height >= 24 &&
                rect.top >= bounds.top &&
                rect.bottom <= bounds.bottom &&
                rect.left >= bounds.left &&
                rect.right <= bounds.right
              );
            },
          );
        }),
      )
      .toBe(true);
    await trigger.tap();
    await expect(popup).toBeHidden();
    await expect(video).toHaveJSProperty("muted", false);
    await expect(video).toHaveJSProperty("volume", 0.75);
    await trigger.tap();
    await popup.getByRole("button", { name: "Mute video", exact: true }).tap();
    await expect(video).toHaveJSProperty("muted", true);
    await expect(
      popup.getByRole("slider", { name: "Video volume" }),
    ).toHaveValue("0");
    await popup
      .getByRole("button", { name: "Unmute video", exact: true })
      .tap();
    await expect(video).toHaveJSProperty("muted", false);
    await expect(
      popup.getByRole("slider", { name: "Video volume" }),
    ).toHaveValue("0.75");
    await expect(video).toHaveJSProperty("volume", 0.75);
  });
});
