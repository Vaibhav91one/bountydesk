import assert from "node:assert/strict";
import test from "node:test";

import { allowedImageRegistries, imageRegistryHost, imageRegistryRefusal } from "./image-registries";

test("the default allowlist is Docker Hub and GHCR, and an env list replaces it", () => {
  assert.deepEqual(allowedImageRegistries({}), ["docker.io", "ghcr.io"]);
  assert.deepEqual(allowedImageRegistries({ PREBUILT_IMAGE_REGISTRIES: " Quay.io , ghcr.io ," }), ["quay.io", "ghcr.io"]);
  assert.equal(imageRegistryRefusal("quay.io/org/app:1", { PREBUILT_IMAGE_REGISTRIES: "quay.io" }), null);
  assert.match(imageRegistryRefusal("docker.io/library/nginx:1", { PREBUILT_IMAGE_REGISTRIES: "quay.io" }) ?? "", /not accepted/);
});

test("a reference with no registry segment is Docker Hub, and a malformed registry is refused rather than defaulted", () => {
  assert.equal(imageRegistryHost("nginx:1.27"), "docker.io");
  assert.equal(imageRegistryHost("library/nginx:1.27"), "docker.io");
  assert.equal(imageRegistryHost("ghcr.io/org/app:1"), "ghcr.io");
  assert.equal(imageRegistryHost("registry.example.com:5000/org/app:1"), "registry.example.com");
  assert.equal(imageRegistryHost("bad_host.example/org/app:1"), null);
  assert.match(imageRegistryRefusal("bad_host.example/org/app:1", {}) ?? "", /not name a valid registry host/);
  assert.match(imageRegistryRefusal("localhost:5000/app:1", {}) ?? "", /images from localhost are not accepted/);
});
