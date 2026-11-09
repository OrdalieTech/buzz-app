// A harness Settings group: the real ModelPicker row above a Thinking row.
import { createRoot } from "react-dom/client";
import { ModelPicker } from "../../src/features/agents/ModelPicker";
import { Select } from "../../src/shared/design-system/ui/Select";
import { SettingsGroup } from "../../src/shared/design-system/ui/SettingsGroup";
import "../../src/shared/styles/globals.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");

createRoot(root).render(
  <div style={{ width: 520 }}>
    <SettingsGroup>
      <ModelPicker
        models={[{ id: "gpt-5.5", label: "GPT-5.5" }]}
        value=""
        defaultModel="gpt-5.5"
        defaultLabel="Codex default"
        onChange={() => undefined}
      />
      <Select
        label="Thinking"
        variant="preference"
        value="low"
        groups={[{ label: "", options: [{ value: "low", label: "Low" }] }]}
        onValueChange={() => undefined}
      />
    </SettingsGroup>
  </div>,
);
