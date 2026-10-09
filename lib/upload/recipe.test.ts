import assert from "node:assert/strict";
import test from "node:test";
import { gzipSync } from "node:zlib";

import { targetDefinitionFromManifest } from "@/lib/targets/manifest";

import type { ReviewedUploadTarget } from "./gate";
import { archiveShape, thinRecipePlan } from "./recipe";

function tarHeader(name: string, size: number): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write("0000644\0", 100, "latin1");
  header.write(`${size.toString(8).padStart(11, "0")}\0`, 124, "latin1");
  header.write("        ", 148, "latin1");
  header.write("0", 156, "latin1");
  header.write("ustar\0", 257, "latin1");
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "latin1");
  return header;
}

function tarGz(files: Record<string, string>): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, content] of Object.entries(files)) {
    const body = Buffer.from(content, "utf8");
    blocks.push(tarHeader(name, body.length), body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

// Built from the manifest validator directly: gate.ts pulls in the database at import time.
const reviewed = (input: { startCommand?: string } = {}): ReviewedUploadTarget => ({
  ecosystem: "none",
  definition: targetDefinitionFromManifest({
    name: "upload-r1",
    repoFullName: "upload/r1",
    imageName: "ghcr.io/bountydesk/upload-pending",
    baseUrl: "http://localhost:8080",
    readinessPath: "/health",
    ...input,
  }),
});

test("a root Dockerfile, with or without a wrapping directory, is seen", () => {
  assert.equal(archiveShape(tarGz({ Dockerfile: "FROM x\n", "a.js": "1" })).hasDockerfile, true);
  assert.equal(archiveShape(tarGz({ "proj/Dockerfile": "FROM x\n", "proj/a.js": "1" })).hasDockerfile, true);
  assert.equal(archiveShape(tarGz({ "a.js": "1" })).hasDockerfile, false);
});

test("a node tarball gets a thin node recipe built in its wrapping directory", async () => {
  const plan = await thinRecipePlan(tarGz({ "proj/package.json": "{}", "proj/package-lock.json": "{}" }), reviewed());
  assert.ok(plan?.strategy === "agent-authored");
  assert.equal(plan.buildContext, "proj");
  assert.equal(plan.ecosystem, "node");
  assert.match(plan.dockerfileText, /^FROM node:20-slim$/m);
  assert.match(plan.dockerfileText, /npm ci/);
  assert.match(plan.dockerfileText, /EXPOSE 8080/);
});

test("the start command is quoted into CMD and cannot add Dockerfile lines", async () => {
  const plan = await thinRecipePlan(tarGz({ "package.json": "{}" }), reviewed({ startCommand: 'node app.js" ; echo hi' }));
  assert.ok(plan?.strategy === "agent-authored");
  assert.match(plan.dockerfileText, /^CMD \["sh", "-c", "node app\.js\\" ; echo hi"\]$/m);
});

test("python needs the reviewer's start command; other ecosystems get no recipe", async () => {
  const py = tarGz({ "requirements.txt": "flask\n" });
  assert.equal(await thinRecipePlan(py, reviewed()), null);
  const plan = await thinRecipePlan(py, reviewed({ startCommand: "python app.py" }));
  assert.ok(plan?.strategy === "agent-authored");
  assert.match(plan.dockerfileText, /pip install --no-cache-dir -r requirements.txt/);
  assert.equal(await thinRecipePlan(tarGz({ "go.mod": "module x\n" }), reviewed()), null);
  assert.equal(await thinRecipePlan(tarGz({ "app.js": "1" }), reviewed()), null);
});
