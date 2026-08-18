// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Literal-NUL gate (#787). Fails the build when a tracked text file carries a
 * raw `0x00` byte.
 *
 * WHY A GATE RATHER THAN A RULE. The construct that produces these is
 * individually CORRECT every time someone reaches for it: a NUL is the one byte
 * that cannot occur in a résumé field, so joining a composite key with it is
 * collision-free by construction. Only the ENCODING is wrong — the byte gets
 * written where the six-character escape belongs, and the two are identical at
 * runtime. Nothing about the reasoning is faulty, so "remember not to do this"
 * does not survive contact with the next person who needs a separator. #787
 * found four occurrences on `main`; #786 shipped a fifth through review and PR
 * #125 fixed a sixth in June. That is a class, and a class needs a machine.
 *
 * WHAT IT COSTS TO MISS ONE. Two failure modes, and the loud one is the one
 * that usually does not fire:
 *
 *   1. SEARCH BREAKS SILENTLY, at any offset. `grep` treats the file as binary
 *      and exits 1 with no output at all — no match, no `Binary file matches`,
 *      no error. It reads exactly like "that symbol is not defined." `git grep`
 *      goes quiet the same way; `rg` at least says `binary file matches`.
 *      `grep -a` / `rg -a` recover, but only if you already suspect.
 *   2. THE DIFF GOES DARK ONLY SOMETIMES. Git sniffs for binary content over
 *      the head of the blob, so a NUL in the first ~8000 bytes renders the file
 *      as `Bin` on GitHub — unreviewable, no inline comments — while a NUL past
 *      that renders a perfectly normal text diff over a file every `grep` lies
 *      about. That asymmetry is how #786's instance (offset 46379) passed
 *      review: the diff looked completely fine.
 *
 * WHY AN EXTENSION SKIP-LIST AND NOT CONTENT SNIFFING. This is the trap in
 * writing this gate, and it is worth stating so nobody "improves" it into
 * uselessness: the obvious implementation skips files that *look* binary, and a
 * NUL byte is precisely what every binary-detection heuristic keys on. Such a
 * gate skips exactly the files it exists to catch and passes forever. So the
 * skip is by PATH, declared up front in `BINARY_EXTENSIONS`, and anything not on
 * that list is judged on its bytes no matter what they contain. A new binary
 * asset type is a deliberate edit here — which is the correct amount of friction
 * for teaching a correctness gate to ignore a file.
 *
 * Run:  npm run check:nul
 */

import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * Paths whose bytes are legitimately binary, matched on the lowercased suffix.
 *
 * Every entry is a format that carries NULs as a matter of course, so scanning
 * it would report thousands of findings about files nobody edits by hand. The
 * live ones in this repo are the two Poppins faces under `src/assets/fonts/`
 * (~15k NULs each) and the 58 PDF fixtures under `tests/fixtures/pdfs/`; the
 * rest are here so the first `.png` or `.woff2` someone commits does not fail
 * the build for a reason that has nothing to do with them.
 */
const BINARY_EXTENSIONS = [
  ".avif", ".docx", ".gif", ".gz", ".ico", ".jpeg", ".jpg", ".mp4", ".node",
  ".otf", ".pdf", ".png", ".swf", ".tgz", ".ttf", ".wasm", ".webp", ".woff",
  ".woff2", ".zip",
];

/** True when `relPath` names a format whose bytes are meant to be binary. */
export function isBinaryPath(relPath) {
  const lower = relPath.toLowerCase();
  return BINARY_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * Every literal NUL in `buffer`, as `{ line, column, offset }` with 1-indexed
 * line and column.
 *
 * Reported per occurrence rather than as a count because the fix is per site,
 * and a `file:line` is the thing an editor can jump to. Line and column are
 * derived by counting newlines up to the offset — the file is by definition not
 * safely decodable as text, so this deliberately works on the raw bytes rather
 * than on a `utf8` decode that would substitute replacement characters and
 * shift every column after the first multi-byte codepoint.
 */
export function nulPositions(buffer) {
  const found = [];
  let lineStart = 0;
  let line = 1;

  for (let i = 0; i < buffer.length; i += 1) {
    if (buffer[i] === 0x0a) {
      line += 1;
      lineStart = i + 1;
      continue;
    }
    if (buffer[i] !== 0x00) continue;
    // Column in BYTES from the start of the line. Exact for the ASCII these
    // separators always sit in, and close enough to point at in anything else.
    found.push({ line, column: i - lineStart + 1, offset: i });
  }

  return found;
}

/** Tracked, non-deleted paths, from git rather than a directory walk. */
export function trackedFiles(root = ROOT) {
  const out = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "buffer" });
  return out
    .toString("utf8")
    .split("\0")
    .filter((p) => p.length > 0);
}

/**
 * Scan `paths` (repo-relative) and return one entry per offending file.
 *
 * A path that no longer exists on disk is skipped rather than thrown on: `git
 * ls-files` reports the index, and a file staged for deletion is still in it.
 */
export function scanPaths(paths, root = ROOT) {
  const offenders = [];
  for (const relPath of paths) {
    if (isBinaryPath(relPath)) continue;
    const absPath = join(root, relPath);
    try {
      if (!statSync(absPath).isFile()) continue;
    } catch {
      continue;
    }
    const positions = nulPositions(readFileSync(absPath));
    if (positions.length > 0) offenders.push({ relPath, positions });
  }
  return offenders;
}

function reportOffenders(offenders, scanned) {
  for (const { relPath, positions } of offenders) {
    for (const { line, column, offset } of positions) {
      console.error(`✗ ${relPath}:${line}:${column} — literal NUL (byte offset ${offset})`);
    }
  }
  const total = offenders.reduce((n, o) => n + o.positions.length, 0);
  console.error(
    `\n${total} literal NUL byte(s) in ${offenders.length} of ${scanned} scanned file(s).\n` +
      `Write the six-character escape \\u0000 instead — identical at runtime, and the file stays\n` +
      `plain text so \`grep\` stops silently reporting no matches over it.\n\n` +
      `Careful applying the fix: every JSON-string layer between an agent and the file (a Write\n` +
      `tool, a \`gh\` comment body) decodes a typed escape straight back into a real NUL, and an\n` +
      `editor renders one as nothing. Verify by counting bytes, not by eye:\n` +
      `  python3 -c "print(open('<file>','rb').read().count(b'\\x00'))"`,
  );
}

function main() {
  const tracked = trackedFiles();
  const scannable = tracked.filter((p) => !isBinaryPath(p));
  const offenders = scanPaths(tracked);

  if (offenders.length === 0) {
    console.log(
      `✓ no literal NUL bytes: ${scannable.length} tracked text file(s) scanned ` +
        `(${tracked.length - scannable.length} binary path(s) skipped by extension).`,
    );
    return;
  }

  reportOffenders(offenders, scannable.length);
  process.exitCode = 1;
}

// Only scan when run as a script; importing this module (the unit tests do)
// must not kick off a repo walk.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
