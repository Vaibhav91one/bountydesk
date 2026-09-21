import assert from "node:assert/strict";
import { test } from "node:test";

import { gradientForName } from "./avatar-gradient";

test("the same name always maps to the same gradient", () => {
  assert.equal(gradientForName("Vaibhav91one"), gradientForName("Vaibhav91one"));
});

test("different names generally map to different gradients", () => {
  assert.notEqual(gradientForName("alice"), gradientForName("bob"));
});

test("the gradient is a valid two-stop CSS linear-gradient", () => {
  const g = gradientForName("someone");
  assert.match(g, /^linear-gradient\(135deg, hsl\(\d{1,3} 70% 55%\), hsl\(\d{1,3} 65% 45%\)\)$/);
});

test("an empty name is handled without throwing", () => {
  assert.match(gradientForName(""), /^linear-gradient\(/);
});

test("every hue stays in 0-359, even for hashes past 2^31", () => {
  // A signed shift used to leak a negative hue for some names; sweep a wide set to guard it.
  for (let i = 0; i < 2000; i += 1) {
    const g = gradientForName(`user-${i}-\u{1f512}`);
    const hues = [...g.matchAll(/hsl\((-?\d+)/g)].map((m) => Number(m[1]));
    assert.equal(hues.length, 2);
    for (const hue of hues) {
      assert.ok(hue >= 0 && hue <= 359, `hue out of range: ${hue} for i=${i}`);
    }
  }
});
