import { db, report, sql } from "@/lib/db";
import { isReportId } from "@/lib/reports/case";

// The short id printed on a case file (`#725dcfed`) is the first group of the report's uuid, so a
// reviewer who copies it into the URL or the Mark-duplicate box is holding an 8-hex prefix, not the
// full id. Longer prefixes stop at the first hyphen of the uuid text, which the LIKE below handles
// by simply matching nothing.
const SHORT_ID = /^#?[0-9a-f]{8}$/i;

/**
 * A full report id, or the unique report a short-id prefix names, or null.
 *
 * A prefix is honoured only when exactly one report starts with it, so an ambiguous prefix resolves
 * to nothing rather than to an arbitrary row. Reviewer-only surfaces call this, and the value is
 * always matched as a parameter, never interpolated.
 *
 * ponytail: the prefix match is a sequential scan of `report` (no index on `id::text`). Fine at this
 * table's size; add a prefix index if the report count ever makes it show up.
 */
export async function resolveReportId(value: string): Promise<string | null> {
  const trimmed = value.trim().toLowerCase();
  if (isReportId(trimmed)) return trimmed;
  if (!SHORT_ID.test(trimmed)) return null;

  const prefix = trimmed.replace(/^#/, "");
  const rows = await db
    .select({ id: report.id })
    .from(report)
    .where(sql`${report.id}::text like ${`${prefix}%`}`)
    .limit(2);
  return rows.length === 1 ? rows[0].id : null;
}
