import assert from "node:assert/strict";
import test from "node:test";

import type { SourceReader } from "@/lib/build-onboarding/classify";
import {
  dependencyAdvisorySection,
  parseDependencies,
  queryOsv,
  scanDependencies,
  type Dependency,
} from "./dependency-scan";

function has(deps: Dependency[], ecosystem: string, name: string, version: string): boolean {
  return deps.some((d) => d.ecosystem === ecosystem && d.name === name && d.version === version);
}

test("npm: a lockfile's exact version wins over the manifest's range", () => {
  const deps = parseDependencies([
    { path: "package.json", text: `{ "dependencies": { "lodash": "^4.17.15" } }` },
    {
      path: "package-lock.json",
      text: JSON.stringify({ packages: { "": {}, "node_modules/lodash": { version: "4.17.15" } } }),
    },
  ]);
  assert.ok(has(deps, "npm", "lodash", "4.17.15"));
  assert.equal(deps.filter((d) => d.name === "lodash").length, 1, "deduped, not counted twice");
});

test("npm: a lockfileVersion 1 flat dependency map is read", () => {
  const deps = parseDependencies([
    { path: "package-lock.json", text: JSON.stringify({ dependencies: { minimist: { version: "1.2.0" } } }) },
  ]);
  assert.ok(has(deps, "npm", "minimist", "1.2.0"));
});

test("npm: a caret range in the manifest is cleaned to a concrete version, a wildcard is dropped", () => {
  const deps = parseDependencies([
    { path: "package.json", text: `{ "dependencies": { "express": "^4.17.1", "star": "*" } }` },
  ]);
  assert.ok(has(deps, "npm", "express", "4.17.1"));
  assert.ok(!deps.some((d) => d.name === "star"), "a wildcard is not a version");
});

test("PyPI: requirements.txt keeps pinned versions and skips ranges and comments", () => {
  const deps = parseDependencies([
    { path: "requirements.txt", text: "Django==2.2.0\nrequests>=2.0  # a range, skipped\n# comment\n" },
  ]);
  assert.ok(has(deps, "PyPI", "Django", "2.2.0"));
  assert.ok(!deps.some((d) => d.name === "requests"), "a >= requirement has no exact version");
});

test("PyPI: poetry.lock package blocks are read", () => {
  const deps = parseDependencies([
    { path: "poetry.lock", text: `[[package]]\nname = "jinja2"\nversion = "2.11.2"\n\n[[package]]\nname = "click"\nversion = "7.1.2"\n` },
  ]);
  assert.ok(has(deps, "PyPI", "jinja2", "2.11.2"));
  assert.ok(has(deps, "PyPI", "click", "7.1.2"));
});

test("Go: go.sum is deduped to one entry per module and go.mod fills gaps", () => {
  const deps = parseDependencies([
    {
      path: "go.sum",
      text: "github.com/gin-gonic/gin v1.6.3/go.mod h1:aaaa=\ngithub.com/gin-gonic/gin v1.6.3 h1:bbbb=\n",
    },
    { path: "go.mod", text: "module x\n\nrequire golang.org/x/text v0.3.2\n" },
  ]);
  assert.equal(deps.filter((d) => d.name === "github.com/gin-gonic/gin").length, 1);
  assert.ok(has(deps, "Go", "github.com/gin-gonic/gin", "v1.6.3"));
  assert.ok(has(deps, "Go", "golang.org/x/text", "v0.3.2"));
});

test("Maven: pom.xml dependencies with a literal version parse, a property version is skipped", () => {
  const deps = parseDependencies([
    {
      path: "pom.xml",
      text: `<project><dependencies>
        <dependency><groupId>org.apache.logging.log4j</groupId><artifactId>log4j-core</artifactId><version>2.14.1</version></dependency>
        <dependency><groupId>com.example</groupId><artifactId>lib</artifactId><version>\${lib.version}</version></dependency>
      </dependencies></project>`,
    },
  ]);
  assert.ok(has(deps, "Maven", "org.apache.logging.log4j:log4j-core", "2.14.1"));
  assert.ok(!deps.some((d) => d.name === "com.example:lib"), "an unresolved property version is skipped");
});

test("RubyGems: Gemfile.lock specs are read, dependency lines are not", () => {
  const deps = parseDependencies([
    { path: "Gemfile.lock", text: "GEM\n  remote: https://rubygems.org/\n  specs:\n    rack (2.2.3)\n    rails (6.0.0)\n      rack (>= 2.0)\n\nPLATFORMS\n  ruby\n" },
  ]);
  assert.ok(has(deps, "RubyGems", "rack", "2.2.3"));
  assert.ok(has(deps, "RubyGems", "rails", "6.0.0"));
  assert.equal(deps.filter((d) => d.name === "rack").length, 1, "the nested dependency line is not a second entry");
});

test("Packagist: composer.lock packages are read, php platform requirements are not", () => {
  const deps = parseDependencies([
    { path: "composer.lock", text: JSON.stringify({ packages: [{ name: "monolog/monolog", version: "2.0.0" }] }) },
    { path: "composer.json", text: `{ "require": { "php": ">=7.4", "guzzlehttp/guzzle": "7.0.1" } }` },
  ]);
  assert.ok(has(deps, "Packagist", "monolog/monolog", "2.0.0"));
  assert.ok(has(deps, "Packagist", "guzzlehttp/guzzle", "7.0.1"));
  assert.ok(!deps.some((d) => d.name === "php"), "php is a platform requirement, not a package");
});

