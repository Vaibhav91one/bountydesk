import assert from "node:assert/strict";
import test from "node:test";

import { appleAppSiteAssociation, assetLinks } from "./universal-links";

test("apple association lists the app and the paths it opens once a team id is configured", () => {
  const aasa = appleAppSiteAssociation({ MOBILE_IOS_TEAM_ID: "ABCDE12345" });

  assert.ok(aasa);
  const detail = aasa.applinks.details[0];
  assert.deepEqual(detail.appIDs, ["ABCDE12345.dev.bountydesk.mobile"]);
  assert.ok(detail.components.some((c) => c["/"] === "/reports/*"));
});

test("apple association is withheld until a team id is configured, rather than published with a placeholder", () => {
  assert.equal(appleAppSiteAssociation({}), null);
  assert.equal(appleAppSiteAssociation({ MOBILE_IOS_TEAM_ID: "  " }), null);
});

test("apple association rejects a team id that is not ten uppercase letters or digits", () => {
  assert.equal(appleAppSiteAssociation({ MOBILE_IOS_TEAM_ID: "not-a-team" }), null);
});

test("asset links name the android package with every configured signing fingerprint", () => {
  const fp1 = Array.from({ length: 32 }, () => "AB").join(":");
  const fp2 = Array.from({ length: 32 }, () => "CD").join(":");
  const links = assetLinks({ MOBILE_ANDROID_SHA256_FINGERPRINTS: `${fp1}, ${fp2}` });

  assert.ok(links);
  assert.equal(links[0].target.package_name, "dev.bountydesk.mobile");
  assert.deepEqual(links[0].target.sha256_cert_fingerprints, [fp1, fp2]);
  assert.deepEqual(links[0].relation, ["delegate_permission/common.handle_all_urls"]);
});

test("asset links are withheld when no fingerprint is configured or one is malformed", () => {
  assert.equal(assetLinks({}), null);
  assert.equal(assetLinks({ MOBILE_ANDROID_SHA256_FINGERPRINTS: "AB:CD" }), null);
});
