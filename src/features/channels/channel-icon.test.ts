import { expect, it } from "vitest";
import {
  ChatCircleIcon,
  HashIcon,
  LockIcon,
} from "../../shared/design-system/icons/index";
import { channelIcon, channelIconLabel, channelText } from "./channel-icon";

it("shows a channel as the sidebar does: a hash, a lock, or a chat bubble", () => {
  expect(channelIcon({})).toBe(HashIcon);
  expect(channelIcon(undefined)).toBe(HashIcon);
  expect(channelIcon({ private: true })).toBe(LockIcon);
  expect(channelIcon({ channelType: "dm" })).toBe(ChatCircleIcon);
  expect(channelIcon({ channelType: "solo", private: true })).toBe(
    ChatCircleIcon,
  );
});

it("names what a channel's icon shows", () => {
  expect(channelIconLabel({})).toBe("Public channel");
  expect(channelIconLabel({ private: true, channelType: "forum" })).toBe(
    "Private channel",
  );
  expect(channelIconLabel({ channelType: "dm", private: true })).toBe(
    "Direct message",
  );
  expect(channelIconLabel({ channelType: "solo", private: true })).toBe("Chat");
});

it("prefixes a channel's name with # only where its icon is a hash", () => {
  expect(channelText({ name: "general" })).toBe("#general");
  expect(channelText({ name: "plans", private: true })).toBe("plans");
  expect(channelText({ name: "Pinky", channelType: "dm" })).toBe("Pinky");
  expect(
    channelText({ name: "Notes", channelType: "solo", private: true }),
  ).toBe("Notes");
});
