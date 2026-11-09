import type { ReactNode } from "react";
import { isTauri } from "@tauri-apps/api/core";
import {
  hasIntegratedWindowControls,
  WindowControls,
} from "../../app/shell/WindowControls";
import { macTitleBarDragHandlers } from "../../app/shell/title-bar";
import { Panel } from "../../shared/design-system/ui/Panel";
import { OnboardingBees } from "./OnboardingBees";
import { useWelcomeIntro } from "./useWelcomeIntro";
import styles from "./IdentitySetup.module.css";

/** The branded full-window surface shown before someone reaches the app shell. */
export function OnboardingScreen({
  labelledBy,
  welcome = false,
  intro,
  children,
}: {
  labelledBy: string;
  welcome?: boolean;
  intro: ReactNode;
  children: ReactNode;
}) {
  const introPhase = useWelcomeIntro(welcome);
  const macDesktop = isTauri() && /Mac/i.test(navigator.platform);
  const integratedWindowControls = hasIntegratedWindowControls();
  const content = (
    <>
      <div className={styles.brand}>{intro}</div>
      <div className={styles.actions} inert={introPhase !== "done"}>
        {children}
      </div>
    </>
  );
  return (
    <main
      className={`${styles.landing} ${welcome ? `${styles.welcome} light` : styles.step}`}
      data-intro={introPhase}
      aria-labelledby={labelledBy}
      data-color-mode={welcome ? "light" : undefined}
    >
      {welcome && <OnboardingBees entering={introPhase !== "done"} />}
      <header
        className={styles.titlebar}
        data-buzz-window-drag=""
        data-tauri-drag-region={integratedWindowControls || undefined}
        {...(macDesktop ? macTitleBarDragHandlers : {})}
      >
        {!welcome && (
          <img
            className={styles.cornerMark}
            src="/welcome-bee.svg"
            alt="Buzz"
            draggable={false}
          />
        )}
        {(macDesktop || integratedWindowControls) && <WindowControls />}
      </header>
      <div className={styles.content}>
        {welcome ? (
          content
        ) : (
          <Panel as="section" shape="card">
            <div className={styles.cardContent}>{content}</div>
          </Panel>
        )}
      </div>
    </main>
  );
}
