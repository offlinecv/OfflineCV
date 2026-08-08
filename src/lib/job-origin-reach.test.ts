// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Structural guard for `JobRecord.origin` (#745): the field is display-only by
 * contract (see its docblock in `storage/types.ts` and §8 of
 * `docs/job-capture-contract.md`), and the issue that added it asks for that
 * restriction to be a real check, not a comment nobody re-reads. Every other
 * "nothing else may reach this" invariant in this repo — the egress helper in
 * `job-search/providers/keywords.ts`, the PII fixture rules — is enforced by a
 * script or a test, never prose alone; this is the test for `origin`.
 *
 * The check is a source-text scan, not a type-system one, because the whole
 * point is to catch a plain property READ (`job.origin`) anywhere it has no
 * business being. It walks every non-test `.ts`/`.tsx` file under `src/` and
 * refuses if any file OTHER than the validator (which must read it to decide
 * whether to keep or drop it) and the tracker row (the one place it renders)
 * contains a `.origin` property access.
 *
 * `\.origin\b` deliberately requires a leading `.`: an object literal that
 * CONSTRUCTS a record (`origin: "capture"`, a fixture, a producer payload) has
 * no dot before the key and never matches, so this only ever flags a READ.
 * Test files are excluded — they legitimately assert on `.origin` to prove the
 * validator and the row behave, and that assertion is not a production module
 * reaching the field.
 *
 * ## The two halves match different text, on purpose
 *
 * The offender scan runs against raw source, comments included: a guard that
 * over-flags sends a human to look, and one that under-flags is the bug it
 * exists to prevent. The drift half — which asserts the allowlisted files still
 * read the field, so the scan above cannot pass by having nothing left to find —
 * strips comments first, because the file that RENDERS the phrase is also the
 * file that DOCUMENTS it. `JobTrackerEntry.tsx`'s docblock contains the words
 * "`job.origin` is display-only", which satisfies a raw-text match all by
 * itself; stub the render out and prose alone would hold this green.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = join(HERE, "..");

/** The only two production modules allowed to read `job.origin` (paths
 *  relative to `src/`) — see the module docblock. */
const ALLOWED = new Set([
  "lib/storage/job-record-contract.ts",
  "components/features/JobTrackerEntry.tsx",
]);

/**
 * Simple regex property access check. Known evasion: cannot detect destructured
 * reads like `const { origin } = job`. Added to document this limitation and
 * advise against using destructuring to bypass this safety guard.
 */
const ORIGIN_READ = /\.origin\b/;

/**
 * Reads of an `origin` that is a WEB origin, not a `JobRecord` field — the
 * false positives {@link FALSE_POSITIVE_HINT} predicted, stripped out before
 * the scan rather than excused file by file.
 *
 * They arrived with the résumé-profile sender (#620): `lib/extension-profile.ts`
 * has to name the page's own origin as a `postMessage` target and compare an
 * incoming `event.origin` against it, and both of those are the thing the
 * extension's bridge REQUIRES — a sender that dodged them to keep this gate
 * quiet would be the actual defect. Narrowing here is what the hint asks for
 * and is strictly safer than the alternative it warns against: adding that file
 * to {@link ALLOWED} would exempt it from a genuine `job.origin` read too.
 *
 * Deliberately a closed list of receivers rather than a general "any origin
 * that looks web-ish". A new spelling (`self.origin`, `frame.origin`) is a line
 * somebody has to add here, on a diff a reviewer reads.
 */
const WEB_ORIGIN_READ = /\b(?:window\.location|location|event|new URL\([^)]*\))\.origin\b/g;

/** True when `source` reads `origin` off something that is not a web origin —
 *  i.e. what #745 is actually about. */
function readsRecordOrigin(source: string): boolean {
  return ORIGIN_READ.test(source.replace(WEB_ORIGIN_READ, ""));
}

/** Named on the offender assertion, because `\.origin\b` matches a property
 *  called `origin` on ANY object and the tree is only clean of the others by
 *  luck of what has been written so far. */
const FALSE_POSITIVE_HINT =
  "A `new URL(u).origin`, `location.origin` or `event.origin` (the standard " +
  "postMessage sender check) is NOT a `JobRecord.origin` read and NOT a #745 " +
  "violation — narrow WEB_ORIGIN_READ to exclude it rather than adding the file " +
  "to ALLOWED, which would let a real read in through the same door.";

/** Source with comments removed, for the drift assertion only — see the "two
 *  halves" section of the module docblock. Crude on purpose: a `//` inside a
 *  string literal takes the rest of that line with it, which can only drop a
 *  read this check wanted to see and fail loudly, never invent one. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

/** Directories that hold test scaffolding rather than production code — the
 *  same reason `*.test.ts` files are excluded below: a helper here may
 *  legitimately read or describe an unrelated `.origin` (e.g. the parser
 *  corpus's `.origin.json` breadcrumb convention), and none of it ships. */
const TEST_DIRS = new Set(["node_modules", "__test-utils__"]);

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (TEST_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      collectSourceFiles(full, out);
      continue;
    }
    if (!/\.(ts|tsx)$/.test(entry)) continue;
    if (/\.test\.(ts|tsx)$/.test(entry)) continue;
    out.push(full);
  }
  return out;
}

describe("JobRecord.origin: read only by the validator and the tracker row (#745)", () => {
  it("is not read anywhere else in src/", () => {
    const offenders: string[] = [];
    for (const file of collectSourceFiles(SRC_ROOT)) {
      const relPath = relative(SRC_ROOT, file).split("\\").join("/");
      if (ALLOWED.has(relPath)) continue;
      if (readsRecordOrigin(readFileSync(file, "utf8"))) offenders.push(relPath);
    }
    expect(offenders, FALSE_POSITIVE_HINT).toEqual([]);
  });

  it("the allowlisted files still read `origin` in CODE, so this test can't pass by drift", () => {
    // Guards against the allowlist going stale silently: if `JobTrackerEntry.tsx`
    // stopped rendering the phrase, or the validator stopped checking the field,
    // the test above would pass for the wrong reason — every file it scans would
    // simply have nothing left to flag. Comments are stripped so the docblock
    // that DESCRIBES the read cannot stand in for the read.
    for (const relPath of ALLOWED) {
      const code = stripComments(readFileSync(join(SRC_ROOT, relPath), "utf8"));
      expect(readsRecordOrigin(code), `${relPath} no longer reads \`origin\` in code`).toBe(true);
    }
  });
});
