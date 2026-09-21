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
