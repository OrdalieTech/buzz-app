import { expect, it, vi } from "vitest";
import {
  createDeviceSettings,
  type DeviceSetting,
  type SettingValue,
} from "./device-settings";

function fake(overrides: Partial<DeviceSetting> = {}) {
  let value: SettingValue = "one";
  const write = vi.fn((next: SettingValue) => {
    value = next;
  });
  const setting: DeviceSetting = {
    key: "example.choice",
    description: "A choice.",
    schema: { type: "string", enum: ["one", "two"] },
    read: () => ({ value }),
    write,
    ...overrides,
  };
  return { setting, write };
}
const size: DeviceSetting = {
  key: "example.size",
  description: "A size.",
  schema: { type: "integer", minimum: 80, maximum: 200, multipleOf: 10 },
  read: () => ({ value: 100 }),
  write: () => {},
};

it("lists and gets each setting with its live value and saved state", () => {
  const { setting } = fake({
    applies: "Next time.",
    read: () => ({ value: "two", unsaved: "Not saved." }),
  });
  const settings = createDeviceSettings([setting, size]);
  expect(settings.list().map(({ key }) => key)).toEqual([
    "example.choice",
    "example.size",
  ]);
  expect(settings.get("example.choice")).toEqual({
    key: "example.choice",
    description: "A choice.",
    schema: { type: "string", enum: ["one", "two"] },
    applies: "Next time.",
    value: "two",
    saved: false,
    problem: "Not saved.",
  });
  expect(settings.get("example.size")).toMatchObject({
    value: 100,
    saved: true,
  });
  expect(settings.get("example.size")).not.toHaveProperty("problem");
});

it("names the settings there are when a key is unknown", () => {
  const settings = createDeviceSettings([fake().setting, size]);
  for (const key of ["example.missing", 3, undefined, "EXAMPLE.CHOICE"])
    expect(() => settings.get(key)).toThrow(
      "Settings: example.choice, example.size.",
    );
});

it("refuses keys that are malformed or used twice", () => {
  for (const key of ["choice", "Example.choice", "example.", "example.a-b"])
    expect(() => createDeviceSettings([fake({ key }).setting])).toThrow(
      /unique key/,
    );
  expect(() => createDeviceSettings([fake().setting, fake().setting])).toThrow(
    /unique key/,
  );
});

it("takes only exact values, without aliases, trimming, case or clamping", () => {
  const { setting, write } = fake();
  let current: SettingValue = 100;
  const sized = vi.fn((next: SettingValue) => {
    current = next;
  });
  const settings = createDeviceSettings([
    setting,
    { ...size, read: () => ({ value: current }), write: sized },
  ]);
  for (const value of ["Two", "two ", "", 2, null, undefined, ["two"]])
    expect(() => settings.set("example.choice", value)).toThrow(
      'example.choice takes "one", "two"',
    );
  for (const value of [79, 85, 210, 1.5, Number.NaN, Infinity, "100", true])
    expect(() => settings.set("example.size", value)).toThrow(
      "an integer from 80 to 200 in steps of 10",
    );
  expect(() => settings.set("example.missing", "two")).toThrow(
    /No Buzz setting/,
  );
  const flag = createDeviceSettings([
    {
      key: "example.flag",
      description: "A flag.",
      schema: { type: "boolean" },
      read: () => ({ value: current === 200 }),
      write: (next) => {
        current = next ? 200 : 100;
      },
    },
  ]);
  for (const value of ["true", "on", 1, 0, null])
    expect(() => flag.set("example.flag", value)).toThrow(
      "example.flag takes true or false",
    );
  expect(write).not.toHaveBeenCalled();
  expect(sized).not.toHaveBeenCalled();
  expect(flag.set("example.flag", true).value).toBe(true);
  for (const value of [80, 90, 200])
    expect(settings.set("example.size", value).value).toBe(value);
});

it("writes through the owner's setter and answers with what it reads back", () => {
  const { setting, write } = fake();
  const settings = createDeviceSettings([setting]);
  expect(settings.set("example.choice", "two")).toMatchObject({
    value: "two",
    saved: true,
  });
  expect(write).toHaveBeenCalledExactlyOnceWith("two");
  expect(settings.get("example.choice").value).toBe("two");
});

it("reports a write the owner did not take, and one it could not save", () => {
  const ignored = fake({ write: () => {} }).setting;
  expect(() => createDeviceSettings([ignored]).set(ignored.key, "two")).toThrow(
    'example.choice did not change: it is "one".',
  );
  let value: SettingValue = "one";
  let unsaved: string | null = null;
  const failing = fake({
    read: () => ({ value, unsaved }),
    write: (next) => {
      value = next;
      unsaved = "Storage is full.";
    },
  }).setting;
  expect(createDeviceSettings([failing]).set(failing.key, "two")).toMatchObject(
    {
      value: "two",
      saved: false,
      problem: "Storage is full.",
    },
  );
});

it("changes nothing once the setting's owner has stopped", () => {
  const { setting, write } = fake({ live: () => false });
  expect(() => createDeviceSettings([setting]).set(setting.key, "two")).toThrow(
    "Buzz is closing; the setting was not changed.",
  );
  expect(write).not.toHaveBeenCalled();
});
