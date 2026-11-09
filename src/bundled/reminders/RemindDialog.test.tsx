// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, assert, expect, it, vi } from "vitest";
import type { ChannelMessage } from "../../features/relay/contracts";
import { eventDto } from "../../features/relay/events";
import { foldMessages } from "../../features/relay/fold";
import type { RelaySession } from "../../features/relay/session";
import { keypair, signed } from "../../features/relay/testing";
import userEvent from "@testing-library/user-event";
import { RemindDialog } from "./RemindDialog";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("redacts spoilers before handing the preview to reminder storage", async () => {
  const create = vi.fn(async () => {});
  render(
    <RemindDialog
      message={
        {
          id: "m",
          channelId: "c",
          authorId: "a",
          content: "The answer is ||Rosebud||",
        } as ChannelMessage
      }
      session={{ reminders: { create } } as unknown as RelaySession}
      close={() => {}}
    />,
  );
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "Set reminder" }));
  expect(create).toHaveBeenCalledExactlyOnceWith(
    {
      eventId: "m",
      channelId: "c",
      authorPubkey: "a",
      preview: "The answer is [Spoiler]",
    },
    expect.any(Number),
    "",
  );
});

it("saves a preview that never splits an emoji at the cap", async () => {
  const create = vi.fn(async () => {});
  // The emoji straddle UTF-16 unit 280, which a unit-based cut would halve.
  const content = `x${"😀".repeat(150)}`;
  render(
    <RemindDialog
      message={
        {
          id: "m",
          channelId: "c",
          authorId: "a",
          content,
        } as unknown as ChannelMessage
      }
      session={{ reminders: { create } } as unknown as RelaySession}
      close={() => {}}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Set reminder" }));
  await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
  const [{ preview }] = create.mock.calls[0] as unknown as [
    { preview: string },
  ];
  // No lone surrogate, which the native bridge's JSON parser rejects.
  expect(() => encodeURIComponent(preview)).not.toThrow();
  expect(preview.startsWith(`x${"😀".repeat(100)}`)).toBe(true);
});

it("saves a well-formed preview when an emoji lands on the source cut after a stripped link", async () => {
  const create = vi.fn(async () => {});
  const link = `[a](https://example.com/${"x".repeat(4000)})`;
  const content = `${link}${" ".repeat(4095 - link.length)}😀`;
  render(
    <RemindDialog
      message={
        {
          id: "m",
          channelId: "c",
          authorId: "a",
          content,
        } as unknown as ChannelMessage
      }
      session={{ reminders: { create } } as unknown as RelaySession}
      close={() => {}}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Set reminder" }));
  await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
  const [{ preview }] = create.mock.calls[0] as unknown as [
    { preview: string },
  ];
  expect(() => encodeURIComponent(preview)).not.toThrow();
  expect(preview).toBe("a");
});

it("saves a well-formed preview from a signed agent message holding a lone surrogate", async () => {
  // The signed wire text is well formed; its JSON body escapes a lone half
  // emoji, which decoding turns into real message text.
  const key = keypair();
  const wire = eventDto(
    JSON.parse(
      JSON.stringify(
        signed(key, {
          kind: 40002,
          tags: [["h", "room"]],
          content: JSON.stringify({ content: "a \ud83d" }),
        }),
      ),
    ),
  );
  const [message] = foldMessages("room", key.pubkey, [wire]);
  assert(message);
  expect(message.content).toBe("a \ud83d");
  const create = vi.fn(async () => {});
  render(
    <RemindDialog
      message={message}
      session={{ reminders: { create } } as unknown as RelaySession}
      close={() => {}}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Set reminder" }));
  await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
  const [{ preview }] = create.mock.calls[0] as unknown as [
    { preview: string },
  ];
  expect(() => encodeURIComponent(preview)).not.toThrow();
  expect(preview).toBe("a \uFFFD");
});

function dialog(
  create: (...args: unknown[]) => Promise<void>,
  close = vi.fn(),
) {
  render(
    <RemindDialog
      message={
        {
          id: "m",
          channelId: "c",
          authorId: "a",
          content: "Review release",
        } as ChannelMessage
      }
      session={{ reminders: { create } } as unknown as RelaySession}
      close={close}
    />,
  );
  return close;
}

it("keeps coarse-pointer entry on the dialog until When is chosen", async () => {
  vi.stubGlobal("matchMedia", (media: string) => ({
    matches: media === "(pointer: coarse)",
    media,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => true,
  }));
  const user = userEvent.setup();
  const create = vi.fn(async () => {});
  dialog(create);
  await vi.waitFor(() =>
    expect(screen.getByRole("dialog", { name: "Remind me" })).toHaveFocus(),
  );
  const when = screen.getByRole("combobox", { name: "When" });
  expect(when).not.toHaveFocus();
  await user.click(when);
  expect(
    await screen.findByRole("option", { name: "In 1 hour" }),
  ).toBeVisible();
  expect(create).not.toHaveBeenCalled();
});

it("lets a preset and note be chosen before saving, and keeps the draft after failure", async () => {
  const user = userEvent.setup();
  let reject!: (reason: Error) => void;
  const create = vi.fn(
    () =>
      new Promise<void>((_, fail) => {
        reject = fail;
      }),
  );
  const close = dialog(create);
  await vi.waitFor(() =>
    expect(screen.getByRole("combobox", { name: "When" })).toHaveFocus(),
  );
  await user.keyboard("{Enter}");
  await vi.waitFor(() =>
    expect(screen.getByRole("option", { selected: true })).toHaveFocus(),
  );
  await user.keyboard("{ArrowDown}");
  await vi.waitFor(() =>
    expect(screen.getByRole("option", { name: "In 1 hour" })).toHaveFocus(),
  );
  await user.keyboard("{Enter}");
  expect(screen.getByRole("combobox", { name: "When" })).toHaveTextContent(
    "In 1 hour",
  );
  expect(create).not.toHaveBeenCalled();
  await user.type(
    screen.getByRole("textbox", { name: "Note (optional)" }),
    "Check the rollout",
  );
  await user.click(screen.getByRole("button", { name: "Set reminder" }));
  expect(create).toHaveBeenCalledWith(
    expect.objectContaining({ eventId: "m" }),
    expect.any(Number),
    "Check the rollout",
  );
  expect(screen.getByRole("button", { name: "Set reminder" })).toHaveAttribute(
    "aria-busy",
    "true",
  );
  expect(
    screen.getByRole("textbox", { name: "Note (optional)" }),
  ).toBeDisabled();
  await user.keyboard("{Escape}");
  expect(close).not.toHaveBeenCalled();
  await act(async () => reject(new Error("offline")));
  expect(screen.getByRole("alert")).toHaveTextContent("could not be saved");
  expect(screen.getByRole("textbox", { name: "Note (optional)" })).toHaveValue(
    "Check the rollout",
  );
  create.mockImplementationOnce(async () => {});
  await user.click(screen.getByRole("button", { name: "Set reminder" }));
  expect(close).toHaveBeenCalledOnce();
});

it("reveals labelled custom fields and saves a future time with the note", async () => {
  const user = userEvent.setup();
  const create = vi.fn(async () => {});
  dialog(create);
  expect(screen.queryByLabelText("Reminder date")).toBeNull();
  await vi.waitFor(() =>
    expect(screen.getByRole("combobox", { name: "When" })).toHaveFocus(),
  );
  await user.keyboard("{Enter}");
  await screen.findByRole("option", { name: "Custom date & time" });
  await vi.waitFor(() =>
    expect(screen.getByRole("option", { selected: true })).toHaveFocus(),
  );
  await user.keyboard("{End}");
  await vi.waitFor(() =>
    expect(
      screen.getByRole("option", { name: "Custom date & time" }),
    ).toHaveFocus(),
  );
  await user.keyboard("{Enter}");
  fireEvent.change(screen.getByLabelText("Reminder date"), {
    target: { value: "" },
  });
  expect(screen.getByRole("button", { name: "Set reminder" })).toBeDisabled();
  expect(screen.getByRole("status")).toHaveTextContent("in the future");
  fireEvent.change(screen.getByLabelText("Reminder date"), {
    target: { value: "2099-06-20" },
  });
  fireEvent.change(screen.getByLabelText("Reminder time"), {
    target: { value: "14:30" },
  });
  await user.type(
    screen.getByRole("textbox", { name: "Note (optional)" }),
    "Follow up",
  );
  await user.click(screen.getByRole("button", { name: "Set reminder" }));
  expect(create).toHaveBeenCalledWith(
    expect.any(Object),
    new Date("2099-06-20T14:30").getTime() / 1000,
    "Follow up",
  );
});

it("stays open after a stray outside click", async () => {
  const close = vi.fn();
  render(
    <RemindDialog
      message={
        {
          id: "m",
          channelId: "c",
          authorId: "a",
          content: "hello",
        } as unknown as ChannelMessage
      }
      session={{ reminders: { create: vi.fn() } } as unknown as RelaySession}
      close={close}
    />,
  );
  const backdrop = document.querySelector(".buzz-dialog-backdrop") as Element;
  fireEvent.pointerDown(backdrop);
  fireEvent.mouseDown(backdrop);
  fireEvent.click(backdrop);
  await Promise.resolve();
  expect(close).not.toHaveBeenCalled();
});
