"use client";

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { OnboardingDiagram } from "@/components/onboarding-diagram";

import { OnboardingStepper } from "./onboarding-stepper";

export type OnboardingTab = "state" | "architecture";

/**
 * The onboarding pipeline in one dialog, toggled between two views of the same thing: the state
 * as a horizontal stepper, and the agent architecture as a flowchart. Both read the repo's current
 * onboarding state; the toggle only chooses how it is drawn. Opened from the sheet, so it portals
 * over the sheet (both go to body).
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
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] gap-4 overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Onboarding</DialogTitle>
          <DialogDescription>
            How this repository becomes a reproduction target, and where it is in that pipeline.
          </DialogDescription>
        </DialogHeader>

        <Tabs value={tab} onValueChange={(value) => onTabChange(value as OnboardingTab)}>
          <TabsList className="w-full">
            <TabsTrigger value="state">State</TabsTrigger>
            <TabsTrigger value="architecture">Architecture</TabsTrigger>
          </TabsList>
          <TabsContent value="state" className="pt-4">
            <OnboardingStepper state={state} />
          </TabsContent>
          <TabsContent value="architecture" className="pt-4">
            <OnboardingDiagram repositoryFullName={repositoryFullName} state={state} />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
