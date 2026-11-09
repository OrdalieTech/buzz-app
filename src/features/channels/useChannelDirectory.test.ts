// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useMemberCounts } from "./useChannelDirectory";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

it("backs off a failed count rather than reading it again each time its row shows", async () => {
  const readMemberCounts = vi.fn(async (ids: readonly string[]) => ({
    counts: new Map(ids.filter((id) => id !== "big").map((id) => [id, 3])),
    failed: ids.filter((id) => id === "big"),
  }));
  const { result } = renderHook(() => useMemberCounts({ readMemberCounts }));
  await act(async () => result.current.show(["big", "small"]));
  expect(readMemberCounts).toHaveBeenCalledTimes(1);
  expect(result.current.counts).toEqual(new Map([["small", 3]]));
  // Scrolled past again at once: the failed row waits its turn.
  await act(async () => {
    result.current.show(["big", "small"]);
    await vi.advanceTimersByTimeAsync(200);
  });
  expect(readMemberCounts).toHaveBeenCalledTimes(1);
  // Once the back-off passes, its next showing reads it again, alone.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5_000);
    result.current.show(["big", "small"]);
    await vi.advanceTimersByTimeAsync(200);
  });
  expect(readMemberCounts).toHaveBeenCalledTimes(2);
  expect(readMemberCounts.mock.calls[1]?.[0]).toEqual(["big"]);
  // A second failure waits twice as long.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5_000);
    result.current.show(["big"]);
    await vi.advanceTimersByTimeAsync(200);
  });
  expect(readMemberCounts).toHaveBeenCalledTimes(2);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5_000);
    result.current.show(["big"]);
    await vi.advanceTimersByTimeAsync(200);
  });
  expect(readMemberCounts).toHaveBeenCalledTimes(3);
});
