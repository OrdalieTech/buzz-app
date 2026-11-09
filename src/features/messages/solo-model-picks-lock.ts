/** One scope lock also covers New chat transfers and purge, never delivery. */
export async function lockSoloModelPicks<T>(scope: string, run: () => T) {
  if (!navigator.locks) throw new Error("Window ownership is unavailable.");
  return navigator.locks.request(`buzz-solo-model-picks:${scope}`, run);
}
