import assert from "node:assert/strict";
import test from "node:test";

import { gatherStaticSource, selectRelevantPaths, staticReviewSection } from "./static-review";

// A repository that is not connected is read anonymously. Injecting the lookup keeps these unit tests
// off the database; private-source-reads.test.ts covers the real lookup.
const publicRepo = { loadAccess: async () => null };

test("a path the report names outranks keyword matches, and stop words match nothing", () => {
  const paths = ["lib/search/index.ts", "routes/search.ts", "routes/login.ts", "server.ts"];
  const picked = selectRelevantPaths(paths, "The attacker sends a payload to routes/login.ts via the search box", 2);
  assert.deepEqual(picked, ["routes/login.ts", "routes/search.ts"]);
  assert.deepEqual(selectRelevantPaths(paths, "this user request with that value"), []);
});

test("an unreachable GitHub yields an empty corpus and a text-only static review, not an error", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  try {
    const source = await gatherStaticSource(
      { repoFullName: "owner/repo", ref: null, reportText: "search" },
      { readDeps: publicRepo },
    );
    assert.deepEqual(source, { ref: "HEAD", tree: [], files: [] });
    const section = staticReviewSection("COULD_NOT_BUILD", "owner/repo", source);
    assert.match(section, /COULD_NOT_BUILD/);
    assert.match(section, /from the report text alone/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a cancelled run is not swallowed as an empty corpus", async () => {
  const controller = new AbortController();
  controller.abort(new Error("shutting down"));
  await assert.rejects(
    gatherStaticSource(
      { repoFullName: "owner/repo", ref: null, reportText: "x" },
      { signal: controller.signal, readDeps: publicRepo },
    ),
    /shutting down/,
  );
});
