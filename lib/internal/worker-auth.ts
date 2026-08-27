import { createHash, timingSafeEqual } from "node:crypto";

import { workerInternalSecret } from "@/lib/env";

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export function hasValidWorkerAuthorization(value: string | null): boolean {
  const actual = digest(value ?? "");
  const expected = digest(`Bearer ${workerInternalSecret()}`);
  return timingSafeEqual(actual, expected);
}
