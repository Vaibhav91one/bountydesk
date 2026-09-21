import { redactReviewerText } from "@/lib/reviewer-chat/context";

const DEFAULT_MAX_LENGTH = 300;

function withoutResponseBody(value: string): string {
  const bodyLine = value.search(/(?:^|\n)\s*Body:/i);
  const jsonObject = value.indexOf("{");
  const cutAt = [bodyLine, jsonObject].filter((index) => index >= 0).sort((a, b) => a - b)[0];
  return cutAt === undefined ? value : value.slice(0, cutAt);
}

function boundedLength(max: number): number {
  return Number.isFinite(max) && max >= 0 ? Math.floor(max) : DEFAULT_MAX_LENGTH;
}

/** Keep external error text useful without retaining response bodies or credential-shaped data. */
export function safeErrorText(error: unknown, max = DEFAULT_MAX_LENGTH): string {
  const limit = boundedLength(max);
  let value: string;
  try {
    value = error instanceof Error ? String(error.message) : String(error);
  } catch {
    value = "unknown error";
  }

  try {
    const text = redactReviewerText(withoutResponseBody(value)).replace(/\s+/g, " ").trim();
    return text.slice(0, limit);
  } catch {
    return "unknown error".slice(0, limit);
  }
}
