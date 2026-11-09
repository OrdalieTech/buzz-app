import type { ReactNode } from "react";
import styles from "./IdentitySetup.module.css";
import { OnboardingScreen } from "./OnboardingScreen";

// First-run pages share the Builderlab account-card composition. The historical
// export names remain so this presentation pass does not change flow ownership.

/** A stacked group within a first-run page. */
export function WireframePanel({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-2">{children}</div>;
}

/** A first-run page titled by its `welcome-title` heading. */
export function WireframeScreen({ children }: { children: ReactNode }) {
  return (
    <OnboardingScreen
      labelledBy="welcome-title"
      intro={<div className={styles.flow}>{children}</div>}
    >
      {null}
    </OnboardingScreen>
  );
}
