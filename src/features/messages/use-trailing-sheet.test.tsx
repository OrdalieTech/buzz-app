// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { useRef } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { useTrailingSheet } from "./use-trailing-sheet";

afterEach(cleanup);

function Host({
  onReveal,
  rest,
  restHeight = 124,
}: {
  onReveal: () => void;
  rest: { current?: () => void };
  restHeight?: number;
}) {
  const scroller = useRef<HTMLElement>(null);
  const card = useTrailingSheet(
    {
      restHeight,
      content: ({ expanded }) => (
        <article aria-label={expanded ? "Grown card" : "Resting card"} />
      ),
    },
    scroller,
    onReveal,
  );
  rest.current = card.rest;
  return (
    <div>
      <section ref={scroller} aria-label="History">
        {card.restSpace}
      </section>
      {card.sheet}
    </div>
  );
}

it("grows with its layer's scroll, returns to Rest, and places Jump to latest above it", () => {
  const onReveal = vi.fn();
  const rest: { current?: () => void } = {};
  const { unmount } = render(<Host onReveal={onReveal} rest={rest} />);
  const history = screen.getByRole("region", { name: "History" });
  expect(history.style.getPropertyValue("--timeline-trailing-rest")).toBe(
    "124px",
  );
  const layer = screen.getByRole("article", { name: "Resting card" })
    .parentElement?.parentElement as HTMLElement;
  layer.scrollTop = 40;
  fireEvent.scroll(layer);
  expect(onReveal).toHaveBeenCalled();
  screen.getByRole("article", { name: "Grown card" });
  act(() => rest.current?.());
  expect(layer.scrollTop).toBe(0);
  screen.getByRole("article", { name: "Resting card" });
  unmount();
  expect(history.style.getPropertyValue("--timeline-trailing-rest")).toBe("");
});

// A new rest height moves the card's top over other rows without a scroll.
it("tells reading when a mounted card's rest height changes", () => {
  const onReveal = vi.fn();
  const rest: { current?: () => void } = {};
  const { rerender } = render(<Host onReveal={onReveal} rest={rest} />);
  expect(onReveal).not.toHaveBeenCalled();
  rerender(<Host onReveal={onReveal} rest={rest} restHeight={200} />);
  expect(onReveal).toHaveBeenCalledOnce();
  expect(
    screen
      .getByRole("region", { name: "History" })
      .style.getPropertyValue("--timeline-trailing-rest"),
  ).toBe("200px");
});
