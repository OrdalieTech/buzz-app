import type { NotificationCategory } from "./preferences";

/** Bundled alert sounds under public/sounds, shared with the reference client. */
export const SOUND_NAMES = [
  "bong",
  "boo",
  "dng",
  "doo",
  "doodone",
  "doong",
  "doop",
  "flirl",
  "flutter",
  "oh-no",
  "ping",
  "soft",
  "unison",
] as const;
export type SoundName = (typeof SOUND_NAMES)[number] | "silent";
const SOUND_NAME_SET: ReadonlySet<string> = new Set(SOUND_NAMES);
export function isSoundName(value: unknown): value is SoundName {
  return (
    value === "silent" ||
    (typeof value === "string" && SOUND_NAME_SET.has(value))
  );
}

export const DEFAULT_SOUND: SoundName = "flutter";

export type CategorySounds = Readonly<Record<NotificationCategory, SoundName>>;
export const DEFAULT_CATEGORY_SOUNDS: CategorySounds = Object.freeze({
  mention: DEFAULT_SOUND,
  direct: DEFAULT_SOUND,
  thread: DEFAULT_SOUND,
  agent: DEFAULT_SOUND,
});

/** Row copy and recommendations reuse the reference client's event rows. */
export const CATEGORY_SOUND_LABELS: Record<NotificationCategory, string> = {
  direct: "Direct messages",
  mention: "@Mentions",
  thread: "Thread replies",
  agent: "Solo chat completions",
};
export const RECOMMENDED_SOUND_BY_CATEGORY: Record<
  NotificationCategory,
  SoundName
> = {
  direct: "unison",
  mention: "ping",
  thread: "doop",
  agent: "doodone",
};

/** Plugin categories have no per-category choice; they use the default sound. */
export function resolveCategorySound(
  sounds: CategorySounds,
  category: string,
): SoundName {
  return (
    (sounds as Partial<Record<string, SoundName>>)[category] ?? DEFAULT_SOUND
  );
}

const cache = new Map<SoundName, HTMLAudioElement>();

function getAudio(name: SoundName): HTMLAudioElement {
  let audio = cache.get(name);
  if (!audio) {
    audio = new Audio(`/sounds/${name}.mp3`);
    cache.set(name, audio);
  }
  return audio;
}

export function playNotificationSound(
  name: SoundName,
): HTMLAudioElement | null {
  if (name === "silent") return null;
  try {
    const audio = getAudio(name);
    audio.currentTime = 0;
    audio.play().catch(() => {
      // Best-effort — user may not have interacted with the page yet.
    });
    return audio;
  } catch {
    // Best-effort only.
    return null;
  }
}
