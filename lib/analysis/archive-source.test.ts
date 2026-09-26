import assert from "node:assert/strict";
import test from "node:test";
import { gzipSync } from "node:zlib";

import { gatherArchiveSource, readArchive, safeArchivePath } from "./archive-source";

/** One ustar entry. The reader never checks the header checksum, so it is left blank. */
function entry(name: string, content: string | Buffer, type = "0"): Buffer {
  const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124, "latin1");
  header.write(type, 156, "latin1");
  header.write("ustar\0", 257, "latin1");
  const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512);
  data.copy(padded);
  return Buffer.concat([header, padded]);
}

function tar(...entries: Buffer[]): Buffer {
  return Buffer.concat([...entries, Buffer.alloc(1024)]);
}

test("path traversal and absolute paths are refused, ordinary paths are kept", () => {
  const read = readArchive(
    tar(
      entry("../etc/passwd", "root:x:0:0"),
      entry("/etc/shadow", "secret"),
      entry("src/../../escape.js", "x"),
      entry("./src/app.js", "app()"),
    ),
  );
  assert.deepEqual([...read.files.keys()], ["src/app.js"]);
  assert.deepEqual(
    read.refused.map((r) => [r.path, r.reason]),
    [
      ["../etc/passwd", "unsafe-path"],
      ["/etc/shadow", "unsafe-path"],
      ["src/../../escape.js", "unsafe-path"],
    ],
  );
  assert.equal(safeArchivePath("a/b/../c"), null);
  assert.equal(safeArchivePath("C:/win"), null);
  assert.equal(safeArchivePath("a\\..\\b"), null);
});

test("a pax or GNU long name cannot smuggle a traversal past the check", () => {
  const read = readArchive(
    tar(
      entry("././@LongLink", "../../outside.js\0", "L"),
      entry("short.js", "x"),
      entry("pax", "30 path=../pax-escape.js\n", "x"),
      entry("short2.js", "y"),
    ),
  );
  assert.equal(read.files.size, 0);
  assert.deepEqual(read.refused.map((r) => r.path), ["../../outside.js", "../pax-escape.js"]);
});

test("an entry over the size cap is refused and the read carries on", () => {
  const read = readArchive(tar(entry("big.js", "x".repeat(2_000)), entry("small.js", "ok")), 1_000);
  assert.deepEqual([...read.files.keys()], ["small.js"]);
  assert.deepEqual(read.refused, [{ path: "big.js", reason: "oversize" }]);
});

test("a header whose size runs past the buffer stops the read", () => {
  const good = entry("a.js", "a");
  const lying = entry("b.js", "b");
  lying.write(`${(10_000_000).toString(8).padStart(11, "0")}\0`, 124, "latin1");
  const read = readArchive(Buffer.concat([good, lying]));
  assert.deepEqual([...read.files.keys()], ["a.js"]);
});

test("symlinks, hard links and directories are never read", () => {
  const read = readArchive(tar(entry("link", "", "2"), entry("hard", "", "1"), entry("dir/", "", "5")));
  assert.equal(read.files.size, 0);
});

test("corrupt gzip reads as an empty archive", () => {
  const read = readArchive(Buffer.from([0x1f, 0x8b, 0, 1, 2, 3]));
  assert.equal(read.files.size, 0);
});

test("the static corpus is the root manifests and the files the report points at, under a common root", () => {
  const archive = gzipSync(
    tar(
      entry("shop/package.json", '{"name":"shop"}'),
      entry("shop/routes/search.js", "db.all(`SELECT * WHERE name LIKE '%${q}%'`)"),
      entry("shop/lib/basket.js", "module.exports = basket"),
      entry("shop/node_modules/x/search.js", "vendored"),
      entry("shop/assets/logo.js", Buffer.from([0x00, 0x01, 0x02])),
    ),
  );
  const source = gatherArchiveSource({
    archive,
    digest: "sha256:abc",
    reportText: "SQL injection in routes/search.js through the q parameter",
  });
  assert.equal(source.ref, "sha256:abc");
  assert.deepEqual(source.files.map((f) => f.path), ["package.json", "routes/search.js"]);
  assert.ok(source.tree.includes("lib/basket.js"));
  assert.ok(!source.tree.some((p) => p.includes("node_modules")));
});
