// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Shared corpus-gate harness (#459).
 *
 * The corpus fixture walk + the `KNOWN_FAILURES` ratchet are consumed by BOTH
 * corpus round-trip gates — the self-consistency gate (`corpus-roundtrip.test.ts`,
 * #293: parse1 ≡ parse3) and the edit-leg gate (`corpus-edit-roundtrip.test.ts`,
 * #459: parse3 reflects the user's overrides). Lifting them here (rather than
 * cloning) keeps the ratchet's subtle stale-entry check in ONE place — two
 * divergent copies of the teeth is a real correctness risk (#459 reuse note).
 *
 * Test-only (`.test-utils.ts`): it calls vitest `expect`, so it must never be
 * imported by production code. Two gate consumers from day one, so the shared
 * exports are live — no forward-staged export for `fallow` to flag.
 */

import { readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Absolute path to the committed fixture PDFs. */
export const FIXTURE_ROOT = join(HERE, "../../..", "tests/fixtures/pdfs");

/** Every `.pdf` under `dir`, recursively, sorted for a stable per-run order. */
export function walkPdfs(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walkPdfs(p));
    else if (e.isFile() && e.name.toLowerCase().endsWith(".pdf")) out.push(p);
  }
  return out.sort();
}

/** Fixture path relative to {@link FIXTURE_ROOT}, posix-separated on every
 *  platform. `KNOWN_FAILURES` maps are keyed with `/`; Windows `relative()`
 *  yields `\`, which both fails the stale-key check and silently voids every
 *  known-failure exemption — so normalize the separator here, once. */
export function relKey(fixture: string): string {
  return relative(FIXTURE_ROOT, fixture).split(sep).join("/");
}

/**
 * The stale-key tooth: every `KNOWN_FAILURES` key must name a real fixture. A
 * key for a deleted/renamed fixture is dead baseline and fails the gate, so the
 * baseline can't rot. Call once per suite with the fixture list.
 */
export function assertNoStaleKeys(
  knownFailures: Record<string, readonly string[]>,
  fixtures: readonly string[],
): void {
  const rel = new Set(fixtures.map(relKey));
  for (const key of Object.keys(knownFailures))
    expect(rel.has(key), `stale KNOWN_FAILURES key: ${key}`).toBe(true);
}

/**
 * The ratchet, generic over a gate's category union. For each category:
 *   - a NON-baselined category must pass (empty failure list) — the teeth that
 *     protect everything green today;
 *   - a BASELINED category that now passes fails with "remove it from
 *     KNOWN_FAILURES" — a fixed bug must shrink the baseline (stale-entry tooth).
 *
 * `fails[cat]` is the (possibly empty) list of failure descriptions for that
 * category on this fixture; `baseline` is the set of categories this fixture is
 * currently allowed to fail.
 */
export function assertRatchet<C extends string>(
  rel: string,
  categories: readonly C[],
  fails: Record<C, string[]>,
  baseline: ReadonlySet<C>,
): void {
  for (const cat of categories) {
    const failing = fails[cat].length > 0;
    if (baseline.has(cat)) {
      expect(
        failing,
        `${rel}: '${cat}' now passes — remove it from KNOWN_FAILURES`,
      ).toBe(true);
    } else {
      expect(
        fails[cat],
        `${rel}: '${cat}' regressed:\n  ${fails[cat].join("\n  ")}`,
      ).toEqual([]);
    }
  }
}
