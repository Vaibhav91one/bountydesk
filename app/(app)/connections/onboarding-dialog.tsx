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
 * shape rather than two dialogs swapping. The box is capped to the viewport and scrolls past that, so
 * the tall flowchart is never cut off on a short screen.
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

  // The box is capped to the viewport: the width so it never overflows sideways, the height so a tall
  // flowchart scrolls inside the dialog instead of running off a short screen.
  const [cap, setCap] = useState({ w: TAB_WIDTH.state, h: 720 });
  useLayoutEffect(() => {
    const update = () => setCap({ w: window.innerWidth - 32, h: window.innerHeight - 48 });
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  const width = Math.min(TAB_WIDTH[tab], cap.w);

  // Measure the content's natural height at the fixed width, then cap it: the box animates to the
  // capped value and the content scrolls when it is taller.
  const contentRef = useRef<HTMLDivElement>(null);
  const [natural, setNatural] = useState<number>();
  useLayoutEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const update = () => setNatural(el.offsetHeight);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [tab, width, open, state, repositoryFullName]);
  const height = natural ? Math.min(natural, cap.h) : undefined;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="block w-auto max-w-[95vw] gap-0 overflow-hidden p-0 sm:max-w-[95vw]">
        <motion.div
          initial={false}
          animate={reduceMotion ? undefined : { width, ...(height ? { height } : {}) }}
          style={reduceMotion ? { width, height } : undefined}
          transition={{ duration: 0.32, ease: [0.4, 0, 0.2, 1] }}
          className="overflow-x-hidden overflow-y-auto"
        >
          <div ref={contentRef} style={{ width }} className="flex flex-col gap-4 p-6">
            <div className="flex flex-col gap-1">
              <DialogTitle>Onboarding</DialogTitle>
              <DialogDescription>
                How this repository becomes a reproduction target, and where it is in that pipeline.
              </DialogDescription>
            </div>

            <div role="group" aria-label="Onboarding view" className="inline-flex w-fit gap-1 rounded-lg bg-muted p-1">
              <Button
                size="sm"
                variant={tab === "state" ? "default" : "ghost"}
                aria-pressed={tab === "state"}
                onClick={() => onTabChange("state")}
              >
                State
              </Button>
              <Button
                size="sm"
                variant={tab === "architecture" ? "default" : "ghost"}
                aria-pressed={tab === "architecture"}
                onClick={() => onTabChange("architecture")}
              >
                Architecture
              </Button>
            </div>

            {/* Keyed so the incoming view fades in as the box resizes to it; the fade is dropped under
                reduced motion along with the resize. */}
            <motion.div
              key={tab}
              initial={reduceMotion ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.2 }}
            >
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
