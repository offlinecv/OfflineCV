// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * The `.origin.json` breadcrumb convention (issue #39).
 *
 * A fixture that was DERIVED from a real résumé (a real document exposed a parse
 * defect; we minted a synthetic-persona reproduction of it) carries a sibling
 * `<name>.origin.json` next to its `<name>.expected.json`. The breadcrumb links
 * the fixture to the ledger row that verified the equivalence, and — the part
 * this module enforces — to the ISSUE(s) it reproduces.
 *
 * The invariant a derived fixture must keep: every issue it claims to reproduce
 * still has a live `*.repro.test.ts` pinning that bug. When the parser improves
 * and the fixture stops reproducing, or someone deletes the repro test, the
 * fixture is silently no longer pinning anything — and a snapshot golden
 * (`*.expected.json`) is lossy by design, so it will not catch a value-level
 * regression coming back. `corpus.test.ts` reads this module to turn that drift
 * into a test failure; `scripts/fixture-audit.ts` reads it to report it.
 *
 * PII-FREE BY CONSTRUCTION, same as everything else in the fixture pipeline: the
 * breadcrumb carries an opaque ledger handle (`ledgerId`), issue numbers, a
 * `DefectClass`, and a `ProbeId` — never a path, a hash, or a name. The real
 * source path lives ONLY in the gitignored `internal/fixtures/sources.local.json`.
 *
 * Test/tooling-only (imports `node:fs`), so it sits in `__test-utils__` beside
 * `corpus-snapshots.ts`, its only other filesystem sibling.
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
/** `src/lib/heuristics/__test-utils__` → `src/lib/heuristics`. */
const HEURISTICS_DIR = join(HERE, "..");

/**
 * The sibling breadcrumb written next to a derived fixture's `.expected.json`.
 * Opaque handle only — see the file header for the PII contract.
 */
export interface OriginJson {
  /** Always `"real-resume"` — the fixture was minted FROM a real document. */
  derivedFrom: "real-resume";
  /** The `internal/fixtures/registry.jsonl` row id, e.g. `"rl-0001"`. */
  ledgerId: string;
  /** GitHub issue numbers this fixture reproduces. Non-empty ⇒ each must have a
   *  live `*.repro.test.ts`. */
  reproduces: number[];
  /** The `DefectClass` the fixture reproduces (kept as a string here so this
   *  test-util has no dependency on the taxonomy module). */
  defectClass: string;
  /** The `ProbeId` whose verdict names the class. */
  probe: string;
}

/** The `.origin.json` path for a fixture PDF. */
function originJsonPathFor(pdfPath: string): string {
  return pdfPath.replace(/\.pdf$/i, ".origin.json");
}

/**
 * Read a fixture's `.origin.json`, or `null` when it carries none (the common
 * case — most fixtures are synthetic-by-construction, not derived-from-a-real-
 * résumé, and correctly have no breadcrumb).
 */
export function readOriginJson(pdfPath: string): OriginJson | null {
  const p = originJsonPathFor(pdfPath);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8")) as OriginJson;
}

/** Every `*.repro.test.ts` under `src/lib/heuristics/`, as absolute paths. */
function reproTestFiles(): string[] {
  return readdirSync(HEURISTICS_DIR)
    .filter((n) => n.endsWith(".repro.test.ts"))
    .map((n) => join(HEURISTICS_DIR, n))
    .sort();
}

/**
 * The `*.repro.test.ts` files whose body references `#<issue>` — today's
 * convention for "this test pins issue N" (repro tests encode the issue number
 * in their header prose). The `(?!\d)` guard stops `#39` matching `#390`.
 */
export function reproTestsReferencingIssue(issue: number): string[] {
  const needle = new RegExp(`#${issue}(?!\\d)`);
  return reproTestFiles().filter((f) => needle.test(readFileSync(f, "utf8")));
}
