import assert from "node:assert/strict";
import test from "node:test";

import {
  externalTargetCanReproduce,
  isExternalTarget,
  isolationLabel,
  parseExternalTarget,
} from "./external-target";

test("a config with an external block is recognised", () => {
  assert.equal(isExternalTarget({ external: { baseUrl: "https://staging.example.com" } }), true);
  assert.equal(isExternalTarget({ baseUrl: "http://localhost:80" }), false);
  assert.equal(isExternalTarget(null), false);
});

test("parse validates the endpoint and always allows its own host", () => {
  const cfg = parseExternalTarget({
    external: { baseUrl: "https://staging.acme.io/app", egressHosts: ["cdn.acme.io"], seedable: false },
  });
  assert.equal(cfg.baseUrl, "https://staging.acme.io/app");
  assert.deepEqual(cfg.egressHosts, ["cdn.acme.io", "staging.acme.io"]);
  assert.equal(cfg.seedable, false);
});

test("a loopback external target is refused (that is the offline strategy)", () => {
  assert.throws(
    () => parseExternalTarget({ external: { baseUrl: "http://127.0.0.1:8080" } }),
    /must not be loopback/,
  );
});

test("a non-http scheme and embedded credentials are refused", () => {
  assert.throws(() => parseExternalTarget({ external: { baseUrl: "ftp://x.example" } }), /must be http/);
  assert.throws(
    () => parseExternalTarget({ external: { baseUrl: "https://u:p@x.example" } }),
    /must not carry credentials/,
  );
});

test("only a seedable external target may carry a reproduced verdict", () => {
  const shared = parseExternalTarget({ external: { baseUrl: "https://staging.acme.io" } });
  assert.equal(externalTargetCanReproduce(shared), false);

  const seedable = parseExternalTarget({ external: { baseUrl: "https://lab.acme.io", seedable: true } });
  assert.equal(externalTargetCanReproduce(seedable), true);
});

test("runs are labelled by isolation", () => {
  assert.equal(isolationLabel(true), "external-non-isolated");
  assert.equal(isolationLabel(false), "offline-isolated");
});
