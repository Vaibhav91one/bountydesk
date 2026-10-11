/**
 * Phase color map and labels, matching the c.css `.c-*` classes and the
 * `.pill` tint of the phase hue at 16 percent.
 *
 * c.css variables (dark):
 *   --triaging    oklch(0.7 0.15 250)
 *   --reproducing oklch(0.75 0.13 195)
 *   --analysis    oklch(0.72 0.18 330)
 *   --approval    oklch(0.8 0.15 75)
 *   --delivered   oklch(0.72 0.16 150)
 *   --closed      oklch(0.55 0 0)
 *
 * The native theme (theme.ts) already holds the converted hex for each phase
 * in `theme.phase`. We resolve by phase key here.
 */
import { useTheme } from "@/theme"
import { useColorScheme } from "react-native"

export type PhaseKey = "triaging" | "reproducing" | "analysis" | "approval" | "delivered" | "closed"

export interface PhaseMeta {
  key: PhaseKey
  label: string
  color: string
}

const DARK_LABELS: Record<PhaseKey, string> = {
  triaging: "Triaging",
  reproducing: "Reproducing",
  analysis: "Analysis",
  approval: "Awaiting approval",
  delivered: "Delivered",
  closed: "Closed",
}

/** Resolve a phase key to its label. The mockups label the approval phase
 * "Awaiting approval" on the larger cards and "Approval" in the queue list. */
export function phaseLabel(key: PhaseKey): string {
  return DARK_LABELS[key]
}

/** Resolve a phase key to its theme color (full hue, for the 6px dot and label). */
export function usePhaseColor(key: PhaseKey): string {
  const { phase } = useTheme()
  return phase[key]
}

/**
 * PhasePill tint. c.css does `color-mix(in oklab, var(--c) 16%, transparent)`,
 * so the pill background is the phase hue at 16% opacity over the card surface.
 * Native has no oklch/oklab mix, so we append an ~16% alpha byte (0x29) to the
 * resolved hex, matching the c.css visual weight for the pill body only.
 */
export function phaseTint(color: string): string {
  return color + "29"
}
