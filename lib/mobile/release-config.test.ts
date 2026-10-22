import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { APP_PATHS, MOBILE_APP_ID, appleAppSiteAssociation } from "./universal-links";

const read = (file: string) => JSON.parse(readFileSync(new URL(`../../mobile/${file}`, import.meta.url), "utf8"));
const APP_HOST = "app.bountydesk.vaibhav.quest";

test("the app config and the served association files agree on the app id", () => {
  const { expo } = read("app.json");
  assert.equal(expo.ios.bundleIdentifier, MOBILE_APP_ID);
  assert.equal(expo.android.package, MOBILE_APP_ID);
});

test("ios claims the app host and android opens every path the association file lists", () => {
  const { expo } = read("app.json");
  assert.deepEqual(expo.ios.associatedDomains, [`applinks:${APP_HOST}`]);

  const filter = expo.android.intentFilters[0];
  assert.equal(filter.autoVerify, true);
  const prefixes = filter.data.map((d: { pathPrefix: string }) => d.pathPrefix).sort();
  assert.deepEqual(prefixes, APP_PATHS.map((p) => p.replace(/\/\*$/, "")).sort());
  assert.ok(filter.data.every((d: { host: string; scheme: string }) => d.host === APP_HOST && d.scheme === "https"));
  assert.ok(appleAppSiteAssociation({ MOBILE_IOS_TEAM_ID: "ABCDE12345" }));
});

test("eas has development, preview and production builds, each on its own update channel", () => {
  const { build } = read("eas.json");
  for (const profile of ["development", "preview", "production"]) {
    assert.equal(build[profile].channel, profile);
  }
  assert.equal(build.development.developmentClient, true);
});

test("a native change forces a new runtime so a JS-only update never reaches an incompatible build", () => {
  assert.deepEqual(read("app.json").expo.runtimeVersion, { policy: "appVersion" });
});
