// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

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
  knownFailures: Record<string, readonly unknown[]>,
  fixtures: readonly string[],
): void {
  const rel = new Set(fixtures.map(relKey));
  for (const key of Object.keys(knownFailures))
    expect(rel.has(key), `stale KNOWN_FAILURES key: ${key}`).toBe(true);
}

// ── Issue-linked baselines (#654) ────────────────────────────────────────────

/**
 * What a `status` claims about the issue a baseline cites.
 *
 * `open` is the ordinary case: a live bug, so the issue must still be OPEN — a
 * closed one means the fix landed and the exemption is orphaned baseline. That
 * exact rot was live when #654 was written (nine edit-gate entries citing closed
 * #436), and no test can see it, because issue state lives on GitHub. So the
 * check is a script (`scripts/check-known-failures.mjs`), and this type is the
 * contract it and the gates share.
 *
 * `accepted` is a recorded by-design decision (#326's lossy `toWinAnsi()`
 * substitution) whose issue is normally CLOSED — which is why it cannot simply
 * be inferred from issue state and has to be declared. It is for a tradeoff
 * somebody wrote down, never for quieting the script.
 */
export type BaselineStatus = "open" | "accepted";

/** One baselined category on one fixture, with the issue that owns it. */
export interface KnownFailure<C extends string> {
  category: C;
  /** The GitHub issue number this exemption is charged to. */
  issue: number;
  status: BaselineStatus;
  /** Why this fixture fails, in prose. Required — an exemption nobody can
   *  explain is an exemption nobody can retire. */
  note: string;
}

/**
 * The on-disk shape of a `*.known-failures.json` file.
 *
 * `categories` is carried IN the file rather than only in the gate: the CI
 * script has to validate category names and cannot import a `.ts` test module to
 * learn them. `loadKnownFailures` asserts the file's list equals the gate's own
 * `CATEGORIES` const, so the two cannot drift — the duplication is pinned, not
 * trusted.
 */
export interface KnownFailuresFile {
  categories: readonly string[];
  /**
   * Deliberately typed LOOSE (`status: string`, not `BaselineStatus`): this is
   * the shape TypeScript infers for an imported `.json`, and narrowing it here
   * would only mean a cast at every call site. `loadKnownFailures` is the
   * narrowing — it validates and returns the typed map, which is the one place
   * the check can also produce a message a contributor can act on.
   */
  baselines: Record<
    string,
    readonly { category: string; issue: number; status: string; note: string }[]
  >;
}

/**
 * Validate a `*.known-failures.json` against a gate's category union and return
 * its baselines, typed.
 *
 * Throws plain `Error`s rather than using `expect`, because both gates call this
 * at MODULE scope (the per-fixture `it`s are generated from the fixture walk, so
 * the baseline has to exist before any test body runs) — and `expect` outside a
 * test has no test to fail. Precedent: `sections.config.ts`'s validating loader.
 *
 * Every check here is one the CI script ALSO performs, deliberately: the script
 * is the only thing that can reach GitHub for issue state, but a malformed
 * baseline should break the test run a contributor is already watching, not only
 * CI.
 */
export function loadKnownFailures<C extends string>(
  file: KnownFailuresFile,
  categories: readonly C[],
): Record<string, KnownFailure<C>[]> {
  const bad = (msg: string): never => {
    throw new Error(`[known-failures] ${msg}`);
  };
  const allowed = new Set<string>(categories);
  if (
    file.categories.length !== categories.length ||
    file.categories.some((c, i) => c !== categories[i])
  ) {
    bad(
      `the JSON's \`categories\` (${file.categories.join(", ")}) must match the ` +
        `gate's CATEGORIES (${categories.join(", ")}) exactly`,
    );
  }

  for (const [key, entries] of Object.entries(file.baselines)) {
    const seen = new Set<string>();
    for (const entry of entries) {
      validateBaselineEntry(entry, key, allowed, seen, bad);
      seen.add(entry.category);
    }
  }
  return file.baselines as Record<string, KnownFailure<C>[]>;
}

/**
 * One baseline entry: a known category, not already claimed for this fixture,
 * and a well-formed `{issue, status, note}` triple. Split out of
 * {@link loadKnownFailures} so the loader reads as the walk it is — the entry
 * rules are a flat list of independent checks and do not need to be inlined to
 * be understood.
 */
function validateBaselineEntry(
  // The LOOSE entry shape (`status: string`) — see {@link KnownFailuresFile}.
  // This function is part of the narrowing, so it must accept the un-narrowed
  // input rather than presuppose the check it performs.
  entry: KnownFailuresFile["baselines"][string][number],
  key: string,
  allowed: ReadonlySet<string>,
  seen: ReadonlySet<string>,
  bad: (msg: string) => never,
): void {
  const at = `${key}/${entry.category}`;
  if (!allowed.has(entry.category)) bad(`${key}: unknown category "${entry.category}"`);
  if (seen.has(entry.category)) bad(`${key}: duplicate baseline for "${entry.category}"`);
  if (!Number.isInteger(entry.issue) || entry.issue <= 0)
    bad(`${at}: \`issue\` must be a positive integer`);
  if (entry.status !== "open" && entry.status !== "accepted")
    bad(`${at}: unknown status "${entry.status}"`);
  if (!entry.note || entry.note.trim().length === 0)
    bad(`${at}: \`note\` is required`);
}

/** The set of categories one fixture is currently allowed to fail — the shape
 *  {@link assertRatchet} takes. Absent key ⇒ empty set (nothing exempt). */
export function baselineCategories<C extends string>(
  knownFailures: Record<string, KnownFailure<C>[]>,
  rel: string,
): ReadonlySet<C> {
  return new Set((knownFailures[rel] ?? []).map((e) => e.category));
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
