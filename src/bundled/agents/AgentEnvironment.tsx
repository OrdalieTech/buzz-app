import { invoke, isTauri } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { DotsThreeIcon, PlusIcon } from "../../shared/design-system/icons";
import { Badge } from "../../shared/design-system/ui/Badge";
import { AlertDialog } from "../../shared/design-system/ui/AlertDialog";
import { Button } from "../../shared/design-system/ui/Button";
import { InlineHeader } from "../../shared/design-system/ui/Header";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { Input } from "../../shared/design-system/ui/Input";
import {
  MenuItem,
  MenuPopup,
  MenuRoot,
  MenuTrigger,
} from "../../shared/design-system/ui/Menu";
import { SettingsGroup } from "../../shared/design-system/ui/SettingsGroup";
import { useToastNotification } from "../../shared/design-system/ui/Toast";
import { useAgentSaveState } from "../../features/agents/AgentSaveButton";
import { SettingsSectionLink } from "../../features/navigation/SettingsSectionLink";
import {
  awaitingRestart,
  deviceEnvNames,
  deviceEnvSaved,
  hasName,
} from "./agent-env";
import styles from "./AgentEnvironment.module.css";

type Status = { names: string[]; saved?: boolean };
/** The one row open for editing: a saved name to replace, or a new one. */
type Draft = { replacing?: string; name: string; value: string };

// One set of tracks for every row, so the columns line up: the name takes
// the room, Value fits the Saved pill and the actions fit the ⋯ menu.
const ROW =
  "grid grid-cols-[minmax(0,1fr)_6.5rem_1.75rem] items-center gap-2 px-3 py-2";

type Props =
  | {
      agent: string;
      /** Stops the agent's processes, so its next turn starts with the list. */
      restartAgent: () => Promise<void>;
      /** Opens a Settings section, for the link to the device-wide list. */
      openSettings?: ((section: string) => void) | undefined;
    }
  | { agent?: undefined; restartAgent?: undefined; openSettings?: undefined };

const AGENT_WORDS = {
  restart: "Restart agent",
  saved: "Changes saved. Restart the agent to apply them.",
  confirm: "Restart this agent?",
  consequence:
    "Its processes stop, and its next message starts them with the saved environment variables. Other agents keep running.",
};
const DEVICE_WORDS = {
  restart: "Restart agents",
  saved: "Changes saved. Restart agents to apply them.",
  confirm: "Restart agents?",
  consequence:
    "Buzz reloads, which ends calls and turns in progress. Each agent's next message starts it with the saved environment variables.",
};

/** Variables one local agent starts with, or without `agent` every local
 * agent on this device, held natively in the OS credential store. Values are
 * never read back. */
