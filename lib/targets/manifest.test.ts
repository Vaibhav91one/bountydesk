import assert from "node:assert/strict";
import test from "node:test";

import { parseTargetManifest, targetDefinitionFromManifest } from "./manifest";

test("a target manifest becomes a platform target definition", () => {
  const definition = parseTargetManifest(
    JSON.stringify({
      name: "webgoat",
      repoFullName: "Vaibhav91one/WebGoat",
      imageName: "ghcr.io/vaibhav91one/webgoat",
      baseUrl: "http://localhost:8080",
      readinessPath: "/WebGoat",
      startCommand: "java -jar /opt/webgoat/webgoat.jar",
    }),
  );

  assert.equal(definition.name, "webgoat");
  assert.equal(definition.envPrefix, "WEBGOAT");
  assert.equal(definition.imageName, "ghcr.io/vaibhav91one/webgoat");
  assert.deepEqual(definition.scopeRules, [{ allow: "localhost" }]);
  assert.deepEqual(definition.config, {
    baseUrl: "http://localhost:8080",
    readinessPath: "/WebGoat",
  });
  assert.deepEqual(definition.provisioning, {
    readinessPath: "/WebGoat",
    startCommand: "java -jar /opt/webgoat/webgoat.jar",
  });
});

test("a target manifest rejects non-loopback or overbroad authority", () => {
  const base = {
    name: "dynamic-target",
    repoFullName: "Vaibhav91one/dynamic-target",
    imageName: "ghcr.io/vaibhav91one/dynamic-target",
    baseUrl: "http://localhost:3000",
    readinessPath: "/",
  };

  for (const bad of [
    { ...base, baseUrl: "https://localhost:3000" },
    { ...base, baseUrl: "http://example.com" },
    { ...base, imageName: "ghcr.io/vaibhav91one/dynamic-target:latest" },
    { ...base, readinessPath: "http://localhost:3000/health" },
    { ...base, scopeRules: [{ allow: "example.com" }] },
    { ...base, startCommand: "echo one\necho two" },
    {
      name: base.name,
      imageName: base.imageName,
      baseUrl: base.baseUrl,
      readinessPath: base.readinessPath,
    },
  ]) {
    assert.throws(() => targetDefinitionFromManifest(bad), /target manifest/);
  }
});
