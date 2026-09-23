import assert from "node:assert/strict";
import test from "node:test";

import { clampSheetWidth, MAX_SHEET_FRACTION, MIN_SHEET_WIDTH } from "./sheet-width";

test("the default width is the floor, so a viewer who never drags sees what shipped before", () => {
  assert.equal(clampSheetWidth(MIN_SHEET_WIDTH, 1920), MIN_SHEET_WIDTH);
  assert.equal(clampSheetWidth(0, 1920), MIN_SHEET_WIDTH);
  assert.equal(clampSheetWidth(-500, 1920), MIN_SHEET_WIDTH);
});

test("the sheet stops at half the page", () => {
  assert.equal(clampSheetWidth(5000, 1920), 1920 * MAX_SHEET_FRACTION);
  assert.equal(clampSheetWidth(1400, 3000), 1400, "a width inside the ceiling is honoured");
});

test("a width stored on a wide display does not swallow a narrow one", () => {
  // Drag it to 1200 on a 2560px monitor, reopen the report on a 1440px laptop: half of 1440 is
  // 720, so the stored width has to come down rather than cover the page.
  const storedOnBigScreen = clampSheetWidth(1200, 2560);
  assert.equal(storedOnBigScreen, 1200);
  assert.equal(clampSheetWidth(storedOnBigScreen, 1440), 720);
});

test("a viewport with no room to negotiate falls back to the floor", () => {
  // Below the sm breakpoint the sheet's own responsive rules take over and the handle is hidden,
  // so the clamp must not return something narrower than the default and fight them.
  assert.equal(clampSheetWidth(400, 800), MIN_SHEET_WIDTH);
  assert.equal(clampSheetWidth(2000, 1000), MIN_SHEET_WIDTH);
});

test("a corrupt stored value does not produce a NaN width", () => {
  // localStorage is a string bag anyone can edit; NaN as an inline width blanks the panel.
  assert.equal(clampSheetWidth(Number.NaN, 1920), MIN_SHEET_WIDTH);
  assert.equal(clampSheetWidth(Number.POSITIVE_INFINITY, 1920), MIN_SHEET_WIDTH);
});

test("a width is always a whole pixel", () => {
  assert.equal(clampSheetWidth(900.6, 1920), 901);
  assert.equal(Number.isInteger(clampSheetWidth(1234.5, 3000)), true);
});
