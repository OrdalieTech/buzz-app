// The SKILL.md skills in a local harness's skill folders (`AgentType.
// skillFolders`), the list the composer's `/` offers, for a model router.
import { invoke, isTauri } from "@tauri-apps/api/core";

export type LocalSkill = Readonly<{
  name: string;
  description: string;
  path: string;
  displayPath: string;
}>;

/** The skills in `roots`, by their front matter; none outside the app. */
export async function localSkills(
  roots: readonly string[],
): Promise<readonly LocalSkill[]> {
  if (!roots.length || !isTauri()) return [];
  return invoke<readonly LocalSkill[]>("local_skills_list", { roots });
}
