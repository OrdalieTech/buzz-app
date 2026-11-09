// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useWorkStops } from "./use-work-stops";
import type { WorkStop } from "./work-stop";

const notify = vi.hoisted(() => vi.fn());
vi.mock("../../shared/design-system/ui/Toast", () => ({
  useToastNotification: () => notify,
}));
afterEach(() => {
  cleanup();
  notify.mockClear();
});

it("reports a rejected Stop even after its indicator retires", async () => {
  let reject!: (error: Error) => void;
  const control: WorkStop = {
    key: "request",
    lifecycle: true,
    interrupt: () =>
      new Promise<void>((_resolve, fail) => {
        reject = fail;
      }),
  };
  function Indicator() {
    const { stop } = useWorkStops([control]);
    return (
      <button type="button" onClick={() => void stop(control, "Agent")}>
        Stop
      </button>
    );
  }
  const view = render(<Indicator />);
  fireEvent.click(screen.getByRole("button", { name: "Stop" }));
  view.unmount();
  await act(async () => reject(new Error("Connection lost")));
  expect(notify).toHaveBeenCalledExactlyOnceWith(
    "Couldn’t stop Agent. Connection lost",
    "error",
  );
});
