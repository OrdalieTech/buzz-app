// Buzz preferences on this device that agents can read and change. Each is
// defined by the feature that owns it and changes
// only through that feature's own setter, so the UI, storage and every window
// see the change as if the owner had made it.

export type SettingValue = string | number | boolean;
/** The exact values a setting takes: no aliases, case folding or clamping. */
export type SettingSchema =
  | Readonly<{ type: "string"; enum: readonly string[] }>
  | Readonly<{ type: "boolean" }>
  | Readonly<{
      type: "integer";
      minimum: number;
      maximum: number;
      multipleOf: number;
    }>;
export type DeviceSetting = Readonly<{
  /** Stable, `area.name`. */
  key: string;
  description: string;
  schema: SettingSchema;
  /** When a change takes effect, if not at once. */
  applies?: string;
  /** The live value, and why it is not saved on this device when it isn't. */
  read(): Readonly<{ value: SettingValue; unsaved?: string | null }>;
  /** Applies and saves `value`, which the schema has already admitted. */
  write(value: SettingValue): void;
  /** False once its owner has stopped, when a write would change nothing. */
  live?(): boolean;
}>;
export type SettingState = Readonly<{
  key: string;
  description: string;
  schema: SettingSchema;
  applies?: string;
  value: SettingValue;
  saved: boolean;
  problem?: string;
}>;
export type DeviceSettings = ReturnType<typeof createDeviceSettings>;

const KEY = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

export function createDeviceSettings(definitions: readonly DeviceSetting[]) {
  const byKey = new Map<string, DeviceSetting>();
  for (const definition of definitions) {
    if (!KEY.test(definition.key) || byKey.has(definition.key))
      throw new Error(`Device setting ${definition.key} needs a unique key`);
    byKey.set(definition.key, definition);
  }
  const state = (definition: DeviceSetting): SettingState => {
    const { value, unsaved } = definition.read();
    return {
      key: definition.key,
      description: definition.description,
      schema: definition.schema,
      ...(definition.applies ? { applies: definition.applies } : {}),
      value,
      saved: !unsaved,
      ...(unsaved ? { problem: unsaved } : {}),
    };
  };
  const find = (key: unknown) => {
    const definition = typeof key === "string" ? byKey.get(key) : undefined;
    if (!definition)
      throw new Error(
        `No Buzz setting ${JSON.stringify(key)}. Settings: ${[...byKey.keys()].join(", ")}.`,
      );
    return definition;
  };
  return {
    list: () => [...byKey.values()].map(state),
    get: (key: unknown) => state(find(key)),
    /** Sets `key` to `value` when it is exactly one of its values and reads
     * it back; throws otherwise, having changed nothing. Synchronous, so a
     * check just before it holds until it returns. */
    set(key: unknown, value: unknown): SettingState {
      const definition = find(key);
      const { schema } = definition;
      const ok =
        schema.type === "string"
          ? typeof value === "string" && schema.enum.includes(value)
          : schema.type === "boolean"
            ? typeof value === "boolean"
            : typeof value === "number" &&
              Number.isInteger(value) &&
              value >= schema.minimum &&
              value <= schema.maximum &&
              (value - schema.minimum) % schema.multipleOf === 0;
      if (!ok)
        throw new Error(
          `${definition.key} takes ${
            schema.type === "string"
              ? schema.enum.map((option) => JSON.stringify(option)).join(", ")
              : schema.type === "boolean"
                ? "true or false"
                : `an integer from ${schema.minimum} to ${schema.maximum} in steps of ${schema.multipleOf}`
          }, not ${JSON.stringify(value)}.`,
        );
      if (definition.live?.() === false)
        throw new Error("Buzz is closing; the setting was not changed.");
      definition.write(value as SettingValue);
      const after = state(definition);
      if (after.value !== value)
        throw new Error(
          `${definition.key} did not change: it is ${JSON.stringify(after.value)}.`,
        );
      return after;
    },
  };
}
