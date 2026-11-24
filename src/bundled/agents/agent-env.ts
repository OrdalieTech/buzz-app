import { invoke, isTauri } from "@tauri-apps/api/core";
import { pubkeyOf, type AgentKey } from "../../features/agents/membership";

async function envNames(
  agent: { agent: string } | Record<string, never>,
): Promise<readonly string[] | undefined> {
  if (!isTauri()) return [];
  try {
    const status = await invoke<{ names: string[] } | null>(
      "agent_env_status",
      agent,
    );
    return status?.names ?? [];
  } catch {
    return undefined;
  }
}

/** The names of the local agent's own environment variables, read fresh
 * from native; `undefined` when they can't be read. Only names are known
 * here: values stay native. Without native (tests, browsers) there are none. */
export const ownEnvNames = (pubkey: string) => envNames({ agent: pubkey });

/** The names of the device list's variables, as `ownEnvNames`. */
export const deviceEnvNames = () => envNames({});

/** Whether `names` holds `name`, ignoring case on Windows as native does. */
export const hasName = (names: readonly string[], name: string) =>
  navigator.platform.startsWith("Win")
    ? names.some((other) => other.toUpperCase() === name.toUpperCase())
    : names.includes(name);

/** Fires after the device list is saved, so an agent page beneath Settings
 * can read its names again. */
export const deviceEnvSaved = new EventTarget();

/** Whether the local agent has environment variables of its own, as
 * `ownEnvNames` reads them. */
export async function hasOwnEnv(agent: AgentKey): Promise<boolean | undefined> {
  const names = await ownEnvNames(pubkeyOf(agent));
  return names && names.length > 0;
}

/** Agents whose saved list changed since their processes last restarted.
 * Lives as long as the window: a reload stops every agent's processes. */
export const awaitingRestart = new Set<string>();
