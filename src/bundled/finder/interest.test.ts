// @vitest-environment jsdom
import { afterEach, expect, test } from "vitest";
import { writeView } from "../../shared/view-state";
import { noteInterest, topInterest } from "./interest";

const scope = "https://relay.example.org:viewer";
const day = 86_400;
const now = 1_800_000_000;
afterEach(() => localStorage.clear());

test("recent visits outrank old ones, searches outweigh visits, and scopes stay apart", () => {
  // Eight visits a month ago (worth 0.4 now) fade below four yesterday (3.6).
  for (let n = 0; n < 8; n++) noteInterest(scope, "old", 1, now - 30 * day);
  for (let n = 0; n < 4; n++) noteInterest(scope, "recent", 1, now - day);
  // A visit and a search here count as three visits (3).
  noteInterest(scope, "searched", 1, now);
  noteInterest(scope, "searched", 2, now);
  noteInterest("https://other.example.org:viewer", "elsewhere", 9, now);
  expect(topInterest(scope, 5, now)).toEqual(["recent", "searched", "old"]);
  expect(topInterest(scope, 1, now)).toEqual(["recent"]);
});

test("ignores saved entries it cannot read", () => {
  writeView(scope, "finder-interest", { good: [2, now], bad: "x", worse: [] });
  expect(topInterest(scope, 5, now)).toEqual(["good"]);
  writeView(scope, "finder-interest", ["not", "a", "map"]);
  expect(topInterest(scope, 5, now)).toEqual([]);
});
