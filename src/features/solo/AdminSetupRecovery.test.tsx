// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Delivery, Outbox, OutgoingEvent } from "../relay/outbox";
import { soloAdminRecovery } from "../relay/solo-admins";
import { AdminSetupRecovery } from "./AdminSetupRecovery";

afterEach(cleanup);

const chat = "33333333-3333-4333-8333-333333333333";
const agent = "a".repeat(64);
const recovery = soloAdminRecovery(chat, [agent], [agent]);

function records(setup: Delivery, opening: Delivery, channel = chat) {
  return [
    {
      event: {
        id: "create",
        kind: 9007,
        content: "",
        tags: [
          ["h", channel],
          ["p", agent],
        ],
      },
      delivery: setup,
      recovery: soloAdminRecovery(channel, [agent], [agent]),
    },
    {
      event: {
        id: "opening",
        kind: 9,
        content: "Opening work",
        tags: [["h", channel]],
      },
      delivery: opening,
    },
  ] as OutgoingEvent[];
}

function show(
  items: OutgoingEvent[],
  dismiss = vi.fn<Outbox["dismiss"]>(async () => {}),
) {
  let current = items;
  const listeners = new Set<() => void>();
  const outbox = {
    snapshot: () => current,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dismiss: vi.fn<Outbox["dismiss"]>(async (id, owner) => {
      await dismiss(id, owner);
      current = current.filter((item) => item.event.id !== id);
      for (const listener of listeners) listener();
    }),
  } as unknown as Outbox;
  render(<AdminSetupRecovery outbox={outbox} channelId={chat} />);
  return {
    outbox,
    update(next: OutgoingEvent[]) {
      current = next;
      act(() => {
        for (const listener of listeners) listener();
      });
    },
  };
}

const abandon = () =>
  screen.queryByRole("button", { name: "Abandon admin setup" });

it.each([
  [true, records("accepted", "failed")],
  [true, records("seen", "unknown")],
  [false, records("sending", "failed")],
  [false, records("accepted", "sending")],
  [false, records("accepted", "failed", "other")],
])("shows only for this chat's blocked setup (%s)", (shown, items) => {
  show(items);
  expect(!!abandon()).toBe(shown);
});

it("keeps Abandon while a Retry of the opening message waits on setup", () => {
  const view = show(records("accepted", "failed"));
  view.update(records("accepted", "sending"));
  expect(abandon()).toBeVisible();
  view.update(records("accepted", "accepted").slice(1));
  expect(abandon()).not.toBeInTheDocument();
});

it.each([
  ["retires the setup", undefined],
  ["keeps the setup and explains", "Storage unavailable"],
])("abandoning %s", async (_, failure) => {
  const { outbox } = show(
    records("accepted", "failed"),
    vi.fn<Outbox["dismiss"]>(async () => {
      if (failure) throw new Error(failure);
    }),
  );
  fireEvent.click(abandon() as HTMLElement);
  const confirmation = screen.getByRole("alertdialog", {
    name: "Abandon admin setup?",
  });
  fireEvent.click(
    within(confirmation).getByRole("button", { name: "Abandon admin setup" }),
  );
  expect(outbox.dismiss).toHaveBeenCalledWith("create", recovery);
  if (failure)
    expect(await within(confirmation).findByRole("alert")).toHaveTextContent(
      failure,
    );
  else await waitFor(() => expect(abandon()).not.toBeInTheDocument());
});
