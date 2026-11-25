// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import userEvent from "@testing-library/user-event";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ImageViewer, RelayImageViewer } from "./ImageViewer";
import type { RelayData, RelaySnapshot } from "../relay/service";

afterEach(cleanup);

it("shows an https image in the fullscreen viewer and closes on request", async () => {
  const onClose = vi.fn();
  render(
    <ImageViewer
      src="https://fixture.test/screenshot.png"
      name="screenshot.png"
      onClose={onClose}
      media={(url) => url}
    />,
  );
  const dialog = screen.getByRole("dialog", { name: "Image viewer" });
  expect(dialog).toHaveTextContent("screenshot.png");
  expect(screen.getByRole("img")).toHaveAttribute(
    "src",
    "https://fixture.test/screenshot.png",
  );
  expect(
    screen.getByRole("link", { name: "Open image in browser" }),
  ).toHaveAttribute("href", "https://fixture.test/screenshot.png");
  await userEvent.click(
    screen.getByRole("button", { name: "Close fullscreen viewer" }),
  );
  await waitFor(() => expect(onClose).toHaveBeenCalled());
});

it.each([
  "http://fixture.test/a.png",
  "javascript:alert(1)",
  "data:image/png;base64,AA",
])("refuses %s", (src) => {
  const onClose = vi.fn();
  render(<ImageViewer src={src} onClose={onClose} media={(url) => url} />);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(onClose).toHaveBeenCalledOnce();
});

it("shows relay-hosted media through the session's signed read", () => {
  const relayed = "https://relay.fixture.test/media/abc.png";
  render(
    <ImageViewer
      src={relayed}
      onClose={() => {}}
      media={(url) => `/api/relay/media?url=${encodeURIComponent(url)}`}
    />,
  );
  expect(screen.getByRole("img")).toHaveAttribute(
    "src",
    `/api/relay/media?url=${encodeURIComponent(relayed)}`,
  );
});

it("closes when the session cannot read the media", () => {
  const onClose = vi.fn();
  render(
    <ImageViewer
      src="https://relay.fixture.test/media/abc.png"
      onClose={onClose}
      media={() => undefined}
    />,
  );
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(onClose).toHaveBeenCalledOnce();
});

it("follows a controlled source to another image, then to an invalid one", () => {
  const onClose = vi.fn();
  const viewer = (src: string) => (
    <ImageViewer src={src} onClose={onClose} media={(url) => url} />
  );
  const { rerender } = render(viewer("https://fixture.test/one.png"));
  rerender(viewer("https://fixture.test/two.png"));
  expect(screen.getByRole("img")).toHaveAttribute(
    "src",
    "https://fixture.test/two.png",
  );
  expect(
    screen.getByRole("link", { name: "Open image in browser" }),
  ).toHaveAttribute("href", "https://fixture.test/two.png");
  expect(onClose).not.toHaveBeenCalled();
  rerender(viewer("javascript:alert(1)"));
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(onClose).toHaveBeenCalledOnce();
});

it("shows an unavailable status, keeping Close, when the image fails to load", async () => {
  const onClose = vi.fn();
  const viewer = (src: string) => (
    <ImageViewer src={src} onClose={onClose} media={(url) => url} />
  );
  const { rerender } = render(viewer("https://fixture.test/missing.png"));
  fireEvent.error(screen.getByRole("img"));
  expect(screen.queryByRole("img")).not.toBeInTheDocument();
  expect(
    screen.getByText("Image unavailable", { selector: "[role=status]" }),
  ).toBeVisible();
  expect(onClose).not.toHaveBeenCalled();

  // Another source tries again.
  rerender(viewer("https://fixture.test/present.png"));
  expect(screen.getByRole("img")).toHaveAttribute(
    "src",
    "https://fixture.test/present.png",
  );

  await userEvent.click(
    screen.getByRole("button", { name: "Close fullscreen viewer" }),
  );
  await waitFor(() => expect(onClose).toHaveBeenCalled());
});

/** A relay whose snapshot and selected community the test moves. */
function fixtureRelay(selected: string | undefined, snapshot: RelaySnapshot) {
  const listeners = new Set<() => void>();
  let current = { selected, snapshot };
  return {
    relay: {
      snapshot: () => current.snapshot,
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      selected: () => current.selected,
    } as unknown as RelayData,
    move(next: { selected: string | undefined; snapshot: RelaySnapshot }) {
      current = next;
      act(() => {
        for (const listener of listeners) listener();
      });
    },
  };
}

const one = "https://one.fixture.test";
const two = "https://two.fixture.test";
const signed = (url: string) =>
  `/api/relay/media?url=${encodeURIComponent(url)}`;
