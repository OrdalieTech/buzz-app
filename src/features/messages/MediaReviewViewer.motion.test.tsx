// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { useRef, useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createRelaySession } from "../relay/session";
import { keypair, message } from "../relay/testing";
import { AttachmentImage } from "./AttachmentImage";
import { MediaAttachment } from "./MediaAttachment";
import { MediaReviewViewer } from "./MediaReviewViewer";

const owners: ReturnType<typeof createRelaySession>[] = [];
afterEach(() => {
  cleanup();
  for (const owner of owners.splice(0)) owner.dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(HTMLElement.prototype, "animate");
});

function setup(kind: "image" | "video", reduced = false) {
  vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(true);
  const cancel = vi.fn();
  const animate = vi.fn(
    (_frames: Keyframe[], _options: KeyframeAnimationOptions) => ({
      cancel,
      onfinish: null as (() => void) | null,
    }),
  );
  Object.defineProperty(HTMLElement.prototype, "animate", {
    value: animate,
    configurable: true,
  });
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: reduced,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    function (this: HTMLElement) {
      return this.hasAttribute("data-media-preview")
        ? new DOMRect(100, 200, 320, 180)
        : new DOMRect(20, 20, 1000, 700);
    },
  );
  const viewer = keypair();
  const attachment = { url: `https://fixture.test/${kind}`, kind };
  const root = message(viewer, "one", "Media", 1, [
    [
      "imeta",
      `url ${attachment.url}`,
      `m ${kind === "image" ? "image/png" : "video/mp4"}`,
    ],
  ]);
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const owner = createRelaySession({
    viewer: viewer.pubkey,
    relayAuthor: keypair().pubkey,
    media: (url) => url,
    async query(filters) {
      if (filters.some((filter) => filter.ids?.includes(root.id))) {
        await gate;
        return [root];
      }
      return [];
    },
  });
  owners.push(owner);
  function Harness() {
    const [open, setOpen] = useState(false);
    const opener = useRef<HTMLElement | null>(null);
    return (
      <>
        {kind === "image" ? (
          <AttachmentImage
            attachment={attachment}
            source={attachment.url}
            onOpenReview={() => {
              opener.current = document.activeElement as HTMLElement;
              setOpen(true);
            }}
          />
        ) : (
          <MediaAttachment
            attachment={attachment}
            media={owner.session.media}
            onOpenReview={() => {
              opener.current = document.activeElement as HTMLElement;
              setOpen(true);
            }}
          />
        )}
        {open && (
          <MediaReviewViewer
            attachment={attachment}
            session={owner.session}
            scope="motion-test"
            channelId="one"
            channelName="One"
            messageId={root.id}
            initialTime={0}
            hasComments={false}
            restoreFocus={opener}
            close={() => setOpen(false)}
            onOpenLink={() => false}
          />
        )}
      </>
    );
  }
  render(<Harness />);
  return { release };
}
const openerName = (kind: "image" | "video") =>
  kind === "image" ? "Open image attachment" : "Open video fullscreen";
const openerRole = (kind: "image" | "video") =>
  kind === "image" ? "link" : "button";

it("opens immediately with reduced motion", () => {
  const { release } = setup("video", true);
  try {
    fireEvent.click(
      screen.getByRole("button", { name: "Open video fullscreen" }),
      { detail: 1 },
    );
    expect(screen.getByRole("dialog")).toBeVisible();
  } finally {
    release();
  }
});

it.each(["image", "video"] as const)(
  "dismisses %s from the backdrop and restores focus without dismissing inside interactions",
  async (kind) => {
    const { release } = setup(kind, true);
    const opener = screen.getByRole(openerRole(kind), {
      name: openerName(kind),
    });
    fireEvent.click(opener, { detail: 1 });
    const dialog = screen.getByRole("dialog");
    const backdrop = dialog.parentElement;
    if (!backdrop) throw new Error("Missing backdrop");
    try {
      // Finishing a drag outside must not count as a backdrop click.
      fireEvent.mouseDown(dialog, { button: 0 });
      fireEvent.mouseUp(backdrop, { button: 0 });
      fireEvent.click(backdrop);
      expect(screen.getByRole("dialog")).toBe(dialog);
      fireEvent.mouseDown(backdrop, { button: 2 });
      expect(screen.getByRole("dialog")).toBe(dialog);
      fireEvent.mouseDown(backdrop, { button: 0 });
      expect(screen.queryByRole("dialog")).toBeNull();
      await waitFor(() => expect(opener).toHaveFocus());
    } finally {
      await act(async () => release());
    }
  },
);

it("closes on Escape and the dialog is gone", () => {
  const { release } = setup("image");
  fireEvent.click(screen.getByRole("link", { name: "Open image attachment" }), {
    detail: 1,
  });
  expect(screen.getByRole("dialog")).toBeVisible();
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  release();
});

it("starts image navigation on the viewer rather than the close button", () => {
  const { release } = setup("image");
  fireEvent.click(screen.getByRole("link", { name: "Open image attachment" }), {
    detail: 1,
  });
  expect(screen.getByRole("dialog")).toHaveFocus();
  expect(
    screen.getByRole("button", { name: "Close fullscreen viewer" }),
  ).not.toHaveFocus();
  release();
});

it("keeps Tab and Shift+Tab in the dialog when initial focus is its noninteractive frame", () => {
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue({
    length: 1,
  } as DOMRectList);
  const { release } = setup("image");
  fireEvent.click(screen.getByRole("link", { name: "Open image attachment" }), {
    detail: 1,
  });
  const dialog = screen.getByRole("dialog");
  fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
  expect(
    screen.getByRole("link", { name: "Open image in browser" }),
  ).toHaveFocus();
  dialog.focus();
  fireEvent.keyDown(dialog, { key: "Tab" });
  expect(screen.getByRole("button", { name: "Show comments" })).toHaveFocus();
  release();
});

it.each(["escape", "backdrop"])(
  "stops video playback when closing via %s",
  (method) => {
    const { release } = setup("video");
    try {
      fireEvent.click(
        screen.getByRole("button", { name: "Open video fullscreen" }),
        { detail: 1 },
      );
      const dialog = screen.getByRole("dialog");
      const video = dialog.querySelector("video");
      if (!video) throw new Error("Missing review video");
      const pause = vi.spyOn(video, "pause").mockImplementation(() => {});
      if (method === "escape") fireEvent.keyDown(document, { key: "Escape" });
      else
        fireEvent.mouseDown(dialog.parentElement as HTMLElement, { button: 0 });
      expect(pause).toHaveBeenCalledOnce();
      if (method === "backdrop") {
        // A native play request can settle while the pointer exit runs.
        fireEvent.play(video);
        expect(pause).toHaveBeenCalledTimes(2);
      }
    } finally {
      release();
    }
  },
);
