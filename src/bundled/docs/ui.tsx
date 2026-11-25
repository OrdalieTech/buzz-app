import { createContext, useContext } from "react";
import type { Context } from "../../plugins/author";

type PagesUi = {
  conversation: Context["conversation"]["ui"];
  panels: Pick<Context["panels"], "useTabTitle">;
};

const Ui = createContext<PagesUi | undefined>(undefined);
export const DocsUiProvider = Ui.Provider;
export function useDocsUi() {
  const ui = useContext(Ui);
  if (!ui) throw new Error("Docs requires its host UI provider.");
  return ui;
}
