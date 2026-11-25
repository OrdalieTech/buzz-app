// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { setThreadPlacementPreference } from "../../features/messages/thread-preferences";
import { canHoldInline, placeOpening } from "./placement";

const open = { hasTab: false, canHold: true };
const live = { kind: "panel", panel: { inline: false } } as const;

describe("placeOpening", () => {
  afterEach(() => {
    localStorage.clear();
    setThreadPlacementPreference("side");
  });

  it("opens inline for a viewer who never chose a pane", () => {
    localStorage.clear();
    expect(placeOpening({ kind: "thread" }, open)).toBe("inline");
  });

  it("opens everything as a tab unless the setting is inline", () => {
    for (const setting of ["side", "main"] as const) {
      setThreadPlacementPreference(setting);
      for (const opening of [
        { kind: "thread" },
        { kind: "panel", panel: {} },
        { kind: "chat" },
      ] as const)
        expect(placeOpening(opening, open)).toBe("tab");
    }
  });

  it("opens threads, panels and chat links inline under inline", () => {
    setThreadPlacementPreference("inline");
    expect(placeOpening({ kind: "thread" }, open)).toBe("inline");
    expect(placeOpening({ kind: "panel", panel: {} }, open)).toBe("inline");
    expect(placeOpening({ kind: "chat" }, open)).toBe("inline");
  });

  it("keeps a live panel, an existing tab and a view without dialogs as tabs", () => {
    setThreadPlacementPreference("inline");
    // Huddles, Canvas and apps declare `inline: false`.
    expect(placeOpening(live, open)).toBe("tab");
    expect(
      placeOpening({ kind: "panel", panel: {} }, { ...open, hasTab: true }),
    ).toBe("tab");
    expect(placeOpening({ kind: "thread" }, { ...open, hasTab: true })).toBe(
      "tab",
    );
    expect(placeOpening({ kind: "thread" }, { ...open, canHold: false })).toBe(
      "tab",
    );
  });
});

describe("canHoldInline", () => {
  const host = {
    addressed: true,
    channelId: "alpha",
    composes: true,
    threadsInPane: false,
  };
  const thread = { kind: "thread" } as const;
  const panel = { kind: "panel", panel: {} } as const;

  it("holds a thread only in its own conversation, on screen with its composer", () => {
    expect(canHoldInline(thread, host, { channelId: "alpha" })).toBe(true);
    expect(canHoldInline(thread, host, { channelId: "beta" })).toBe(false);
    for (const change of [
      { addressed: false },
      { composes: false },
      { threadsInPane: true },
    ])
      expect(
        canHoldInline(thread, { ...host, ...change }, { channelId: "alpha" }),
      ).toBe(false);
  });

  it("holds a panel over the conversation or a thread view, with or without a composer", () => {
    const quiet = { ...host, composes: false };
    expect(canHoldInline(panel, quiet, { channelId: "alpha" })).toBe(true);
    expect(
      canHoldInline(panel, host, { channelId: "beta", rootId: "root" }),
    ).toBe(true);
    expect(canHoldInline(panel, host, { channelId: "beta" })).toBe(false);
    expect(
      canHoldInline(
        panel,
        { ...host, addressed: false },
        { channelId: "alpha" },
      ),
    ).toBe(false);
  });
});
