import assert from "node:assert/strict";
import test from "node:test";

import { ECOSYSTEMS } from "./build-plan";
import { BASE_EGRESS, ECOSYSTEM_EGRESS, selectEgressHosts } from "./egress-profiles";

test("every ecosystem has an egress set", () => {
  for (const ecosystem of ECOSYSTEMS) {
    assert.ok(Array.isArray(ECOSYSTEM_EGRESS[ecosystem]), `${ecosystem} has no egress set`);
  }
});

test("the base set is always included and the ecosystem set is added", () => {
  const php = selectEgressHosts({ ecosystem: "php" });
  for (const host of BASE_EGRESS) assert.ok(php.includes(host), `php missing base host ${host}`);
  assert.ok(php.includes("repo.packagist.org"), "php missing Composer host");
  assert.ok(!php.includes("registry.npmjs.org"), "php should not carry the node host");
});

test("node selects npm without python or php hosts", () => {
  const node = selectEgressHosts({ ecosystem: "node" });
  assert.ok(node.includes("registry.npmjs.org"));
  assert.ok(!node.includes("pypi.org"));
  assert.ok(!node.includes("repo.packagist.org"), "node should not carry the php Composer host");
  // The Debian apt mirror is a base host, not php-specific: a node:*-slim (Debian) image that
  // apt-installs a system package needs it, so node carries it through the base set.
  assert.ok(node.includes("deb.debian.org"), "node carries the Debian apt mirror from the base set");
});

test("extra hosts are merged and the result is de-duplicated and sorted", () => {
  const hosts = selectEgressHosts({ ecosystem: "python", extraEgressHosts: ["pypi.org", "example.internal"] });
  assert.equal(new Set(hosts).size, hosts.length, "hosts are unique");
  assert.deepEqual([...hosts].sort(), hosts, "hosts are sorted");
  assert.ok(hosts.includes("example.internal"));
  assert.equal(hosts.filter((h) => h === "pypi.org").length, 1, "the duplicate pypi host is collapsed");
});

test("none adds nothing beyond the base", () => {
  assert.deepEqual(selectEgressHosts({ ecosystem: "none" }), [...BASE_EGRESS].sort());
});
