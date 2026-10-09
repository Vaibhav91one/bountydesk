import { MAX_PATCH_CHARS, type Finding } from "@/lib/mcp/verdict-draft";

/**
 * A finding's suggested fix is model output, so it is checked as data and never applied or run.
 * The check is structural: file headers, then hunks whose line counts match their @@ headers.
 * That is enough to tell a diff from prose and to keep `git apply` from choking on a truncated
 * one; it says nothing about whether the fix is correct, which is the reviewer's call.
 */

const HUNK = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/;
// Git's extended header lines that may sit between file diffs. "Binary files" and "GIT binary
// patch" are left out on purpose: a source fix has no binary part.
const EXTENDED_HEADER =
  /^(diff --git |index |old mode |new mode |new file mode |deleted file mode |similarity index |rename (from|to) )/;

function safePath(header: string): boolean {
  // "--- a/src/x.ts\t<timestamp>" and "+++ b/src/x.ts": take the path before any tab.
  const raw = header.slice(4).split("\t")[0].trim();
  if (raw === "/dev/null") return true;
  const path = raw.replace(/^[ab]\//, "");
  return path.length > 0 && !path.startsWith("/") && !path.split("/").includes("..");
}

export function isValidUnifiedDiff(text: string): boolean {
  if (text.length === 0 || text.length > MAX_PATCH_CHARS || text.includes("\0")) return false;
  const lines = text.replace(/\r\n/g, "\n").replace(/\n+$/, "").split("\n");

  let hunks = 0;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("--- ")) {
      const next = lines[i + 1];
      if (!next?.startsWith("+++ ") || !safePath(line) || !safePath(next)) return false;
      i += 2;
      // At least one hunk must follow each file header pair.
      let fileHunks = 0;
      while (i < lines.length && HUNK.test(lines[i])) {
        const m = HUNK.exec(lines[i])!;
        let oldLeft = m[1] === undefined ? 1 : Number(m[1]);
        let newLeft = m[2] === undefined ? 1 : Number(m[2]);
        i += 1;
        while (oldLeft > 0 || newLeft > 0) {
          const body = lines[i];
          if (body === undefined) return false;
          const tag = body[0];
          if (tag === " " || body === "") {
            oldLeft -= 1;
            newLeft -= 1;
          } else if (tag === "-") oldLeft -= 1;
          else if (tag === "+") newLeft -= 1;
          else return false;
          if (oldLeft < 0 || newLeft < 0) return false;
          i += 1;
        }
        // "\ No newline at end of file" belongs to the preceding hunk line.
        while (lines[i]?.startsWith("\\")) i += 1;
        fileHunks += 1;
      }
      if (fileHunks === 0) return false;
      hunks += fileHunks;
    } else if (EXTENDED_HEADER.test(line)) {
      i += 1;
    } else {
      return false;
    }
  }
  return hunks > 0;
}

/**
 * The downloadable file for a verdict: every finding's patch that validates, in finding order,
 * each under a one-line comment naming its finding (git apply and patch both skip text before a
 * diff). Null when none validates, which is how "record nothing" is decided. An invalid patch
 * is dropped alone; it does not take the other findings' patches down with it.
 */
export function buildRemediationPatch(findings: Finding[]): string | null {
  const parts: string[] = [];
  findings.forEach((finding, index) => {
    const patch = finding.remediationPatch;
    if (!patch || !isValidUnifiedDiff(patch)) return;
    const title = finding.title.replace(/\s+/g, " ");
    parts.push(`# Finding ${index + 1}: ${title}\n${patch.replace(/\n*$/, "\n")}`);
  });
  return parts.length > 0 ? parts.join("\n") : null;
}