const session = { media: signed } as unknown as RelaySnapshot["session"];
const connecting = {
  status: "connecting",
  session,
} as unknown as RelaySnapshot;
const ready = (origin: string) =>
  ({ status: "ready", origin, session }) as unknown as RelaySnapshot;

it.each([
  ["connecting", connecting],
  [
    "disconnected",
    { status: "disconnected", session } as unknown as RelaySnapshot,
  ],
])(
  "closes rather than load the selected community's media unsigned while %s",
  (_, snapshot) => {
    const onClose = vi.fn();
    const { relay } = fixtureRelay(one, snapshot);
    render(
      <RelayImageViewer
        src={`${one}/media/abc.png`}
        onClose={onClose}
        relay={relay}
      />,
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(onClose).toHaveBeenCalledOnce();
  },
);

it("loads other https images directly while the community connects", () => {
  const { relay } = fixtureRelay(one, connecting);
  render(
    <RelayImageViewer
      src="https://fixture.test/a.png"
      onClose={() => {}}
      relay={relay}
    />,
  );
  expect(screen.getByRole("img")).toHaveAttribute(
    "src",
    "https://fixture.test/a.png",
  );
});

it("signs relay media once ready, and closes when the community changes", () => {
  const onClose = vi.fn();
  const media = `${one}/media/abc.png`;
  const { relay, move } = fixtureRelay(one, ready(one));
  render(<RelayImageViewer src={media} onClose={onClose} relay={relay} />);
  expect(screen.getByRole("img")).toHaveAttribute("src", signed(media));

  // Switching: the old session is still the snapshot, but no longer selected.
  move({ selected: two, snapshot: ready(one) });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(onClose).toHaveBeenCalledOnce();
});

/** Every `src` the DOM is given until `stop`, transient ones included. */
function srcAssignments() {
  const sources: string[] = [];
  const set = Element.prototype.setAttribute;
  const spy = vi
    .spyOn(Element.prototype, "setAttribute")
    .mockImplementation(function (this: Element, name, value) {
      if (name === "src") sources.push(value);
      set.call(this, name, value);
    });
  return {
    stop() {
      spy.mockRestore();
      return sources;
    },
  };
}

it.each([
  ["another community connecting", { selected: two, snapshot: connecting }],
  ["another community ready", { selected: two, snapshot: ready(two) }],
  [
    "no community",
    {
      selected: undefined,
      snapshot: { status: "disconnected", session } as unknown as RelaySnapshot,
    },
  ],
])(
  "closes, never loading the old community's media unsigned, after switching to %s",
  (_, next) => {
    const onClose = vi.fn();
    const media = `${one}/media/abc.png`;
    const { relay, move } = fixtureRelay(one, ready(one));
    render(<RelayImageViewer src={media} onClose={onClose} relay={relay} />);
    const assigned = srcAssignments();
    move(next);
    const sources = assigned.stop();
    expect(sources).not.toContain(media);
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(onClose).toHaveBeenCalledOnce();
  },
);

it("signs the first community's media again on switching back, never loading it unsigned", () => {
  const media = `${one}/media/abc.png`;
  let open = true;
  const onClose = vi.fn(() => {
    open = false;
  });
  const { relay, move } = fixtureRelay(one, ready(one));
  const viewer = () =>
    open ? (
      <RelayImageViewer src={media} onClose={onClose} relay={relay} />
    ) : null;
  const { rerender } = render(viewer());
  const assigned = srcAssignments();
  move({ selected: two, snapshot: connecting });
  move({ selected: two, snapshot: ready(two) });
  // A viewer the caller keeps mounted through the switch comes back signed.
  open = true;
  move({ selected: one, snapshot: ready(one) });
  rerender(viewer());
  const sources = assigned.stop();
  expect(sources).toContain(signed(media));
  expect(sources).not.toContain(media);
  expect(screen.getByRole("img")).toHaveAttribute("src", signed(media));
});

it("still loads an external image directly after switching communities", () => {
  const { relay, move } = fixtureRelay(one, ready(one));
  render(
    <RelayImageViewer
      src="https://fixture.test/a.png"
      onClose={() => {}}
      relay={relay}
    />,
  );
  move({ selected: two, snapshot: ready(two) });
  expect(screen.getByRole("img")).toHaveAttribute(
    "src",
    "https://fixture.test/a.png",
  );
});

it("closes when the session drops while open", () => {
  const onClose = vi.fn();
  const media = `${one}/media/abc.png`;
  const { relay, move } = fixtureRelay(one, ready(one));
  render(<RelayImageViewer src={media} onClose={onClose} relay={relay} />);
  move({ selected: one, snapshot: connecting });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  expect(onClose).toHaveBeenCalledOnce();
});
