"use server";

import { revalidatePath } from "next/cache";

import { requireReviewer } from "@/lib/auth/dal";
import { canManageReviewers } from "@/lib/auth/reviewers";
import type { OutsideConfig } from "@/lib/email/outside-config";
import { upsertOutsideConfig } from "@/lib/email/outside-config";

export type ConfigActionResult = { ok: true } | { ok: false; error: string };

/** Same owner gate as the reviewer mutations: a member can operate but cannot change limits. */
async function requireOwnerEmail(): Promise<string | null> {
  const session = await requireReviewer();
  return canManageReviewers(session.email) ? session.email : null;
}

// Bounds are sanity rails, not policy. A limit of zero would silently reject all outside mail, and a
// size cap of a few bytes or gigabytes is a fat-finger, not a real setting.
const LIMIT_MIN = 1;
const LIMIT_MAX = 1000;
const MAX_BYTES_MIN = 1024;
const MAX_BYTES_MAX = 10 * 1024 * 1024;

// A hostname a mail domain could actually be: labels of letters, digits and hyphens, at least one
// dot, no leading or trailing hyphen in a label. Not a full RFC check, just enough to refuse junk.
const DOMAIN = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function intInRange(value: unknown, min: number, max: number): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

/** Owner-only. Validate, then write the single config row. Junk is refused, never clamped. */
export async function saveOutsideConfig(values: OutsideConfig): Promise<ConfigActionResult> {
  const owner = await requireOwnerEmail();
  if (!owner) return { ok: false, error: "Only an owner can change intake limits." };

  if (!intInRange(values.perSenderPerDay, LIMIT_MIN, LIMIT_MAX)) {
    return { ok: false, error: `Per-sender limit must be a whole number from ${LIMIT_MIN} to ${LIMIT_MAX}.` };
  }
  if (!intInRange(values.perDomainPerDay, LIMIT_MIN, LIMIT_MAX)) {
    return { ok: false, error: `Per-domain limit must be a whole number from ${LIMIT_MIN} to ${LIMIT_MAX}.` };
  }
  if (!intInRange(values.maxBytes, MAX_BYTES_MIN, MAX_BYTES_MAX)) {
    return { ok: false, error: `Size cap must be a whole number of bytes from ${MAX_BYTES_MIN} to ${MAX_BYTES_MAX}.` };
  }

  const cleaned: string[] = [];
  for (const raw of values.exemptDomains ?? []) {
    const domain = String(raw).trim().toLowerCase();
    if (domain.length === 0) continue;
    if (!DOMAIN.test(domain)) return { ok: false, error: `"${raw}" is not a valid domain.` };
    if (!cleaned.includes(domain)) cleaned.push(domain);
  }

  await upsertOutsideConfig(
    {
      perSenderPerDay: values.perSenderPerDay,
      perDomainPerDay: values.perDomainPerDay,
      maxBytes: values.maxBytes,
      exemptDomains: cleaned,
    },
    owner,
  );

  revalidatePath("/integrations/email");
  return { ok: true };
}
