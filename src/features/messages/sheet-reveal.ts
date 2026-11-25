import { createContext, useContext, useLayoutEffect } from "react";

/** What a quick-opening sheet needs from what it shows: when it can draw it,
 * and the reply box's placeholder, which the view's composer turns into while
 * the sheet opens. Content outside such a sheet reports to no one. */
export type SheetReveal = {
  /** The content can be drawn. Once drawn, it stays drawn. */
  ready(): void;
  placeholder(text: string): void;
};

export const SheetRevealContext = createContext<SheetReveal | undefined>(
  undefined,
);

export const useSheetReveal = () => useContext(SheetRevealContext);

/** Reports that the content can be drawn once `ready` holds. */
export function useSheetReady(ready: boolean) {
  const reveal = useSheetReveal();
  useLayoutEffect(() => {
    if (ready) reveal?.ready();
  }, [reveal, ready]);
}
