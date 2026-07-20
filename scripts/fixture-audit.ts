// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * The fixture-ledger staleness auditor (`npm run fixture-audit`, issue #39).
 *
 * A maintainer-only REPORT. Never wired into CI, never exits non-zero on
 * staleness — a moved signature or a healed bug is NEWS for a human, not a build
 * break. (It exits non-zero only on a usage/IO error it cannot proceed past.)
 *
 * For every row in `internal/fixtures/registry.jsonl` it checks three things:
 *
 *   (a) SOURCE — does `sources.local.json` still resolve the row's handle to a
 *       file on disk, and does that file still hash to the recorded `sha256`?
 *       A missing path is expected on a machine that never held the résumé; a
 *       hash MISMATCH means the source was edited/replaced under a stale row.
 *
 *   (b) REPRO — re-parse the fixture and re-sweep it; does its signature still
 *       `exhibits()` the recorded class? If NOT, the parser most likely improved
 *       and the fixture no longer reproduces the bug → "signature moved → flip
 *       status to fixed".
 *
 *   (c) BREADCRUMB — any fixture PDF whose `.origin.json` `reproduces:[N]` has no
 *       matching `src/lib/heuristics/*.repro.test.ts` referencing `#N`. (The
 *       corpus test enforces this too; here it is surfaced as a report line so a
 *       maintainer scanning the whole corpus sees it without running vitest.)
 *
 * PII-safe: reads the committed row (opaque handle + hashes + PII-free artifacts)
 * and the fixture PDFs; the only real path it touches is the one it reads from
 * the gitignored `sources.local.json`, and it prints only whether it resolves and
 * hashes — never the path itself, never a résumé value.
 *
 * Runs under vite-node. Usage: `npm run fixture-audit`.
 */

import { promises as fsp, existsSync, readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, relative } from "node:path";

import { runCascade } from "../src/lib/heuristics/cascade.ts";
import { runRoundtripHop } from "../src/lib/heuristics/roundtrip-hop.ts";
import { sweepParse } from "../src/lib/heuristics/sweep.ts";
import { buildReproArtifact } from "../src/lib/heuristics/repro-artifact.ts";
import { defectSpec, type DefectClass } from "../src/lib/heuristics/defect-classes.ts";
import { REPO_ROOT } from "../src/lib/heuristics/__test-utils__/corpus-snapshots.ts";
import {
  readOriginJson,
  reproTestsReferencingIssue,
} from "../src/lib/heuristics/__test-utils__/origin-links.ts";

const REGISTRY_PATH = join(REPO_ROOT, "internal/fixtures/registry.jsonl");
const SOURCES_PATH = join(REPO_ROOT, "internal/fixtures/sources.local.json");
const FIXTURE_ROOT = join(REPO_ROOT, "tests/fixtures/pdfs");

interface RegistryRow {
  id: string;
  source: { handle: string; sha256: string; generator: string; provenance: string };
  fixture: string;
  derivation: string;
  defects: {
    issue: number;
    class: DefectClass;
    probe: string;
    regressionTest: string;
    status: string;
  }[];
  verifiedRepro: string;
}

interface SourcesFile {
  sources?: Record<string, { stem: string; path: string | null }>;
}

function readRegistry(): RegistryRow[] {
  if (!existsSync(REGISTRY_PATH)) return [];
  return readFileSync(REGISTRY_PATH, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as RegistryRow);
}

function readSources(): SourcesFile {
  if (!existsSync(SOURCES_PATH)) return {};
  return JSON.parse(readFileSync(SOURCES_PATH, "utf8")) as SourcesFile;
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

async function exhibitsStill(fixtureRel: string, cls: DefectClass): Promise<boolean> {
  const fixturePath = join(REPO_ROOT, fixtureRel);
  const cascade = await runCascade(new Uint8Array(await fsp.readFile(fixturePath)));
  const sweep = sweepParse(cascade, await runRoundtripHop(cascade));
  return defectSpec(cls).exhibits(buildReproArtifact(cascade), sweep.derived);
}

function walkPdfs(dir: string): string[] {
  const out: string[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walkPdfs(p));
    else if (e.isFile() && e.name.toLowerCase().endsWith(".pdf")) out.push(p);
  }
  return out.sort();
}

// pdfjs (via `runCascade`) needs `Promise.withResolvers` (Node 22); the repo's
// `.nvmrc` pins Node 20, where it is absent. Fail fast with the fix instead of
// an opaque pdfjs crash deep in the audit.
if (typeof (Promise as { withResolvers?: unknown }).withResolvers !== "function") {
  console.error(
    `fixture-audit needs Node 22+ (pdfjs uses Promise.withResolvers); ` +
      `running Node ${process.version}. Run under Node 22, e.g. \`nvm use 22\`.`,
  );
  process.exit(1);
}

const rows = readRegistry();
const sources = readSources().sources ?? {};

console.log(`\n══════ fixture-ledger audit ══════`);
console.log(`registry: ${rows.length} row(s)\n`);

for (const row of rows) {
  console.log(`── ${row.id} · ${row.fixture}`);

  // (a) SOURCE resolution + hash.
  const src = sources[row.source.handle];
  if (!src || !src.path) {
    console.log(`   source(${row.source.handle}): unresolved on this machine — OK (source is local-only)`);
  } else if (!existsSync(src.path)) {
    console.log(`   source(${row.source.handle}): recorded path no longer exists — stale sources entry`);
  } else {
    const actual = sha256File(src.path);
    console.log(
      actual === row.source.sha256
        ? `   source(${row.source.handle}): resolves, sha256 matches ✔`
        : `   source(${row.source.handle}): ⚠ sha256 MISMATCH — the source file changed under this row`,
    );
  }

  // (b) REPRO still exhibits?
  if (!existsSync(join(REPO_ROOT, row.fixture))) {
    console.log(`   fixture: ⚠ MISSING at ${row.fixture}`);
  } else {
    for (const d of row.defects) {
      let still: boolean;
      try {
        still = await exhibitsStill(row.fixture, d.class);
      } catch (err) {
        console.log(`   defect ${d.class}: ⚠ re-parse threw (${(err as Error).message})`);
        continue;
      }
      if (still) {
        console.log(`   defect ${d.class} (#${d.issue}): still reproduces ✔ [status=${d.status}]`);
      } else {
        console.log(
          `   defect ${d.class} (#${d.issue}): ✱ signature moved — fixture NO LONGER exhibits this class. ` +
            `The parser likely improved → flip status "${d.status}" → "fixed".`,
        );
      }
      // Cross-check the recorded repro test still references the issue.
      if (reproTestsReferencingIssue(d.issue).length === 0) {
        console.log(`      ⚠ no *.repro.test.ts references #${d.issue} (recorded: ${d.regressionTest})`);
      }
    }
  }
}

// (c) Orphaned breadcrumbs across the WHOLE corpus (not just ledgered rows).
console.log(`\n── .origin.json breadcrumb cross-check`);
let orphan = 0;
for (const pdf of walkPdfs(FIXTURE_ROOT)) {
  const origin = readOriginJson(pdf);
  if (!origin || origin.reproduces.length === 0) continue;
  for (const issue of origin.reproduces) {
    if (reproTestsReferencingIssue(issue).length === 0) {
      orphan++;
      console.log(
        `   ⚠ ${relative(REPO_ROOT, pdf)} (ledger ${origin.ledgerId}) claims #${issue} ` +
          `but no *.repro.test.ts references it`,
      );
    }
  }
}
if (orphan === 0) console.log(`   all .origin.json reproduces[] are pinned by a repro test ✔`);

console.log(`\n══════ audit complete ══════`);