test("crates.io: Cargo.lock package blocks are read", () => {
  const deps = parseDependencies([
    { path: "Cargo.lock", text: `[[package]]\nname = "serde"\nversion = "1.0.104"\n` },
  ]);
  assert.ok(has(deps, "crates.io", "serde", "1.0.104"));
});

test("a pathological single-line go.mod parses fast and yields nothing (no quadratic backtracking)", () => {
  // A blob-cap-sized line of dots with no version suffix is the ReDoS shape for a naive two-class
  // regex. The tokenizing parser must return quickly, not stall the worker's event loop.
  const evil = "require " + ".".repeat(200_000);
  const started = Date.now();
  const deps = parseDependencies([{ path: "go.mod", text: evil }]);
  assert.deepEqual(deps, []);
  assert.ok(Date.now() - started < 1_000, "parsing a hostile go.mod line stays well under a second");
});

test("malformed input yields nothing and never throws", () => {
  assert.deepEqual(parseDependencies([{ path: "package.json", text: "{ not json" }]), []);
  assert.deepEqual(parseDependencies([{ path: "package-lock.json", text: "]}{" }]), []);
  assert.deepEqual(parseDependencies([{ path: "composer.json", text: "" }]), []);
  assert.deepEqual(parseDependencies([{ path: "pom.xml", text: "<project" }]), []);
  assert.deepEqual(parseDependencies([]), []);
});

test("queryOsv maps a querybatch hit to one advisory finding", async () => {
  let sentBody: unknown = null;
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    sentBody = JSON.parse(String(init?.body));
    return Response.json({ results: [{ vulns: [{ id: "GHSA-jf85-cpcp-j695" }, { id: "CVE-2019-10744" }] }, {}] });
  }) as typeof fetch;

  const advisories = await queryOsv(
    [
      { ecosystem: "npm", name: "lodash", version: "4.17.15" },
      { ecosystem: "npm", name: "safe", version: "1.0.0" },
    ],
    { fetchImpl },
  );

  assert.equal(advisories.length, 1, "only the package with vulns is reported");
  assert.equal(advisories[0].name, "lodash");
  assert.deepEqual(advisories[0].ids, ["GHSA-jf85-cpcp-j695", "CVE-2019-10744"]);
  assert.deepEqual((sentBody as { queries: unknown[] }).queries[0], {
    package: { name: "lodash", ecosystem: "npm" },
    version: "4.17.15",
  });
});

test("queryOsv with no dependencies makes no request", async () => {
  let called = false;
  const fetchImpl = (async () => {
    called = true;
    return Response.json({ results: [] });
  }) as typeof fetch;
  assert.deepEqual(await queryOsv([], { fetchImpl }), []);
  assert.equal(called, false);
});

test("an OSV error or timeout yields zero findings and never throws", async () => {
  const throwing = (async () => {
    throw new Error("network down");
  }) as typeof fetch;
  assert.deepEqual(await queryOsv([{ ecosystem: "npm", name: "x", version: "1.0.0" }], { fetchImpl: throwing }), []);

  const notOk = (async () => new Response("rate limited", { status: 429 })) as typeof fetch;
  assert.deepEqual(await queryOsv([{ ecosystem: "npm", name: "x", version: "1.0.0" }], { fetchImpl: notOk }), []);
});

test("scanDependencies reads the corpus and reports OSV matches, empty when nothing is found", async () => {
  const reader: SourceReader = {
    async readFile(path: string) {
      return path === "package.json" ? `{ "dependencies": { "lodash": "4.17.15" } }` : null;
    },
  };
  const fetchImpl = (async () => Response.json({ results: [{ vulns: [{ id: "GHSA-x" }] }] })) as typeof fetch;
  const advisories = await scanDependencies(reader, { fetchImpl });
  assert.equal(advisories.length, 1);
  assert.equal(advisories[0].name, "lodash");

  const empty = await scanDependencies({ async readFile() { return null; } }, { fetchImpl });
  assert.deepEqual(empty, []);
});

test("availablePaths gates the scan so an unlisted (oversize) file is never read", async () => {
  const read: string[] = [];
  const reader: SourceReader = {
    async readFile(path: string) {
      read.push(path);
      return path === "package.json" ? `{ "dependencies": { "lodash": "4.17.15" } }` : "should not be read";
    },
  };
  const fetchImpl = (async () => Response.json({ results: [] })) as typeof fetch;
  // package-lock.json is left out of the tree listing (too large to list), so it must not be fetched.
  await scanDependencies(reader, { fetchImpl, availablePaths: new Set(["package.json"]) });
  assert.deepEqual(read, ["package.json"], "only the listed path is read");
});

test("the advisory section is null when empty and Observation-tier framed when not", () => {
  assert.equal(dependencyAdvisorySection([]), null);
  const section = dependencyAdvisorySection([{ ecosystem: "npm", name: "lodash", version: "4.17.15", ids: ["GHSA-x"] }]);
  assert.match(section ?? "", /Observation tier/);
  assert.match(section ?? "", /never establishes REPRODUCED/);
  assert.match(section ?? "", /lodash@4\.17\.15: GHSA-x/);
});
