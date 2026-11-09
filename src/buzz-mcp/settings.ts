// The settings tools: Buzz's own settings on this device, which any agent
// running here can read and change for its owner. What the settings are comes
// from the host's catalog; these tools never name one.
import type { BuzzClient } from "./client";
import type { Tool } from "./tools";

const key = {
  type: "string",
  description: "A key settings_list gives, such as appearance.mode.",
} as const;
const tool = (
  name: string,
  description: string,
  properties: Readonly<Record<string, object>>,
  required: readonly string[],
  annotations: Tool["annotations"],
): Tool => ({
  name,
  description,
  inputSchema: {
    type: "object",
    properties,
    ...(required.length ? { required } : {}),
    additionalProperties: false,
  },
  ...(annotations ? { annotations } : {}),
});

export const SETTINGS_TOOLS: readonly Tool[] = [
  tool(
    "settings_list",
    "Buzz's settings on this device that you can change for your owner when they ask: each key, its allowed values, current value and whether it is saved.",
    {},
    [],
    { readOnlyHint: true },
  ),
  tool(
    "settings_get",
    "One Buzz setting, as settings_list gives it.",
    { key },
    ["key"],
    { readOnlyHint: true },
  ),
  tool(
    "settings_set",
    "Change one Buzz setting on this device, for your owner, at once. value must be exactly one of its allowed values. The answer is the setting as it now is; saved false means it is active but could not be saved.",
    {
      key,
      value: {
        anyOf: [{ type: "string" }, { type: "integer" }, { type: "boolean" }],
        description: "One of the values settings_list allows for key.",
      },
    },
    ["key", "value"],
    { readOnlyHint: false, destructiveHint: false },
  ),
];

export const isSettingsTool = (name: string) =>
  SETTINGS_TOOLS.some((tool) => tool.name === name);

/** Runs settings tool `name` as `client`. A throw is a tool error. */
export function callSettingsTool(
  client: BuzzClient,
  name: string,
  args: Readonly<Record<string, unknown>>,
): string {
  const tool = SETTINGS_TOOLS.find((tool) => tool.name === name);
  if (!tool) throw new Error(`No tool ${name}`);
  const extra = Object.keys(args).filter(
    (arg) => !Object.hasOwn(tool.inputSchema.properties, arg),
  );
  if (extra.length)
    throw new Error(`${extra.join(", ")} cannot be used with ${name}.`);
  const { settings } = client;
  if (!settings)
    throw new Error("Buzz settings can't be changed from this connection.");
  const reply =
    name === "settings_list"
      ? settings.list()
      : name === "settings_get"
        ? settings.get(args.key)
        : settings.set(args.key, args.value);
  return JSON.stringify(reply);
}
