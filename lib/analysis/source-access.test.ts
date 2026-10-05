import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { boundedSourceReader, listBlobPaths, MAX_BLOB_BYTES } from "./source-access";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(respond: () => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return respond();
  }) as typeof fetch;
  return calls;
}

test("the reader sends a Range header, slices a host that ignores it, and sends the token only when given", async () => {
  const calls = stubFetch(() => new Response("x".repeat(50), { status: 200 }));
  const text = await boundedSourceReader("o/r", 10, "abc").readFile("a.txt");
  assert.equal(text, "x".repeat(10));
  assert.equal(calls[0].url, "https://raw.githubusercontent.com/o/r/abc/a.txt");
  const anon = calls[0].init.headers as Record<string, string>;
  assert.equal(anon.Range, "bytes=0-9");
  assert.equal(anon.authorization, undefined);

  await boundedSourceReader("o/r", 10, "abc", undefined, "tok").readFile("a.txt");
  assert.equal((calls[1].init.headers as Record<string, string>).authorization, "Bearer tok");
});

test("the reader returns null on 404 and any other failure status", async () => {
  stubFetch(() => new Response("", { status: 404 }));
  assert.equal(await boundedSourceReader("o/r", 10).readFile("a"), null);
  stubFetch(() => new Response("", { status: 500 }));
  assert.equal(await boundedSourceReader("o/r", 10).readFile("a"), null);
});

test("the tree listing keeps blobs at or under the cap and is empty on a failed request", async () => {
  stubFetch(
    () =>
      new Response(
        JSON.stringify({
          tree: [
            { path: "a.ts", type: "blob", size: 1 },
            { path: "nosize.ts", type: "blob" },
            { path: "big.ts", type: "blob", size: MAX_BLOB_BYTES + 1 },
            { path: "dir", type: "tree" },
          ],
        }),
      ),
  );
  assert.deepEqual(await listBlobPaths("o/r", "HEAD", new AbortController().signal, null), ["a.ts", "nosize.ts"]);
  stubFetch(() => new Response("", { status: 403 }));
  assert.deepEqual(await listBlobPaths("o/r", "HEAD", new AbortController().signal, null), []);
});
