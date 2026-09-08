"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { OnboardingDiagram } from "@/components/onboarding-diagram";

import { OnboardingStepper } from "./onboarding-stepper";

export type OnboardingTab = "state" | "architecture";

// The two views want different room: the horizontal stepper is wide and short so its per-step notes
// stop crowding each other, the architecture flowchart is narrow and tall. A fixed target width per
// tab (capped to the viewport) keeps the measured height stable, so the resize has a definite box to
// animate to rather than chasing a width that depends on the height that depends on the width.
const TAB_WIDTH: Record<OnboardingTab, number> = { state: 760, architecture: 480 };

/**
 * The onboarding pipeline in one dialog, toggled between two views of the same current state: the
 * state as a horizontal stepper, and the agent architecture as a flowchart. Switching tabs resizes
 * the dialog, and that resize is animated (width and height both) so it reads as one surface changing
 * shape rather than two dialogs swapping.
 */
export function OnboardingDialog({
  open,
  tab,
  onTabChange,
  onOpenChange,
  repositoryFullName,
  state,
}: {
  open: boolean;
  tab: OnboardingTab;
  onTabChange: (tab: OnboardingTab) => void;
  onOpenChange: (open: boolean) => void;
  repositoryFullName: string | null;
  state: string | null;
}) {
  const reduceMotion = useReducedMotion();

  // Cap the target width to the viewport so the dialog never overflows on a narrow screen.
  const [viewportCap, setViewportCap] = useState(TAB_WIDTH.state);
  useLayoutEffect(() => {
    const update = () => setViewportCap(window.innerWidth - 32);
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  const width = Math.min(TAB_WIDTH[tab], viewportCap);

  // Measure the content's natural height at the fixed width, so the animated box can move to it.
  const contentRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number>();
  useLayoutEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const update = () => setHeight(el.offsetHeight);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [tab, width, open, state, repositoryFullName]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="block w-auto max-w-[95vw] gap-0 overflow-hidden p-0 sm:max-w-[95vw]">
        <motion.div
          initial={false}
          animate={reduceMotion ? undefined : { width, ...(height ? { height } : {}) }}
          style={reduceMotion ? { width } : undefined}
          transition={{ duration: 0.32, ease: [0.4, 0, 0.2, 1] }}
          className="overflow-hidden"
        >
          <div ref={contentRef} style={{ width }} className="flex flex-col gap-4 p-6">
            <div className="flex flex-col gap-1">
              <DialogTitle>Onboarding</DialogTitle>
              <DialogDescription>
                How this repository becomes a reproduction target, and where it is in that pipeline.
              </DialogDescription>
            </div>

            {/* The toggle, built from Buttons so the active view wears the accent. */}
            <div className="inline-flex w-fit gap-1 rounded-lg bg-muted p-1">
              <Button
                size="sm"
                variant={tab === "state" ? "default" : "ghost"}
                onClick={() => onTabChange("state")}
              >
                State
              </Button>
              <Button
                size="sm"
                variant={tab === "architecture" ? "default" : "ghost"}
                onClick={() => onTabChange("architecture")}
              >
                Architecture
              </Button>
            </div>

            {/* Keyed so the incoming view fades in as the box resizes to it. */}
            <motion.div key={tab} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.2 }}>
              {tab === "state" ? (
                <OnboardingStepper state={state} />
              ) : (
                <OnboardingDiagram repositoryFullName={repositoryFullName} state={state} />
              )}
            </motion.div>
          </div>
        </motion.div>
      </DialogContent>
    </Dialog>
  );
}
