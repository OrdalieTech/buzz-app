// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { npubEncode } from "nostr-tools/nip19";
import { WelcomeBack } from "./WelcomeBack";
afterEach(cleanup);
it.each([true, false])(
  "selects the profile through the available recovery route (backup: %s)",
  (backup) => {
    const restore = vi.fn(),
      enter = vi.fn();
    render(
      <WelcomeBack
        email="ada@example.com"
        npub={npubEncode("ab".repeat(32))}
        profile={{ name: "Ada", picture: "" }}
        onRestore={backup ? restore : undefined}
        onImport={enter}
        onSwitchAccount={vi.fn()}
      />,
    );
    expect(screen.getByText("Signed in as ada@example.com")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /Continue with Ada/ }));
    expect(restore).toHaveBeenCalledTimes(backup ? 1 : 0);
    expect(enter).toHaveBeenCalledTimes(backup ? 0 : 1);
    expect(screen.queryByText("I lost this key")).toBeNull();
    expect(screen.queryByText("Restore from backup")).toBeNull();
  },
);

it("shows the first and last ten public-key characters without inventing a profile name", () => {
  const npub = npubEncode("ab".repeat(32));
  render(
    <WelcomeBack npub={npub} onImport={vi.fn()} onSwitchAccount={vi.fn()} />,
  );
  const label = `${npub.slice(0, 10)}...${npub.slice(-10)}`;
  expect(screen.getByText(label)).toBeVisible();
  expect(screen.getByText(label)).toHaveAttribute("title", npub);
  expect(
    screen.getByRole("button", { name: `Saved key, ${label}` }),
  ).toBeEnabled();
  expect(screen.queryByText("Buzz identity")).toBeNull();
});
