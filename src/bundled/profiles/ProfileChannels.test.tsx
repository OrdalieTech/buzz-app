// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Navigation } from "../../features/navigation/controller";
import type {
  ChannelList,
  ChannelQueries,
} from "../../features/relay/contracts";
import type { RelaySession } from "../../features/relay/session";
import { ProfileChannels } from "./ProfileChannels";

const person = "a".repeat(64);
const viewer = "b".repeat(64);
function fixture() {
  let list: ChannelList = { status: "loading", channels: [] };
  const listeners = new Set<() => void>();
  const refreshList = vi.fn();
  const ensureList = vi.fn();
  const channels = {
    list: () => list,
    subscribeList(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    ensureList,
    refreshList,
  } as unknown as ChannelQueries;
  const open = vi.fn(async () => ({ status: "opened" as const }));
  const navigation = { open } as unknown as Navigation;
  const session = { channels } as RelaySession;
  const update = (next: ChannelList) =>
    act(() => {
      list = next;
      for (const listener of listeners) listener();
    });
  return { session, navigation, open, update, refreshList, ensureList };
}
afterEach(cleanup);

it("shows only exact verified visible memberships, handles partial lists and opens the scoped conversation", () => {
  const f = fixture();
  render(
    <ProfileChannels
      session={f.session}
      pubkey={person}
      viewer={viewer}
      communityOrigin="https://relay.example.test"
      navigation={f.navigation}
    />,
  );
  expect(screen.getByRole("status").textContent).toContain("Loading channels");
  expect(f.ensureList).toHaveBeenCalled();
  f.update({
    status: "ready",
    coverage: "partial",
    channels: [
      {
        id: "exact",
        name: "Visible",
        channelType: "stream",
        members: [person, viewer],
      },
      {
        id: "huddle",
        name: "Hidden huddle",
        channelType: "stream",
        huddle: true,
        members: [person],
      },
      { id: "forum", name: "Forum", channelType: "forum", members: [person] },
      { id: "other", name: "Unrelated", members: [viewer] },
      { id: "unknown", name: "Unknown" },
      {
        id: "hidden",
        name: "Hidden",
        channelType: "stream",
        hidden: true,
        members: [person],
      },
      { id: "untyped-member", name: "Unknown type", members: [person] },
      { id: "untyped-unrelated", name: "Unrelated type", members: [viewer] },
      { id: "dm", name: "Direct", channelType: "dm", members: [person] },
      {
        id: "chat",
        name: "Child",
        channelType: "solo",
        members: [person],
      },
      { id: "archived", name: "Archived", archived: true, members: [person] },
    ],
  });
  expect(screen.getByRole("button", { name: /^Visible$/ })).toBeTruthy();
  expect(screen.getByRole("button", { name: /^Forum$/ })).toBeTruthy();
  expect(
    screen.getByText(/Some memberships for this identity are unclassified/),
  ).toBeTruthy();
  expect(
    screen.queryByText(/Unrelated|Unknown type|Hidden|Archived|Direct|Child/),
  ).toBeNull();
  expect(screen.queryByText("Hidden huddle")).toBeNull();
  expect(screen.getByText(/More channels may exist/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /^Visible$/ }));
  expect(f.open).toHaveBeenCalledWith({
    version: 1,
    kind: "conversation",
    channelId: "exact",
    scope: { viewer, communityOrigin: "https://relay.example.test" },
  });
  f.update({ status: "ready", channels: [] });
  expect(screen.getByText(/no channels/i)).toBeTruthy();
});

it("does not invent a route, and retries failed discovery without claiming a complete empty result", () => {
  const f = fixture();
  render(
    <ProfileChannels
      session={f.session}
      pubkey={person}
      viewer={viewer}
      communityOrigin={undefined}
      navigation={f.navigation}
    />,
  );
  f.update({
    status: "error",
    channels: [
      { id: "known", name: "Known", channelType: "stream", members: [person] },
    ],
  });
  expect(screen.getByRole("alert")).toBeTruthy();
  expect(screen.getByText("Known")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Known/ })).toBeNull();
  expect(screen.getByText(/Channel navigation is unavailable/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Retry channels" }));
  expect(f.refreshList).toHaveBeenCalledOnce();
  expect(f.open).not.toHaveBeenCalled();
});

