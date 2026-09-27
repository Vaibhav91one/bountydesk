import { db, eq, outsideIntakeConfig, type Executor } from "@/lib/db";

import { OUTSIDE_LIMITS } from "./outside-intake";

/** The one row's fixed primary key. The schema's check constraint forbids any other value. */
const SINGLETON_ID = 1;

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

/** The single config row mapped to a typed config, or the defaults when the row is absent. */
export async function readOutsideConfig(exec: Executor = db): Promise<OutsideConfig> {
  const [row] = await exec
    .select()
    .from(outsideIntakeConfig)
    .where(eq(outsideIntakeConfig.id, SINGLETON_ID))
    .limit(1);
  if (!row) return outsideConfigDefaults();
  return {
    perSenderPerDay: row.perSenderPerDay,
    perDomainPerDay: row.perDomainPerDay,
    maxBytes: row.maxBytes,
    exemptDomains: row.exemptDomains,
  };
}

/**
 * Write the single config row atomically. Insert the fixed-id row, or update it in place on
 * conflict, so two owners saving at once (or one retried request) converge on the one row rather
 * than racing a read-then-write into two rows. The last writer wins, which is the right outcome for
 * an owner-only setting.
 */
export async function upsertOutsideConfig(
  values: OutsideConfig,
  updatedBy: string,
  exec: Executor = db,
): Promise<void> {
  const columns = { ...values, updatedBy, updatedAt: new Date() };
  await exec
    .insert(outsideIntakeConfig)
    .values({ id: SINGLETON_ID, ...columns })
    .onConflictDoUpdate({ target: outsideIntakeConfig.id, set: columns });
}
