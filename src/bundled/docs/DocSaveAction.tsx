import type { ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Button } from "../../shared/design-system/ui/Button";
import styles from "./WorkingDocs.module.css";

export function DocSaveAction({
  shown,
  loading,
  disabled,
  onClick,
  children,
}: {
  shown: boolean;
  loading: boolean;
  disabled?: boolean;
  onClick(): void;
  children: ReactNode;
}) {
  const reducedMotion = useReducedMotion();
  const instant =
    reducedMotion ||
    document.documentElement.hasAttribute("data-keyboard-navigation");
  return (
    <AnimatePresence initial={false}>
      {shown && (
        <motion.div
          key="save"
          className={styles.saveAction}
          initial={{ width: 0, opacity: 0, x: -4, overflow: "hidden" }}
          animate={{
            width: "auto",
            opacity: 1,
            x: 0,
            overflow: "hidden",
            // A settled clip can crop fractional button bounds in WebKit.
            transitionEnd: { overflow: "visible" },
          }}
          exit={{ width: 0, opacity: 0, x: -4, overflow: "hidden" }}
          transition={{
            duration: instant ? 0 : 0.22,
            ease: [0.2, 0.8, 0.2, 1],
          }}
        >
          <Button
            variant="prominent"
            size="sm"
            loading={loading}
            disabled={disabled}
            onClick={onClick}
          >
            {children}
          </Button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
