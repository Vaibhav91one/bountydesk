/**
 * A stable gradient for an identity that has no avatar image. The same name always maps to the
 * same two hues, so a reviewer's tile stays recognizable without a photo, and different names read
 * as different tiles. Purely presentational: it carries no identity meaning of its own.
 */
export function gradientForName(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  }
  // Unsigned shift throughout: a signed `>>` on a hash past 2^31 goes negative, and JS's `%` would
  // then hand back a negative hue like hsl(-39 …). `>>>` keeps every term non-negative.
  const first = hash % 360;
  const second = (first + 40 + ((hash >>> 8) % 80)) % 360;
  return `linear-gradient(135deg, hsl(${first} 70% 55%), hsl(${second} 65% 45%))`;
}