it("renders a verified row without a destination when navigation is unavailable", () => {
  const f = fixture();
  render(
    <ProfileChannels
      session={f.session}
      pubkey={person}
      viewer={viewer}
      communityOrigin="https://relay.example.test"
      navigation={undefined}
    />,
  );
  f.update({
    status: "ready",
    channels: [
      { id: "known", name: "Known", channelType: "stream", members: [person] },
    ],
  });
  expect(screen.getByText("Known")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Known/ })).toBeNull();
  expect(screen.getByText(/Channel navigation is unavailable/)).toBeTruthy();
});

it("keeps classified roster rows but omits unclassified conversations after metadata failure", () => {
  const f = fixture();
  render(
    <ProfileChannels
      session={f.session}
      pubkey={person}
      viewer={viewer}
      communityOrigin="https://relay.example.test"
      navigation={f.navigation}
    />,
  );
  f.update({
    status: "error",
    channels: [
      { id: "known", name: "Known", channelType: "forum", members: [person] },
      { id: "untyped", name: "untyped", members: [person] },
      {
        id: "hidden",
        name: "Hidden",
        channelType: "stream",
        hidden: true,
        members: [person],
      },
      { id: "dm", name: "Direct", channelType: "dm", members: [person] },
      {
        id: "chat",
        name: "Child",
        channelType: "solo",
        members: [person],
      },
    ],
  });
  expect(screen.getByRole("alert")).toBeTruthy();
  expect(screen.getByRole("button", { name: /^Known$/ })).toBeTruthy();
  expect(
    screen.getByText(/Some memberships for this identity are unclassified/),
  ).toBeTruthy();
  expect(screen.queryByText(/untyped|Hidden|Direct|Child/)).toBeNull();
});

it("qualifies ready empty results when only matching unclassified memberships exist", () => {
  const f = fixture();
  render(
    <ProfileChannels
      session={f.session}
      pubkey={person}
      viewer={viewer}
      communityOrigin="https://relay.example.test"
      navigation={f.navigation}
    />,
  );
  f.update({
    status: "ready",
    channels: [{ id: "unknown", name: "Unknown", members: [person] }],
  });
  expect(screen.queryByRole("button", { name: /Unknown/ })).toBeNull();
  expect(
    screen.getByText(/No matching channels with a known visible type/),
  ).toBeTruthy();
  f.update({
    status: "ready",
    coverage: "partial",
    channels: [{ id: "unknown", name: "Unknown", members: [person] }],
  });
  expect(
    screen.getByText(/More channels may exist outside the loaded list/),
  ).toBeTruthy();
});

it("does not classify hidden, archived or DM memberships in a ready empty list", () => {
  const f = fixture();
  render(
    <ProfileChannels
      session={f.session}
      pubkey={person}
      viewer={viewer}
      communityOrigin="https://relay.example.test"
      navigation={f.navigation}
    />,
  );
  f.update({
    status: "ready",
    channels: [
      { id: "dm", name: "Direct", channelType: "dm", members: [person] },
      { id: "hidden", name: "Hidden", hidden: true, members: [person] },
      { id: "archived", name: "Archived", archived: true, members: [person] },
    ],
  });
  expect(screen.queryByText(/unclassified and omitted/)).toBeNull();
  expect(screen.getByText(/no channels/i)).toBeTruthy();
  expect(
    screen.queryByText(/No matching channels with a known visible type/),
  ).toBeNull();
  expect(f.open).not.toHaveBeenCalled();
});

it("does not show a metadata caveat for another identity's unclassified roster", () => {
  const f = fixture();
  render(
    <ProfileChannels
      session={f.session}
      pubkey={person}
      viewer={viewer}
      communityOrigin="https://relay.example.test"
      navigation={f.navigation}
    />,
  );
  f.update({
    status: "ready",
    channels: [{ id: "unknown", name: "Unknown", members: [viewer] }],
  });
  expect(screen.queryByText(/unclassified and omitted/)).toBeNull();
  expect(screen.getByText(/no channels/i)).toBeTruthy();
});
