// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Change-scoped test selector for the LOCAL pre-push gate (#828).
 *
 * `npm run verify` ran the whole suite on every push: 348 files, ~165s, of which
 * 64% is spent parsing the fixture PDFs through pdfjs whether or not the push
 * touched the parser. This script decides — from the changed paths alone —
 * whether that whole suite is needed, and otherwise hands vitest a `--changed`
 * range so it selects tests off its own module graph.
 *
 * CI IS UNCHANGED and still runs everything (`.github/workflows/ci.yml` calls
 * `npm run test:coverage` directly, not this script). That asymmetry is the whole
 * safety argument: branch protection requires the CI `verify` job, so a local
 * under-selection can cost a red check, never a bad merge. Nothing here is
 * allowed to become the last line of defence.
 *
 * ── Why vitest's graph, and not a hand-maintained "heavy suites" list ──
 * The obvious design is to tag the slow suites and skip them unless a trigger
 * path changes. It was measured and rejected. The 18 slowest files transitively
 * reach 93 modules across 12 directories — `heuristics/`, `pdf/`, `edit/`,
 * `score/`, but also `contact/`, `lexicon/`, `rewrite-review/`, `webllm/`,
 * `hooks/` and two files loose in `src/lib/`. A hand-written trigger list over
 * that surface is wrong the first time someone adds an import, and it fails
 * SILENTLY (the test is skipped, the gate stays green). `vitest --changed` reads
 * the real graph, so it cannot drift. It also follows the tier `import()`s in
 * `cascade.ts` — verified by editing `openresume.ts`, which is reached only
 * dynamically, and watching all three corpus suites get selected.
 *
 * ── The one thing the graph cannot see ──
 * The corpus suites do not IMPORT their fixtures. They `readdirSync` the
 * `tests/fixtures/pdfs/` tree and `readFileSync` each PDF (see
 * `corpus.test.ts:116`, `projections.test.ts:122`,
 * `export-layout-contract.test.ts:68`), and the same is true of every
 * `*.expected.json` snapshot, `*.truth.json` ground truth and
 * `*.known-failures.json` ratchet. None of those files is a module, so adding a
 * fixture is invisible to `--changed` — the exact change that most needs the
 * corpus to run selects nothing at all.
 *
 * Hence the rule, which is deliberately one sentence rather than a trigger table:
 * SCOPE THE RUN ONLY WHEN EVERY CHANGED PATH IS AN ADDED-OR-MODIFIED `.ts`/`.tsx`
 * FILE UNDER `src/`. Anything else — a fixture, a JSON baseline, a lockfile, a
 * config, anything under `scripts/` or `packages/`, or ANY deletion or rename —
 * runs the full suite. Every unknown fails toward running more, so a future file
 * type nobody thought about is safe by default, and the failure mode of getting
 * the rule wrong is a slow gate rather than a missed regression.
 *
 * Deletions are called out separately because they are the one SOURCE change the
 * graph mishandles: a deleted module is absent from the graph it used to be in,
 * so its dependents' tests are not selected and the breakage surfaces only in CI.
 *
 * Escape hatch: `OFFLINECV_FULL_TESTS=1` forces the full suite. It composes with
 * the existing `OFFLINECV_SKIP_HOOKS=1`, which skips the gate entirely.
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** Where the push range is measured from when the caller names no base. */
export const DEFAULT_BASE = "origin/main";

/**
 * Decide what to run from a `git diff --name-status` listing.
 *
 * Pure over already-collected git output so the rule is unit-testable without a
 * repository — the collection below is the part that needs one.
 *
 * @param {Array<{status: string, path: string}>} changes
 * @returns {{mode: "full" | "changed", reason: string}}
 */
export function decideSelection(changes) {
  if (changes.length === 0) {
    // No diff at all. Something is off with the range (a stale `origin/main`, a
    // detached HEAD), and an empty selection would make the gate a no-op, which
    // is the one outcome worse than a slow gate.
    return { mode: "full", reason: "no changed paths resolved from the range" };
  }

  for (const { status, path } of changes) {
    // `git diff --name-status` prefixes renames/copies with a similarity score
    // (`R096`, `C075`); a bare letter is everything else.
    const kind = status[0];
    if (kind !== "A" && kind !== "M") {
      return { mode: "full", reason: `${path} is not an add or a modify (${status})` };
    }
    if (!path.startsWith("src/")) {
      return { mode: "full", reason: `${path} is outside src/` };
    }
    if (!path.endsWith(".ts") && !path.endsWith(".tsx")) {
      return { mode: "full", reason: `${path} is not a module vitest can graph` };
    }
  }

  return {
    mode: "changed",
    reason: `${changes.length} changed path(s), all added/modified TS under src/`,
  };
}

/** Run a git command, returning its stdout or `null` if git itself failed. */
function git(args) {
  const run = spawnSync("git", args, { encoding: "utf8" });
  if (run.status !== 0) return null;
  return run.stdout;
}

/**
 * Collect every path the push would carry: committed changes since `base`, plus
 * whatever is still uncommitted. The gate runs before a push but a developer can
 * invoke it by hand mid-edit, and a selection that ignored the working tree
 * would test a tree that does not exist.
 *
 * @returns {{changes: Array<{status: string, path: string}>, base: string} | null}
 *   `null` when the base ref cannot be resolved — the caller runs everything.
 */
export function collectChanges(base = DEFAULT_BASE) {
  if (git(["rev-parse", "--verify", "--quiet", `${base}^{commit}`]) === null) {
    return null;
  }

  const ranges = [
    ["diff", "--name-status", `${base}...HEAD`],
    ["diff", "--name-status", "HEAD"],
  ];

  /** @type {Map<string, string>} */
  const byPath = new Map();
  for (const args of ranges) {
    const out = git(args);
    if (out === null) return null;
    for (const line of out.split("\n")) {
      if (!line.trim()) continue;
      const [status, ...paths] = line.split("\t");
      // A rename line carries both the old and the new path; the old one is the
      // deletion half, and `decideSelection` rejects the whole run on the status
      // anyway, so recording either is enough.
      for (const path of paths) byPath.set(path, status);
    }
  }

  // Untracked files are additions git's diff does not report.
  const untracked = git(["ls-files", "--others", "--exclude-standard"]);
  if (untracked !== null) {
    for (const line of untracked.split("\n")) {
      if (line.trim()) byPath.set(line, "A");
    }
  }

  return {
    base,
    changes: [...byPath].map(([path, status]) => ({ status, path })),
  };
}

async function main() {
  const base = process.argv[2] ?? DEFAULT_BASE;
  const forced = process.env.OFFLINECV_FULL_TESTS === "1";

  const collected = forced ? null : collectChanges(base);
  const decision = forced
    ? { mode: "full", reason: "OFFLINECV_FULL_TESTS=1" }
    : collected === null
      ? { mode: "full", reason: `cannot resolve ${base}` }
      : decideSelection(collected.changes);

  const args =
    decision.mode === "full" ? ["run"] : ["run", "--changed", collected.base];

  console.log(
    decision.mode === "full"
      ? `▸ full suite — ${decision.reason}`
      : `▸ scoped to changes since ${collected.base} — ${decision.reason}`,
  );

  const run = spawnSync("npx", ["vitest", ...args], { stdio: "inherit" });
  process.exitCode = run.status ?? 1;
}

// Only select when run as a script; importing this module (the unit tests do)
// must not shell out to vitest.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
