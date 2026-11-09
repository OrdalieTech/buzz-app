// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { ProfileStep } from "./ProfileStep";

const found = {
  url: "https://relay.example.com",
  host: "relay.example.com",
};
const none = {
  existing: {},
  profile: { name: "", picture: "", about: "" },
  exists: false,
};
function deferred() {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
function step(props: Partial<ComponentProps<typeof ProfileStep>> = {}) {
  const onContinue = vi.fn<ComponentProps<typeof ProfileStep>["onContinue"]>(
    () => Promise.resolve(),
  );
  render(
    <ProfileStep
      found={found}
      read={none}
      defaultName="ada"
      onContinue={onContinue}
      {...props}
    />,
  );
  return { onContinue, user: userEvent.setup() };
}
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it("suggests and focuses the default name, needs a name to continue, and hands the trimmed profile to Continue", async () => {
  const { onContinue, user } = step();
  const name = screen.getByRole("textbox", { name: "Display name" });
  expect(screen.getByText(found.url)).toBeVisible();
  expect(name).toHaveValue("ada");
  expect(name).toHaveFocus();
  await user.clear(name);
  expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
  await user.type(name, " Ada ");
  expect(
    screen.queryByRole("textbox", { name: "Profile description (optional)" }),
  ).toBeNull();
  await user.click(screen.getByRole("button", { name: "Continue" }));
  expect(onContinue).toHaveBeenCalledExactlyOnceWith({
    name: "Ada",
    picture: "",
    about: "",
  });
});

it("prefills a relay profile and hands it to Continue as it is", async () => {
  const profile = { name: "Ada", picture: "", about: "Hi" };
  const { onContinue, user } = step({
    read: { existing: { name: "Ada", about: "Hi" }, profile, exists: true },
    defaultName: "ignored",
  });
  expect(screen.getByRole("textbox", { name: "Display name" })).toHaveValue(
    "Ada",
  );
  await user.click(screen.getByRole("button", { name: "Continue" }));
  expect(onContinue).toHaveBeenCalledExactlyOnceWith(profile);
});

it("holds Continue while Continue runs, and a rejection stays on the step with the error inline and the draft kept", async () => {
  const gate = deferred();
  const { onContinue, user } = step();
  onContinue.mockReturnValueOnce(gate.promise);
  const name = screen.getByRole("textbox", { name: "Display name" });
  await user.clear(name);
  await user.type(name, "Ada{Enter}");
  expect(onContinue).toHaveBeenCalledOnce();
  expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
  expect(screen.queryByRole("button", { name: "Go back" })).toBeNull();
  expect(name).toBeDisabled();
  gate.reject(
    new Error(
      "Your profile change is not current. Your edits are retained; try again.",
    ),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Your profile change is not current. Your edits are retained; try again.",
  );
  expect(name).toHaveValue("Ada");
  expect(name).toBeEnabled();
  expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled();
  expect(screen.queryByRole("button", { name: "Go back" })).toBeNull();
});

it("keeps the draft after denied access without offering a misleading Back action", async () => {
  const { onContinue, user } = step();
  onContinue.mockRejectedValueOnce(new Error("Relay read failed (403)"));
  await user.click(screen.getByRole("button", { name: "Continue" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "relay.example.com no longer admits this key. Ask a community administrator to restore your access.",
  );
  expect(screen.queryByRole("button", { name: "Go back" })).toBeNull();
  expect(screen.getByRole("textbox", { name: "Display name" })).toHaveValue(
    "ada",
  );
});
