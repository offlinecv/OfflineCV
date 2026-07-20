// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * The corpus loader (issue #469, step 6) — the sweep's I/O half.
 *
 * `fixture-match.ts` is pure by design: it takes `CorpusEntry[]` and never
 * touches the disk. Somebody still has to READ the 45 baked snapshots, and that
 * somebody is here. Kept out of `src/lib/heuristics/*.ts` proper because it
 * imports `node:fs` and is test-only.
 *
 * Each `tests/fixtures/pdfs/<cat>/<name>.expected.json` is, at schemaVersion 5:
 *
 *   { schemaVersion: 5, cascade, score, reproArtifact, derived }
 *
 * where `reproArtifact` is exactly `ReproArtifact` and `derived` is the full
 * `DerivedSignals` bag. Both are PII-free by type (numbers, booleans, fixed
 * enums), which is why they are safe to commit at all.
 *
 * ── Why the schemaVersion guard FAILS LOUDLY ──
 * A stale v4 snapshot has no `reproArtifact` and no `derived`. Silently skipping
 * it — or defaulting it to an empty artifact — would quietly shrink the corpus,
 * and a shrunken corpus does not report an error: it reports "NO FIXTURE COVERS
 * THIS". That is the single worst failure mode of the whole tool, because it
 * reads as a legitimate result and its remedy ("mint a fixture") duplicates one
 * we already have. So: any snapshot that is not v5-with-both-blocks is a throw,
 * naming the file and the fix (`npm run bake-fixtures`).
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import type { CorpusEntry } from "../fixture-match.ts";
import type { DerivedSignals } from "../defect-classes.ts";
import { DERIVED_SIGNAL_KEYS } from "../defect-classes.ts";
import type { ReproArtifact } from "../repro-artifact.ts";

/** The snapshot schema the loader (and `corpus.test.ts`'s bake) speaks. */
export const CORPUS_SNAPSHOT_SCHEMA_VERSION = 5;

const HERE = dirname(fileURLToPath(import.meta.url));
/** `src/lib/heuristics/__test-utils__` → repo root. */
export const REPO_ROOT = join(HERE, "../../../..");
const FIXTURE_ROOT = join(REPO_ROOT, "tests/fixtures/pdfs");

function walkSnapshots(dir: string): string[] {
  const out: string[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walkSnapshots(p));
    else if (e.isFile() && e.name.endsWith(".expected.json")) out.push(p);
  }
  return out.sort();
}

/**
 * Every baked fixture snapshot, as `CorpusEntry[]` ready for `matchCorpus()`.
 *
 * `path` is the repo-relative **PDF** path (not the snapshot's), because that is
 * what a human is told to go open. Throws — never degrades — on a snapshot that
 * is stale, malformed, or missing its PDF.
 */
export function loadCorpus(fixtureRoot: string = FIXTURE_ROOT): CorpusEntry[] {
  const snapshots = walkSnapshots(fixtureRoot);
  const problems: string[] = [];
  const corpus: CorpusEntry[] = [];

  for (const snap of snapshots) {
    const rel = relative(REPO_ROOT, snap);
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(readFileSync(snap, "utf8")) as Record<string, unknown>;
    } catch (err) {
      problems.push(`${rel}: unparseable JSON (${(err as Error).message})`);
      continue;
    }

    if (json.schemaVersion !== CORPUS_SNAPSHOT_SCHEMA_VERSION) {
      problems.push(
        `${rel}: schemaVersion ${String(json.schemaVersion)} — expected ${CORPUS_SNAPSHOT_SCHEMA_VERSION}`,
      );
      continue;
    }
    if (!json.reproArtifact || typeof json.reproArtifact !== "object") {
      problems.push(`${rel}: missing the \`reproArtifact\` block`);
      continue;
    }
    const derived = json.derived as Record<string, unknown> | undefined;
    if (!derived || typeof derived !== "object") {
      problems.push(`${rel}: missing the \`derived\` block`);
      continue;
    }
    const missing = DERIVED_SIGNAL_KEYS.filter(
      (k) => typeof derived[k] !== "boolean",
    );
    if (missing.length > 0) {
      problems.push(
        `${rel}: \`derived\` is missing/non-boolean for: ${missing.join(", ")}`,
      );
      continue;
    }

    const pdf = snap.replace(/\.expected\.json$/, ".pdf");
    if (!existsSync(pdf)) {
      problems.push(`${rel}: no sibling PDF at ${relative(REPO_ROOT, pdf)}`);
      continue;
    }

    corpus.push({
      path: relative(REPO_ROOT, pdf),
      artifact: json.reproArtifact as ReproArtifact,
      derived: derived as unknown as DerivedSignals,
    });
  }

  if (problems.length > 0) {
    throw new Error(
      `loadCorpus: ${problems.length} unusable fixture snapshot(s). A stale snapshot ` +
        `silently degrades coverage to "NO FIXTURE COVERS THIS", so this is fatal. ` +
        `Re-bake with \`npm run bake-fixtures\`.\n  - ${problems.join("\n  - ")}`,
    );
  }
  if (corpus.length === 0) {
    throw new Error(`loadCorpus: no fixture snapshots found under ${fixtureRoot}`);
  }

  return corpus;
}
