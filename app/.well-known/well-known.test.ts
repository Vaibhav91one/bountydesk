import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import { GET as getAasa } from "./apple-app-site-association/route";
import { GET as getAssetLinks } from "./assetlinks.json/route";

const KEYS = ["MOBILE_IOS_TEAM_ID", "MOBILE_ANDROID_SHA256_FINGERPRINTS"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

test("apple association is 404 until a team id is configured", async () => {
  delete process.env.MOBILE_IOS_TEAM_ID;
  assert.equal((await getAasa()).status, 404);
});

test("apple association is served as json with the configured app id", async () => {
  process.env.MOBILE_IOS_TEAM_ID = "ABCDE12345";
  const response = await getAasa();

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /application\/json/);
  assert.equal((await response.json()).applinks.details[0].appIDs[0], "ABCDE12345.dev.bountydesk.mobile");
});

test("asset links are 404 until a fingerprint is configured, then served as json", async () => {
  delete process.env.MOBILE_ANDROID_SHA256_FINGERPRINTS;
  assert.equal((await getAssetLinks()).status, 404);

  process.env.MOBILE_ANDROID_SHA256_FINGERPRINTS = Array.from({ length: 32 }, () => "AB").join(":");
  const response = await getAssetLinks();
  assert.equal(response.status, 200);
  assert.equal((await response.json())[0].target.package_name, "dev.bountydesk.mobile");
});