export function AgentEnvironment({ agent, restartAgent, openSettings }: Props) {
  // Every local agent restarts with the page, which ends its processes.
  const run = restartAgent ?? (async () => window.location.reload());
  const words = agent ? AGENT_WORDS : DEVICE_WORDS;
  // Names also on the device list, which this agent's values override.
  const [device, setDevice] = useState<readonly string[]>([]);
  const [names, setNames] = useState<string[] | undefined>();
  const [draft, setDraft] = useState<Draft | undefined>();
  const [restarting, setRestarting] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [pending, setPending] = useState(false);
  // Outlives this editor, so leaving and coming back keeps the restart offer.
  const [saved, setSaved] = useState(
    () => !!agent && awaitingRestart.has(agent),
  );
  const [confirm, setConfirm] = useState(false);
  const restart = useRef<HTMLButtonElement>(null);
  const notify = useToastNotification();
  // Leaving the agent with a row open asks first; during a save or a
  // restart it waits, so a failed restart's error is never lost.
  useAgentSaveState(!!draft, pending || restarting);
  const fetch = useCallback(() => {
    setError(undefined);
    // Hosts without the native list (test fixtures) answer nothing.
    invoke<Status | null>("agent_env_status", { agent }).then(
      (status) => {
        if (!status) return;
        setNames(status.names);
        // Saved since this page loaded, so running agents may have the old list.
        // Only the device list: an agent's own restart never clears this flag.
        if (status.saved && !agent) setSaved(true);
      },
      (reason: unknown) => setError(String(reason)),
    );
  }, [agent]);
  useEffect(() => {
    if (isTauri()) fetch();
  }, [fetch]);
  // Settings opens over the agent's page, so a device save there is read again.
  useEffect(() => {
    if (!agent) return;
    const read = () =>
      void deviceEnvNames().then((names) => setDevice(names ?? []));
    read();
    deviceEnvSaved.addEventListener("saved", read);
    return () => deviceEnvSaved.removeEventListener("saved", read);
  }, [agent]);
  // An unreadable list is never shown as an empty one.
  if (!names)
    return error ? (
      <div className="mt-section-gap">
        <InlineHeader title="Environment variables" />
        <p role="alert" className="m-0 mb-2 text-body-sm">
          {error}
        </p>
        <Button size="sm" onClick={fetch}>
          Retry
        </Button>
      </div>
    ) : null;
  // Nothing changes the list while a save or a restart runs: a save during
  // a restart could miss the process the restart starts.
  const locked = pending || restarting;
  /** Writes the whole list; a `null` value keeps that row's saved value. */
  const write = async (
    rows: { name: string; value: string | null }[],
    done: string,
  ) => {
    setPending(true);
    setError(undefined);
    try {
      await invoke("agent_env_set", { agent, rows });
      // Stored now, even if the reload below fails.
      if (agent) awaitingRestart.add(agent);
      else deviceEnvSaved.dispatchEvent(new Event("saved"));
      setSaved(true);
      setNames((await invoke<Status>("agent_env_status", { agent })).names);
      setDraft(undefined);
      notify(done, "success");
    } catch (reason) {
      setError(String(reason));
      // Outlives this editor, so a save that fails after Settings closes is
      // still said; fixed text, never a name or value.
      notify("Couldn't save environment variables", "error");
    } finally {
      setPending(false);
    }
  };
  const save = (open: Draft) => {
    const name = open.replacing ?? open.name.trim();
    const rows = names.map((other) => ({
      name: other,
      value: other === open.replacing ? open.value : null,
    }));
    void write(
      open.replacing ? rows : [...rows, { name, value: open.value }],
      "Saved",
    );
  };
  const remove = (name: string) =>
    void write(
      names
        .filter((other) => other !== name)
        .map((other) => ({ name: other, value: null })),
      "Removed",
    );
  const editor = (open: Draft) => (
    <form
      key={open.replacing ?? "new"}
      className={ROW}
      onSubmit={(event) => {
        event.preventDefault();
        save(open);
      }}
    >
      {open.replacing ? (
        <span
          className="truncate font-mono text-body-sm"
          title={open.replacing}
        >
          {open.replacing}
        </span>
      ) : (
        <Input
          aria-label="Variable name"
          controlSize="sm"
          placeholder="NAME"
          value={open.name}
          disabled={locked}
          autoFocus
          autoCapitalize="off"
          spellCheck={false}
          onValueChange={(name) => setDraft({ ...open, name })}
        />
      )}
      <span className="col-span-2">
        <Input
          aria-label={`Value of ${open.replacing ?? (open.name.trim() || "new variable")}`}
          controlSize="sm"
          type="password"
          placeholder={open.replacing ? "New value" : "Value"}
          value={open.value}
          disabled={locked}
          autoFocus={!!open.replacing}
          autoComplete="off"
          onValueChange={(value) => setDraft({ ...open, value })}
        />
      </span>
      {/* Save and Cancel get their own line; the columns stay narrow. */}
      <span className="col-span-3 flex items-center justify-end gap-1">
        <Button
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() => {
            setDraft(undefined);
            setError(undefined);
          }}
        >
          Cancel
        </Button>
        <Button
          type="submit"
          size="sm"
          variant="prominent"
          disabled={open.replacing ? !open.value : !open.name.trim()}
          loading={pending}
        >
          Save
        </Button>
      </span>
    </form>
  );
  return (
    <div className="mt-section-gap">
      <InlineHeader
        title="Environment variables"
        subtitle={
          agent ? (
            // One inline run, so the link wraps with the sentence.
            <span>
              Variables this agent starts with. They override the{" "}
              <SettingsSectionLink section="agents" open={openSettings}>
                device-wide variables
              </SettingsSectionLink>{" "}
              with the same name.
            </span>
          ) : (
            "Variables every local agent on this device starts with."
          )
        }
        actions={
          <Button
            size="sm"
            disabled={locked || !!draft}
            onClick={() => setDraft({ name: "", value: "" })}
          >
            <PlusIcon size={17} aria-hidden="true" />
            Add variable
          </Button>
        }
      />
      <SettingsGroup>
        {names.length === 0 && !draft ? (
          <p className="m-0 px-3 py-4 text-center text-body-sm text-subtle">
            No variables yet
          </p>
        ) : (
          <div
            className={`${ROW} ${styles.headings} text-caption text-subtle`}
            aria-hidden="true"
          >
            <span>Variable</span>
            <span>Value</span>
            <span />
          </div>
        )}
        {names.map((name) =>
          draft?.replacing === name ? (
            editor(draft)
          ) : (
            <div key={name} className={ROW}>
              <span className="flex min-w-0 flex-col">
                <span className="truncate font-mono text-body-sm" title={name}>
                  {name}
                </span>
                {hasName(device, name) && (
                  <span className="truncate text-caption text-subtle">
                    Overrides the device-wide value
                  </span>
                )}
              </span>
              <span>
                <Badge>
                  <span aria-hidden="true">•••••• </span>Saved
                </Badge>
              </span>
              <span className="flex justify-end">
                <MenuRoot>
                  <MenuTrigger
                    render={
                      <IconButton
                        aria-label={`${name} actions`}
                        title={`${name} actions`}
                        icon={<DotsThreeIcon size={16} aria-hidden="true" />}
                        disabled={locked || !!draft}
                      />
                    }
                  />
                  <MenuPopup align="end" size="compact">
                    <MenuItem
                      onClick={() =>
                        setDraft({ replacing: name, name, value: "" })
                      }
                    >
                      Replace
                    </MenuItem>
                    <MenuItem tone="danger" onClick={() => remove(name)}>
                      Remove
                    </MenuItem>
                  </MenuPopup>
                </MenuRoot>
              </span>
            </div>
          ),
        )}
        {draft && !draft.replacing && editor(draft)}
      </SettingsGroup>
      {error && (
        <p role="alert" className="m-0 mt-2 text-body-sm">
          {error}
        </p>
      )}
      {saved && (
        <div className="mt-2">
          <SettingsGroup>
            <div className="flex items-center justify-between gap-3 px-3 py-2">
              <p role="status" className="m-0 text-body-sm">
                {words.saved}
              </p>
              <Button
                ref={restart}
                size="sm"
                // A restart would race a save, or drop an open row.
                disabled={locked || !!draft}
                loading={restarting}
                focusableWhenDisabled
                onClick={() => setConfirm(true)}
              >
                {words.restart}
              </Button>
            </div>
          </SettingsGroup>
        </div>
      )}
      {confirm && (
        <AlertDialog
          title={words.confirm}
          description={words.consequence}
          finalFocus={restart}
          onClose={() => setConfirm(false)}
          actions={
            <>
              <Button onClick={() => setConfirm(false)}>Cancel</Button>
              <Button
                variant="prominent"
                onClick={() => {
                  setConfirm(false);
                  setRestarting(true);
                  setError(undefined);
                  run()
                    .then(() => {
                      if (agent) awaitingRestart.delete(agent);
                      setSaved(false);
                    })
                    .catch((reason: unknown) =>
                      setError(
                        reason instanceof Error
                          ? reason.message
                          : String(reason),
                      ),
                    )
                    .finally(() => setRestarting(false));
                }}
              >
                Restart
              </Button>
            </>
          }
        />
      )}
    </div>
  );
}
