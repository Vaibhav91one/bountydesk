import { posix } from "node:path";
import { gunzipSync } from "node:zlib";

import { REVIEW_FILES } from "./sandboxability";
import {
  MAX_BLOB_BYTES,
  MAX_FILE_CHARS,
  MAX_TREE_PATHS,
  selectRelevantPaths,
  SKIPPED_DIRS,
  SOURCE_EXTENSION,
  type StaticSource,
} from "./static-review";

/**
 * The static review's reader for an uploaded archive, the upload counterpart of gatherStaticSource.
 *
 * An upload has no repository to fetch from; its source is the .tar or .tar.gz stored on
 * upload_intake.archive. This parses that archive in memory and never writes it to disk or runs
 * anything from it. Only regular files are read: directories, symlinks, hard links and devices are
 * skipped, so an entry cannot point the reader at anything outside the archive. A path that is
 * absolute or climbs out with `..` is refused, and so is an entry over the per-file cap. The whole
 * archive is bounded too: a gzip that inflates past MAX_UNPACKED_BYTES, or a header whose size runs
 * past the end of the buffer, stops the read with whatever was collected before it.
 */

const MAX_UNPACKED_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 20_000;
const BLOCK = 512;

export type ArchiveRead = {
  /** Regular files by their normalized path. */
  files: Map<string, Buffer>;
  /** Entries left out, with the reason, so a test and a log can see what was refused. */
  refused: Array<{ path: string; reason: "unsafe-path" | "oversize" }>;
};

function cString(block: Buffer, start: number, length: number): string {
  const slice = block.subarray(start, start + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? slice.length : end).toString("utf8");
}

/** The ustar size field is octal. A base-256 size (high bit set) is only used past 8 GiB, which is
 *  far past any cap here, so it reads as Infinity and the entry is refused as oversize. */
function entrySize(block: Buffer): number {
  if (block[124] & 0x80) return Infinity;
  const text = cString(block, 124, 12).trim();
  return text === "" ? 0 : parseInt(text, 8);
}

/** The path a pax extended header sets, if any. Records are "<len> <key>=<value>\n". */
function paxPath(data: Buffer): string | null {
  const text = data.toString("utf8");
  for (const line of text.split("\n")) {
    const match = /^\d+ path=(.*)$/.exec(line);
    if (match) return match[1];
  }
  return null;
}

/** A path safe to use as a key, or null. `..` segments and absolute paths are refused outright
 *  rather than resolved, since no honest archive needs them. */
export function safeArchivePath(raw: string): string | null {
  if (!raw || raw.includes("\0") || raw.includes("\\")) return null;
  if (raw.startsWith("/") || /^[a-z]:/i.test(raw)) return null;
  if (raw.split("/").includes("..")) return null;
  const normalized = posix.normalize(raw).replace(/^(\.\/)+/, "").replace(/\/+$/, "");
  if (!normalized || normalized === "." || normalized.startsWith("../")) return null;
  return normalized;
}

/** Parse a .tar or .tar.gz held in memory into its regular files, bounded as described above. */
export function readArchive(archive: Buffer, maxEntryBytes = MAX_BLOB_BYTES): ArchiveRead {
  const result: ArchiveRead = { files: new Map(), refused: [] };
  let tar: Buffer;
  try {
    tar = archive[0] === 0x1f && archive[1] === 0x8b ? gunzipSync(archive, { maxOutputLength: MAX_UNPACKED_BYTES }) : archive;
  } catch {
    // A corrupt gzip, or one that inflates past the cap. There is nothing trustworthy to read.
    return result;
  }

  let offset = 0;
  let longName: string | null = null;
  let entries = 0;
  while (offset + BLOCK <= tar.length && entries < MAX_ENTRIES) {
    const header = tar.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) break;
    entries++;

    const size = entrySize(header);
    const dataStart = offset + BLOCK;
    const dataEnd = dataStart + size;
    if (Number.isNaN(size) || size < 0 || dataEnd > tar.length) {
      // The size cannot be trusted to find the next header, so stop here.
      if (size > maxEntryBytes) result.refused.push({ path: longName ?? cString(header, 0, 100), reason: "oversize" });
      break;
    }
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;

    const type = String.fromCharCode(header[156] || 0x30);
    if (type === "L" || type === "x") {
      // Both name the entry that follows. Their own size is capped so a huge header is not read.
      if (size <= BLOCK * 8) {
        const data = tar.subarray(dataStart, dataEnd);
        longName = type === "L" ? cString(data, 0, data.length) : (paxPath(data) ?? longName);
      }
      continue;
    }

    const prefix = header.subarray(257, 262).toString("latin1") === "ustar" ? cString(header, 345, 155) : "";
    const rawName = longName ?? (prefix ? `${prefix}/${cString(header, 0, 100)}` : cString(header, 0, 100));
    longName = null;
    if (type !== "0") continue;

    const path = safeArchivePath(rawName);
    if (!path) {
      result.refused.push({ path: rawName, reason: "unsafe-path" });
      continue;
    }
    if (size > maxEntryBytes) {
      result.refused.push({ path, reason: "oversize" });
      continue;
    }
    result.files.set(path, Buffer.from(tar.subarray(dataStart, dataEnd)));
  }
  return result;
}

/** The single top-level directory every file sits under ("project/" from `tar czf x project`), or
 *  "" when there is none. Stripped for matching so root manifests are found either way. */
function commonRoot(paths: string[]): string {
  const first = paths[0]?.split("/")[0];
  if (!first || paths.some((p) => !p.startsWith(`${first}/`))) return "";
  return `${first}/`;
}

/**
 * The bounded corpus for a static review of an uploaded archive: its source tree, root manifests,
 * and up to the review's file cap of files the report text points at. Never throws; an unreadable
 * archive is an empty corpus, and the agent then works from the report text.
 */
export function gatherArchiveSource(
  input: { archive: Buffer; digest: string | null; reportText: string },
): StaticSource {
  const { files, refused } = readArchive(input.archive);
  if (refused.length > 0) {
    console.warn(`static review of an uploaded archive skipped ${refused.length} entries (unsafe path or over the size cap)`);
  }
  const all = [...files.keys()];
  const root = commonRoot(all);
  const byRelative = new Map(all.map((p) => [p.slice(root.length), p]));
  const relative = [...byRelative.keys()];
  const paths = relative.filter((p) => SOURCE_EXTENSION.test(p) && !SKIPPED_DIRS.test(p));

  const wanted = [...REVIEW_FILES.filter((f) => byRelative.has(f)), ...selectRelevantPaths(paths, input.reportText)];
  const out: StaticSource["files"] = [];
  for (const path of new Set(wanted)) {
    const data = files.get(byRelative.get(path)!)!;
    // A NUL byte means binary; there is nothing for the agent to read in it.
    if (data.includes(0)) continue;
    const text = data.toString("utf8").slice(0, MAX_FILE_CHARS);
    if (text.trim().length > 0) out.push({ path, text });
  }
  return { ref: input.digest ?? "uploaded archive", tree: paths.slice(0, MAX_TREE_PATHS), files: out };
}
