import type { Navigation } from "../navigation/controller";
import { targetKey, type OpenTarget } from "../navigation/targets";

export type HistorySelection = Readonly<{
  side: "settings" | "instructions";
  id: string;
}>;
export type HistoryPresentation = {
  active?: boolean | undefined;
  selected?: HistorySelection | undefined;
  select(selected?: HistorySelection): void;
};

/** Presentation identifiers only; the current config store still owns access. */
export function historySelection(value: unknown): HistorySelection | undefined {
  if (typeof value !== "string") return;
  const match = /^(settings|instructions)\/([0-9a-f]{64})$/.exec(value);
  return match
    ? { side: match[1] as HistorySelection["side"], id: match[2] as string }
    : undefined;
}
export const historySelectionKey = ({ side, id }: HistorySelection) =>
  `${side}/${id}`;

/** Use the host's navigation owner, never a separate dialog history stack. */
export function historyPresentation(
  navigation: Navigation,
  selected: HistorySelection | undefined,
  target: (selected?: HistorySelection) => OpenTarget,
  active = !!selected,
): HistoryPresentation {
  const entry = navigation.snapshot().entry.id;
  return {
    active,
    selected,
    select(next) {
      if (next) {
        if (navigation.snapshot().entry.id !== entry) return;
        const base = target();
        const opening = target(next);
        if (targetKey(navigation.snapshot().entry.target) === targetKey(base)) {
          void navigation.open(opening, { focus: "preserve" });
        } else {
          // Give Back a reconstructible underlying agent, even when it was
          // selected locally in the inventory rather than opened by a link.
          const openingBase = navigation.open(base, {
            replace: true,
            focus: "preserve",
          });
          const underlying = navigation.snapshot().entry.id;
          void openingBase.then((result) => {
            if (
              result.status === "opened" &&
              navigation.snapshot().entry.id === underlying
            )
              void navigation.open(opening, { focus: "preserve" });
          });
        }
      } else if (selected) {
        const closing = targetKey(target(selected));
        navigation.dismiss((visit) => targetKey(visit) === closing, target());
      }
    },
  };
}
