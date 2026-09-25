import { db, eq, outsideIntakeConfig, type Executor } from "@/lib/db";

import { OUTSIDE_LIMITS } from "./outside-intake";

/**
 * The editable knobs for outside-sender intake. The three limits mirror OUTSIDE_LIMITS; the exempt
 * list is the new piece: a domain here is not charged against the shared per-domain bucket, which is
 * how a free-mail provider stops spending one 20/day pool between unrelated senders.
 */
export type OutsideConfig = {
  perSenderPerDay: number;
  perDomainPerDay: number;
  maxBytes: number;
  exemptDomains: string[];
};

/**
 * Domains where many unrelated researchers share one From domain, so the per-domain cap would let
 * one busy free-mail user starve everyone else on the same provider. Charging them only the
 * per-sender cap keeps the per-domain cap meaningful for the domains it is actually meant to bound,
 * a single company or reporter.
 */
export const DEFAULT_EXEMPT_DOMAINS = [
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "yahoo.com",
  "icloud.com",
  "me.com",
  "proton.me",
  "protonmail.com",
  "aol.com",
];

/**
 * Today's hardcoded behaviour, used whenever the table has no row. A function, not a const, because
 * OUTSIDE_LIMITS lives in outside-intake, which imports this module back: reading it at call time
 * avoids a circular top-level reference that would be undefined when outside-intake loads first.
 */
export function outsideConfigDefaults(): OutsideConfig {
  return {
    perSenderPerDay: OUTSIDE_LIMITS.perSenderPerDay,
    perDomainPerDay: OUTSIDE_LIMITS.perDomainPerDay,
    maxBytes: OUTSIDE_LIMITS.maxBytes,
    exemptDomains: DEFAULT_EXEMPT_DOMAINS,
  };
}

/** The single config row mapped to a typed config, or the defaults when the table is empty. */
export async function readOutsideConfig(exec: Executor = db): Promise<OutsideConfig> {
  const [row] = await exec.select().from(outsideIntakeConfig).limit(1);
  if (!row) return outsideConfigDefaults();
  return {
    perSenderPerDay: row.perSenderPerDay,
    perDomainPerDay: row.perDomainPerDay,
    maxBytes: row.maxBytes,
    exemptDomains: row.exemptDomains,
  };
}

/**
 * Write the single config row: update the existing one, or insert the first. This is an owner-only,
 * near-idle setting, so a read-then-write is fine.
 * ponytail: no single-row constraint, read is always limit 1; add a partial unique index if some
 * path ever inserts a second row.
 */
export async function upsertOutsideConfig(
  values: OutsideConfig,
  updatedBy: string,
  exec: Executor = db,
): Promise<void> {
  const [existing] = await exec.select({ id: outsideIntakeConfig.id }).from(outsideIntakeConfig).limit(1);
  const columns = { ...values, updatedBy, updatedAt: new Date() };
  if (existing) {
    await exec.update(outsideIntakeConfig).set(columns).where(eq(outsideIntakeConfig.id, existing.id));
  } else {
    await exec.insert(outsideIntakeConfig).values(columns);
  }
}
