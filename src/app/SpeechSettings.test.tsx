// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import type {
  ListenOptions,
  RegisteredSpeechProvider,
} from "../features/speech/service";
import { SpeechSettings } from "./SpeechSettings";

afterEach(cleanup);

const EXAMPLE = "example.speech/main";
const OTHER = "other.speech/main";
const provider = (key: string, label: string) =>
  ({ key, label, description: `${label} speech.` }) as RegisteredSpeechProvider;
const choices = [provider(EXAMPLE, "Example"), provider(OTHER, "Other")];

/** The speech service as Settings uses it, with the listen held for the
 * test to drive. */
function fake(initial: string | undefined, providers = choices) {
  let backend = initial;
  const listeners = new Set<() => void>();
  let options: ListenOptions | undefined;
  const stop = vi.fn();
  const speech = {
    backend: () => backend,
    status: () => (backend ? ("ready" as const) : ("unavailable" as const)),
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    setBackend: vi.fn((key: string) => {
      backend = key;
      for (const listener of listeners) listener();
    }),
    providers: () => providers,
    statusOf: () => "ready" as const,
    listen: vi.fn((next: ListenOptions) => {
      options = next;
      return { stop, cancel: vi.fn() };
    }),
  };
  const listen = () => {
    if (!options) throw new Error("not listening");
    return options;
  };
  return { speech, listen, stop };
}

it("chooses the provider, and tries it with the community it bills", async () => {
  const user = userEvent.setup();
  const { speech, listen, stop } = fake(OTHER);
  render(
    <SpeechSettings
      speech={speech}
      community="wss://relay.example.org"
      active={() => true}
    />,
  );
  expect(screen.getByRole("radio", { name: /Other/ })).toBeChecked();
  await user.click(screen.getByRole("radio", { name: /Example/ }));
  expect(speech.setBackend).toHaveBeenCalledWith(EXAMPLE);
  expect(screen.getByRole("radio", { name: /Example/ })).toBeChecked();

  await user.click(screen.getByRole("button", { name: "Start listening" }));
  expect(speech.listen).toHaveBeenCalledWith(
    expect.objectContaining({ community: "wss://relay.example.org" }),
  );
  act(() => listen().onState?.("listening"));
  expect(screen.getByRole("status")).toHaveTextContent("Listening…");
  // The listen keeps its provider, so the choice waits for Stop.
  await user.click(screen.getByRole("radio", { name: /Other/ }));
  expect(speech.setBackend).toHaveBeenCalledOnce();
  act(() => listen().onText("hello"));
  expect(screen.getByRole("status")).toHaveTextContent("hello");
  await user.click(screen.getByRole("button", { name: "Stop" }));
  expect(stop).toHaveBeenCalledOnce();
  act(() => {
    listen().onEnd("Hello.");
    listen().onState?.("idle");
  });
  expect(screen.getByRole("status")).toHaveTextContent("Hello.");
  expect(screen.getByRole("button", { name: "Start listening" })).toBeEnabled();
  await user.click(screen.getByRole("radio", { name: /Other/ }));
  expect(speech.setBackend).toHaveBeenLastCalledWith(OTHER);
});

it("shows why a try failed", async () => {
  const user = userEvent.setup();
  const { speech, listen } = fake(EXAMPLE);
  render(
    <SpeechSettings
      speech={speech}
      community="wss://relay.example.org"
      active={() => true}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Start listening" }));
  act(() => {
    listen().onError?.("denied", "Allow the microphone.");
    listen().onState?.("idle");
  });
  expect(screen.getByRole("alert")).toHaveTextContent("Allow the microphone.");
});

it("needs a community to try a provider", () => {
  const { speech } = fake(EXAMPLE);
  render(<SpeechSettings speech={speech} active={() => true} />);
  expect(
    screen.getByRole("button", { name: "Start listening" }),
  ).toBeDisabled();
  expect(screen.getByText(/Select a community/)).toBeInTheDocument();
});

it("points to plugins when no provider is available", () => {
  const { speech } = fake(undefined, []);
  render(<SpeechSettings speech={speech} active={() => true} />);
  expect(screen.getByRole("status")).toHaveTextContent(
    "No speech provider is available",
  );
});
