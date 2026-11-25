import { expect, it } from "vitest";
import {
  relativeTimestamp,
  shortRelativeTimestamp,
} from "./relative-timestamp";

const now = new Date(2026, 8, 13, 12).getTime() / 1000;
it.each([
  [-60, "just now", "now"],
  [59, "just now", "now"],
  [60, "1 minute ago", "1m"],
  [3599, "59 minutes ago", "59m"],
  [3600, "1 hour ago", "1h"],
  [86399, "23 hours ago", "23h"],
  [86400, "1 day ago", "1d"],
  [604799, "6 days ago", "6d"],
  [604800, "on Sep 6", "Sep 6"],
] as const)(
  "matches Buzz's recency boundary at %s seconds",
  (age, label, short) => {
    expect(relativeTimestamp(now - age, now)).toBe(label);
    expect(shortRelativeTimestamp(now - age, now)).toBe(short);
  },
);

// Local noon keeps each calendar day the same in every time zone.
const noon = (year: number, month: number, day: number) =>
  new Date(year, month, day, 12).getTime() / 1000;
it.each([
  [
    "omits the year from the start of this year",
    noon(2026, 0, 1),
    noon(2026, 11, 31),
    "on Jan 1",
    "Jan 1",
  ],
  [
    "counts days across New Year for under a week",
    noon(2026, 11, 27),
    noon(2027, 0, 2),
    "6 days ago",
    "6d",
  ],
  [
    "adds the year to last December seen in January",
    noon(2026, 11, 27),
    noon(2027, 0, 3),
    "on Dec 27, 2026",
    "Dec 27, 2026",
  ],
  [
    "adds the year to a date years old",
    noon(2023, 10, 14),
    noon(2026, 10, 16),
    "on Nov 14, 2023",
    "Nov 14, 2023",
  ],
] as const)("%s", (_case, sent, seen, label, short) => {
  expect(relativeTimestamp(sent, seen)).toBe(label);
  expect(shortRelativeTimestamp(sent, seen)).toBe(short);
});

it("reads the year in the local time zone, not UTC", () => {
  // 11:30 PM on Dec 31, 2025 in Los Angeles, when UTC is already in 2026.
  const sent = Date.UTC(2026, 0, 1, 7, 30) / 1000;
  const seen = Date.UTC(2026, 5, 15, 19) / 1000;
  const zone = process.env.TZ;
  try {
    process.env.TZ = "America/Los_Angeles";
    expect(relativeTimestamp(sent, seen)).toBe("on Dec 31, 2025");
    expect(shortRelativeTimestamp(sent, seen)).toBe("Dec 31, 2025");
  } finally {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  }
});
