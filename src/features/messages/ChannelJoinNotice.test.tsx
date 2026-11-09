// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  type ChannelLifecycleCapability,
  ChannelLifecycleUnconfirmed,
} from "../relay/channel-lifecycle";
import { ChannelJoinNotice } from "./ChannelJoinNotice";

afterEach(cleanup);

it.each([
  { guest: false, place: "channel" as const },
  { guest: true, place: "channel" as const },
  { guest: false, place: "chat" as const },
  { guest: true, place: "chat" as const },
])(
  "offers a $place preview Join only before Guest membership ($guest)",
  ({ guest, place }) => {
    const run = vi.fn();
    const started = vi.fn();
    render(
      <ChannelJoinNotice
        channelId="open"
        lifecycle={lifecycle(run)}
        joinable
        guest={guest}
        place={place}
        joinRole="guest"
        onJoin={started}
      />,
    );
    expect(
      screen.getByRole("region", { name: `Read-only ${place}` }),
    ).toHaveTextContent(
      `This ${place} is read-only${guest ? "" : ". Join to keep it in your sidebar and appear as a viewer."}`,
    );
    expect(!!screen.queryByRole("button", { name: "Join" })).toBe(!guest);
    expect(run).not.toHaveBeenCalled();
    expect(started).not.toHaveBeenCalled();
  },
);

function lifecycle(
  run: ChannelLifecycleCapability["run"],
  available = true,
): ChannelLifecycleCapability {
  return { available, run } as ChannelLifecycleCapability;
}

it.each([
  { guest: false, place: "channel" as const },
  { guest: true, place: "channel" as const },
  { guest: false, place: "chat" as const },
  { guest: true, place: "chat" as const },
])(
  "prioritizes archived $place state over guest access $guest and Join",
  ({ guest, place }) => {
    render(
      <ChannelJoinNotice
        channelId="archived"
        lifecycle={lifecycle(vi.fn())}
        joinable
        archived
        place={place}
        guest={guest}
        joinRole={guest ? "guest" : "member"}
        onJoin={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("region", { name: `Archived ${place}` }),
    ).toHaveTextContent(new RegExp(`^This ${place} is archived$`));
    expect(screen.queryByRole("button", { name: "Join" })).toBeNull();
  },
);

it("offers Join only for a joinable channel on a connection that can send it", () => {
  const run = vi.fn();
  const { rerender } = render(
    <ChannelJoinNotice
      channelId="open"
      lifecycle={lifecycle(run, false)}
      joinable
      onJoin={() => {}}
    />,
  );
  expect(
    screen.getByText("You’re previewing this channel", { exact: true }),
  ).toBeVisible();
  expect(screen.queryByRole("button", { name: "Join" })).toBeNull();
  rerender(
    <ChannelJoinNotice
      channelId="open"
      lifecycle={lifecycle(run)}
      joinable={false}
      onJoin={() => {}}
    />,
  );
  expect(screen.queryByRole("button", { name: "Join" })).toBeNull();
  expect(run).not.toHaveBeenCalled();
});

it.each(["member", "guest"] as const)(
  "joins once with %s admission and keeps a failed join retryable",
  async (joinRole) => {
    let settle: { resolve(): void; reject(error: unknown): void } | undefined;
    const run = vi.fn(
      () =>
        new Promise<void>((resolve, reject) => {
          settle = { resolve, reject };
        }),
    );
    const started = vi.fn();
    render(
      <ChannelJoinNotice
        channelId="open"
        lifecycle={lifecycle(run)}
        joinable
        joinRole={joinRole}
        onJoin={started}
      />,
    );
    const button = screen.getByRole("button", { name: "Join" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(run).toHaveBeenCalledOnce();
    // The page owns focus handoff; membership may arrive before the run settles.
    expect(started).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith("join", "open", expect.any(AbortSignal));
    expect(button).toHaveAttribute("aria-disabled", "true");
    await act(async () =>
      settle?.reject(new ChannelLifecycleUnconfirmed(new Error("timeout"))),
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Join may have taken effect, but it is not confirmed yet. Try again to check.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Join" }));
    expect(run).toHaveBeenCalledTimes(2);
    expect(started).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
    await act(async () => settle?.resolve());
    expect(screen.getByRole("button", { name: "Join" })).not.toHaveAttribute(
      "aria-disabled",
      "true",
    );
  },
);

it("waits for content once per channel and stays visible during refresh", () => {
  const props = {
    lifecycle: lifecycle(vi.fn()),
    joinable: true,
    onJoin: vi.fn(),
  };
  const { rerender } = render(
    <ChannelJoinNotice {...props} channelId="open" ready={false} />,
  );
  expect(screen.queryByRole("button", { name: "Join" })).toBeNull();
  rerender(<ChannelJoinNotice {...props} channelId="open" ready />);
  expect(screen.getByRole("button", { name: "Join" })).toBeInTheDocument();
  rerender(<ChannelJoinNotice {...props} channelId="open" ready={false} />);
  expect(screen.getByRole("button", { name: "Join" })).toBeInTheDocument();
  rerender(<ChannelJoinNotice {...props} channelId="other" ready={false} />);
  expect(screen.queryByRole("button", { name: "Join" })).toBeNull();
});
