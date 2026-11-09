import { useSyncExternalStore } from "react";
import { Header } from "../../shared/design-system/ui/Header";
import { PreferenceRow } from "../../shared/design-system/ui/PreferenceRow";
import { Select } from "../../shared/design-system/ui/Select";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import {
  type FocusLength,
  type FocusPreferences,
  focusLengths,
  type Preferences,
} from "./preferences";

function Choice<T extends string>({
  title,
  subtitle,
  value,
  options,
  onChange,
}: {
  title: string;
  subtitle: string;
  value: T;
  options: readonly (readonly [T, string])[];
  onChange(value: T): void;
}) {
  return (
    <PreferenceRow
      title={title}
      subtitle={subtitle}
      trailing={
        <Select
          label={title}
          variant="compact"
          value={value}
          groups={[
            {
              label: "",
              options: options.map(([value, label]) => ({ value, label })),
            },
          ]}
          onValueChange={(next) => onChange(next as T)}
        />
      }
    />
  );
}

/** Focus's defaults in Settings → Plugins. */
export function FocusSettings({
  preferences,
  active,
}: {
  preferences: Preferences;
  active(): boolean;
}) {
  const current = useSyncExternalStore(
    preferences.subscribe,
    preferences.snapshot,
  );
  const error = useSyncExternalStore(preferences.subscribe, preferences.error);
  const set = (change: Partial<FocusPreferences>) => {
    if (active()) preferences.set(change);
  };
  return (
    <section aria-label="Focus settings">
      <Header title="Focus" />
      <SettingsGroup>
        <Choice<FocusLength>
          title="Default length"
          subtitle="Used by the Focus shortcut, ⌥F by default, and selected when you open Focus from the profile menu."
          value={current.length}
          options={focusLengths}
          onChange={(length) => set({ length })}
        />
      </SettingsGroup>
      {error && (
        <p role="alert" className="text-body-sm text-danger">
          {error}
        </p>
      )}
    </section>
  );
}
