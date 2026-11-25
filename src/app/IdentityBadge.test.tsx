// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  FAMILIAR_HINT_REST_MS,
  HELPFUL_HINT_REST_MS,
} from "../shared/design-system/ui/hoverIntent";
import { IdentityBadge } from "./IdentityBadge";

const viewer = "ab".repeat(32);

function renderBadge(
  props: { picture?: string | undefined; photoContext?: string } = {},
) {
  const onCopy = vi.fn();
  render(
    <IdentityBadge viewer={viewer} name="Fern" onCopy={onCopy} {...props}>
      {() => null}
    </IdentityBadge>,
  );
  return onCopy;
}

/** The hint a pointer opens by resting on `target` for `rest`. */
function hintOf(target: HTMLElement, rest: number) {
  fireEvent.mouseEnter(target);
  fireEvent.mouseMove(target);
  act(() => vi.advanceTimersByTime(rest));
  return screen.getByRole("tooltip");
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it.each([
  ["without a picture", undefined],
  ["with a picture", "https://example.org/fern.png"],
])("names the avatar by its community %s", (_case, picture) => {
  renderBadge({ picture, photoContext: "Example" });
  const avatar = screen.getByRole("img", { name: "Your avatar in Example" });
  expect(hintOf(avatar, HELPFUL_HINT_REST_MS)).toHaveTextContent(
    /^Your avatar in Example$/,
  );
});

it("names the avatar and keeps the shared-ID hint outside a community", () => {
  renderBadge();
  const avatar = screen.getByRole("img", { name: "Your avatar" });
  expect(hintOf(avatar, HELPFUL_HINT_REST_MS)).toHaveTextContent(
    /^Your ID is shared across communities\.$/,
  );
});

it("captions the shortened key as the Buzz ID and offers to copy the full one", () => {
  const onCopy = renderBadge();
  const key = screen.getByText("npub14w46h…4w4scf6zts");
  expect(key).toBeVisible();
  // The caption, not the card's heading: it shares its block with the key.
  const caption = screen.getByText("Buzz ID", { selector: "span" });
  expect(caption).toBeVisible();
  expect(caption.parentElement).toContainElement(key);
  const copy = screen.getByRole("button", { name: "Copy Buzz ID" });
  expect(hintOf(copy, FAMILIAR_HINT_REST_MS)).toHaveTextContent(
    /^Copy full Buzz ID$/,
  );
  fireEvent.click(copy);
  expect(onCopy).toHaveBeenCalledTimes(1);
});
