// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { FocusDialog } from "./FocusDialog";
import { createPreferences } from "./preferences";
import { createFocus } from "./state";

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});

it("starts Focus for the chosen duration and offers End while it is on", async () => {
  const user = userEvent.setup();
  const focus = createFocus();
  const onOpenChange = vi.fn();
  const dialog = (
    <FocusDialog
      open
      onOpenChange={onOpenChange}
      focus={focus}
      preferences={createPreferences()}
    />
  );
  const view = render(dialog);
  await user.click(screen.getByRole("button", { name: "Duration: 1 hour" }));
  await user.click(
    await screen.findByRole("menuitemradio", { name: "30 minutes" }),
  );
  // Hold the clock so the deadline is exact.
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now);
  await user.click(screen.getByRole("button", { name: "Start focus" }));
  expect(focus.snapshot().until).toBe(Math.floor(now / 1000) + 1800);
  expect(onOpenChange).toHaveBeenLastCalledWith(false);
  view.rerender(dialog);
  expect(screen.getByText(/^Focusing until/)).toHaveTextContent(
    /^Focusing until \S+/,
  );
  expect(screen.queryByText(/Only Solo chats show/)).toBeNull();
  await user.click(screen.getByRole("button", { name: "End focus" }));
  expect(focus.snapshot().until).toBeUndefined();
  focus.dispose();
});

it("rejects a custom end time that has already passed", async () => {
  const user = userEvent.setup();
  const focus = createFocus();
  render(
    <FocusDialog
      open
      onOpenChange={() => {}}
      focus={focus}
      preferences={createPreferences()}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Duration: 1 hour" }));
  await user.click(
    await screen.findByRole("menuitemradio", { name: "Custom" }),
  );
  expect(screen.getByRole("button", { name: "Focus end time" })).toBeVisible();
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 86_400_000);
  await user.click(screen.getByRole("button", { name: "Start focus" }));
  expect(screen.getByRole("alert")).toHaveTextContent("future");
  expect(focus.snapshot().until).toBeUndefined();
  focus.dispose();
});

it("starts from the length in Settings without changing it", async () => {
  const user = userEvent.setup();
  const preferences = createPreferences();
  preferences.set({ length: "7200" });
  const focus = createFocus();
  render(
    <FocusDialog
      open
      onOpenChange={() => {}}
      focus={focus}
      preferences={preferences}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Duration: 2 hours" }));
  await user.click(
    await screen.findByRole("menuitemradio", { name: "30 minutes" }),
  );
  await user.click(screen.getByRole("button", { name: "Start focus" }));
  expect(preferences.snapshot().length).toBe("7200");
  focus.dispose();
});
