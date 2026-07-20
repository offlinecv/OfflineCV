// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Whole-résumé sweep probe (#469) — inert in CI, runs ONLY when
 * `RL_RESUME_PDF=<path>` is set:
 *
 *   RL_RESUME_PDF=/abs/path/to/resume.pdf npx vitest run \
 *     src/lib/heuristics/probe-resume.test.ts
 *
 * The execution vehicle for the `probe-resume` skill — the orchestrator of the
 * six single-section probes (`probe-{contact,skills,experience,education,
 * achievements,roundtrip}`). It runs ONE `runCascade()` and ONE render → re-parse
 * hop, drives every localizer off that single parse, and then answers the one
 * question no single-section probe can:
 *
 *   > This résumé exhibits defect class C. **Does a fixture already reproduce C?**
 *
 * `COVERED` means STOP: go fix the parser against the existing fixture and never
 * open the real résumé again. `NO FIXTURE COVERS THIS` is the only answer that
 * justifies minting a new synthetic fixture — and this harness MINTS NOTHING and
 * COMMITS NOTHING. It prints the next step; a human takes it.
 *
 * ── PII guardrail (same rules as the six siblings) ──
 * 1. The input PDF is local-only. NEVER commit it. It is not a fixture;
 *    `tests/fixtures/pdfs/` is synthetic-personas-only by policy.
 * 2. Unlike the siblings, this harness's CONSOLE OUTPUT PRINTS NO RÉSUMÉ VALUES
 *    AT ALL — only defect CLASSES, axis names, fixture paths, counts, and
 *    booleans. Every one of those is PII-free by construction (`ReproArtifact` +
 *    `DerivedSignals` admit no free-form string). The only free-form string it
 *    echoes is the PDF path YOU passed in, which may carry a name — so still do
 *    not paste the console output verbatim into an issue/PR/Slack. Cite a defect
 *    by CLASS.
 * 3. The full JSON report goes to `RL_RESUME_OUT` (default `internal/resume/`,
 *    gitignored). It, too, carries only the artifact + derived booleans + the
 *    coverage map. An override that points inside the repo at a NON-gitignored
 *    path is a hard failure, not a warning.
 *
 * | Var | Default | Meaning |
 * |---|---|---|
 * | `RL_RESUME_PDF` | *(unset)* | Absolute path to the résumé PDF. Unset → inert. |
 * | `RL_RESUME_OUT` | `internal/resume/` | Directory for the full JSON report. |
 */

import { execFileSync } from "node:child_process";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

import { describe, it, expect } from "vitest";

import { runCascade } from "./cascade.ts";
import { runRoundtripHop } from "./roundtrip-hop.ts";
import { buildReproArtifact } from "./repro-artifact.ts";
import type { ReproArtifact } from "./repro-artifact.ts";
import type { DefectClass, DerivedSignals, Oracle } from "./defect-classes.ts";
import {
  DEFECT_CLASSES,
  ORACLE_UNAVAILABLE_KEY,
  defectSpec,
  isAdvisory,
  unavailableOracles,
} from "./defect-classes.ts";
import { sweepParse, isParseUnreadable } from "./sweep.ts";
import type { FixtureCoverage } from "./fixture-match.ts";
import { matchCorpus } from "./fixture-match.ts";
import { loadCorpus, REPO_ROOT } from "./__test-utils__/corpus-snapshots.ts";

/**
 * The report directory, validated.
 *
 * The default (`internal/`) is gitignored (`.gitignore:61`). An override is
 * allowed — the maintainer may want the report on a scratch volume — but an
 * override that lands INSIDE the repo and is NOT gitignored would stage a
 * diagnostics file for commit, which is exactly the accident the PII policy
 * exists to prevent. `git check-ignore` is the authority (it honours every
 * ignore layer, including a global one); if git cannot be consulted at all we
 * fail closed rather than guess.
 */
function resolveOutDir(): string {
  const override = process.env.RL_RESUME_OUT;
  if (!override) return join(REPO_ROOT, "internal/resume");

  const dir = isAbsolute(override) ? override : resolve(process.cwd(), override);
  const rel = relative(REPO_ROOT, dir);
  const insideRepo = rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  if (!insideRepo) return dir; // outside the repo → nothing can be committed.

  try {
    execFileSync("git", ["check-ignore", "-q", "--", dir], { cwd: REPO_ROOT });
    return dir; // exit 0 ⇒ ignored.
  } catch {
    throw new Error(
      `RL_RESUME_OUT="${override}" resolves inside the repo at "${rel}" and is NOT ` +
        `gitignored. The report is a diagnostics artifact derived from a real résumé — ` +
        `it must never become committable. Point RL_RESUME_OUT at a gitignored path ` +
        `(the default "internal/resume/") or somewhere outside the repo.`,
    );
  }
}

/** `COVERED …` / `NO FIXTURE COVERS THIS` + the why-not, for one class.
 *
 *  `coveredBy[0]` is the CLOSEST cover by whole-artifact divergence, not the
 *  alphabetically-first one (`fixture-match.ts` ranks the list). Every entry is
 *  an equally valid reproducer; the ranking only decides which one is worth
 *  printing when there are 34 of them. */
function renderCoverage(c: FixtureCoverage, resumePath: string): string {
  const head = `  ${c.class.padEnd(34)}`;
  if (c.coveredBy.length > 0) {
    const extra =
      c.coveredBy.length > 1
        ? `  (closest of ${c.coveredBy.length}; full list in JSON)`
        : "";
    return `${head} → COVERED  ${c.coveredBy[0]}${extra}`;
  }

  // Uncovered. Print the nearest fixtures, the axes that diverged, and — always —
  // how many candidates the cap hid, so the list is never a silent truncation.
  const shown = c.nearMisses.length;
  const lines = [
    `${head} → NO FIXTURE COVERS THIS`,
    `        nearest (showing ${shown} of ${c.nearMissCandidateCount}):`,
    ...c.nearMisses.map(
      (m) =>
        `          - ${m.fixture}\n            diverged: ` +
        (m.divergedAxes.length
          ? m.divergedAxes.join(", ")
          : "(none — matches on every load-bearing axis yet does not exhibit the " +
            "class; suspect the defect table, not the fixture)"),
    ),
    `        → next step (nothing is minted or committed for you):`,
    `          1. re-export a template with a SYNTHETIC persona reproducing \`${c.class}\``,
    `             → tests/fixtures/pdfs/<category>/<name>.pdf  (see tests/fixtures/pdfs/README.md)`,
    `          2. npm run bake-fixtures`,
    `          3. add src/lib/heuristics/<name>.repro.test.ts pinning \`${c.class}\``,
    `          4. re-run: RL_RESUME_PDF=${resumePath} npx vitest run src/lib/heuristics/probe-resume.test.ts`,
  ];
  return lines.join("\n");
}

/** `name(lineCount)` per routed section — PII-free (a section NAME is a fixed
 *  enum, a line COUNT is a number). This is the pointer every `*-no-section`
 *  advisory leans on: it is how a reader tells "the résumé has no skills block"
 *  from "the skills block got swallowed by `profile`". */
function renderSections(a: ReproArtifact): string {
  return a.sections.length
    ? a.sections.map((s) => `${s.name}(${s.lineCount})`).join(" ")
    : "(none — the section router cut nothing)";
}

/** Why each oracle went blind, and what that costs. Static prose — no values. */
const ORACLE_BANNER: Readonly<Record<Oracle, string[]>> = {
  text: [
    "⛔ TEXT ORACLE UNAVAILABLE — this parse produced NO readable text",
    "   (the layout probe called the PDF `scanned`, or rawText came back empty).",
    "   EVERY defect signal below the round-trip is read out of that text, so none",
    "   of them could be computed. This is NOT a clean résumé — it is a résumé this",
    "   parser could not read, which is offlinecv's single most severe failure mode.",
  ],
  header: [
    "⚠️  HEADER ORACLE UNAVAILABLE — this parse produced NO markdown",
    "   (scanned PDF, or a document too sparse for the markdown emitter).",
    "   The rejected-header signal is derived ONLY from markdown headers, so a",
    "   header the strict router rejected cannot be told apart from \"the résumé",
    "   simply has no such section\" on this document.",
  ],
  roundtrip: [
    "⚠️  ROUNDTRIP ORACLE UNAVAILABLE — the export → re-parse hop produced no `after`",
    "   parse (a layer of buildAtsResumeModel → renderAtsResumePdf → runCascade threw;",
    "   `roundtrip-render-crash` reports the crash itself).",
    "   The value diffs are a BEFORE→AFTER comparison, so with no `after` there was",
    "   nothing to compare — \"no value changed\" would be a claim about a round-trip",
    "   that never happened.",
  ],
};

/** One banner per blind oracle, naming the classes it WITHHELD. Withholding is
 *  the whole point: a class whose oracle is blind is undecided, and its silence
 *  below must never be read as "clean". */
function oracleBanner(o: Oracle): string {
  const withheld = DEFECT_CLASSES.filter((c) =>
    defectSpec(c).requires.includes(o),
  );
  return (
    "\n" +
    ORACLE_BANNER[o].map((l) => `  ${l}`).join("\n") +
    `\n   WITHHELD (${withheld.length} classes — undecidable on this parse, NOT clean):\n` +
    withheld.map((c) => `     - ${c}`).join("\n") +
    `\n   signal: derived.${ORACLE_UNAVAILABLE_KEY[o]} = true\n`
  );
}

/** The DEAD-PARSE read-out. There is deliberately NO `DEFECTS FOUND` line and NO
 *  `COVERAGE` number here: both would be affirmative claims about a parse whose
 *  oracles never ran, and a false "clean" is worse than no answer. */
function renderUnreadable(
  a: ReproArtifact,
  claimed: DefectClass[],
  withheld: DefectClass[],
): string {
  const stillClaimed = claimed.filter((c) => !withheld.includes(c));
  return (
    `\n  ⛔ PARSE UNREADABLE — DEFECT REPORT AND COVERAGE ARE WITHHELD\n` +
    `     rawCharCount=${a.rawCharCount}  extractedCharCount=${a.extractedCharCount}` +
    `  triggers=[${a.triggers.join(", ") || "none"}]\n` +
    `     The parser read nothing out of this document, so NO defect class in the\n` +
    `     table could be evaluated and NO corpus coverage can be claimed. Do not\n` +
    `     read the absence of a DEFECTS FOUND block as "no defects": the correct\n` +
    `     reading is "this résumé did not parse at all".\n` +
    (withheld.length
      ? `     ${withheld.length} classes withheld (see the banner above).\n`
      : `     0 classes withheld — no oracle banner fired above (the parse read\n` +
        `     nothing structured despite the text oracle being available; see\n` +
        `     rawCharCount/extractedCharCount below).\n`) +
    `     Observed regardless of the blind oracles: ` +
    (stillClaimed.length ? stillClaimed.join(", ") : "(none)") +
    `\n     → next step: this is a Tier-0 extraction failure, not a fixture-coverage\n` +
    `       question. Triage the extraction (scanned/OCR, unmappable fonts), not the\n` +
    `       section localizers.`
  );
}

/** The normal read-out: the defect list + its corpus coverage. */
function renderDefects(
  coverage: FixtureCoverage[],
  defects: DefectClass[],
  covered: number,
  path: string,
): string {
  if (defects.length) {
    return (
      `\n  DEFECTS FOUND (${defects.length})\n\n` +
      coverage.map((c) => renderCoverage(c, path)).join("\n") +
      `\n\n  COVERAGE  ${covered}/${defects.length} defects already pinned by the corpus`
    );
  }
  return (
    `\n  DEFECTS FOUND (0)\n` +
    `    (none — no defect class in the table is exhibited by this parse)\n` +
    `    Read this together with INFORMATIONAL and 'Sections detected' below: a\n` +
    `    section that produced NOTHING is reported there, not here, and if the\n` +
    `    résumé actually carries that section this parse is NOT clean.\n` +
    `\n  COVERAGE  0/0 defects already pinned by the corpus`
  );
}

describe.runIf(process.env.RL_RESUME_PDF)(
  "whole-résumé sweep probe (RL_RESUME_PDF)",
  () => {
    // Deliberate monolithic diagnostic harness (mirrors the six siblings): one
    // linear read-out of parse → defects → corpus coverage, visible in a single
    // scroll. Not production logic.
    // fallow-ignore-next-line complexity
    it("sweeps every section and maps each defect onto the fixture corpus", async () => {
      const path = process.env.RL_RESUME_PDF!;
      const outDir = resolveOutDir();

      // ── ONE parse, ONE hop. Every localizer is driven off these two. ────────
      const cascade = await runCascade(new Uint8Array(readFileSync(path)));
      const hop = await runRoundtripHop(cascade);

      // `sweepParse()` is the SAME function `corpus.test.ts` bakes each fixture's
      // `derived` with — that identity is what puts the résumé and the corpus on
      // the same axes. It also applies the ORACLE GATE: a class whose oracle
      // could not run lands in `withheld`, never in `defects`.
      const sweep = sweepParse(cascade, hop);
      const derived: DerivedSignals = sweep.derived;
      const artifact = buildReproArtifact(cascade);

      // ── DEFECTS vs INFORMATIONAL. The three `*-no-section` classes are
      // ADVISORY (`DefectSpec.advisory`): "this résumé has no Awards section" is
      // not a parser defect — 34 of the 45 fixtures parse zero achievements.
      // Counting them as defects fires on nearly every résumé, corpus-matches
      // trivially, and INFLATES `COVERAGE n/m`. They are still PRINTED — next to
      // the section overview, which is the only thing that tells "the résumé has
      // none" apart from "the block was mis-routed" — they just never enter the
      // ratio. ──────────────────────────────────────────────────────────────────
      const defects = sweep.defects.filter((c) => !isAdvisory(c));
      const informational = sweep.defects.filter((c) => isAdvisory(c));
      const withheld = sweep.withheld;
      const blindOracles = unavailableOracles(derived);

      // ── THE DEAD-PARSE GATE. `textOracleUnavailable` ⇒ the parse yielded no
      // readable text at all; `extractedCharCount === 0` ⇒ it read text but
      // produced NOTHING from it. Either way every oracle below was blind, and an
      // affirmative "no defect class is exhibited by this parse" would be a false
      // claim about a dead parse — offlinecv's most severe failure mode reported
      // as clean. The harness REFUSES: no DEFECTS FOUND block, no COVERAGE
      // number, no corpus match. The only honest output is "we could not read
      // this". ────────────────────────────────────────────────────────────────
      const unreadable = isParseUnreadable(derived, artifact.extractedCharCount);

      const corpus = loadCorpus();
      // Coverage is a claim about defects. Over an unreadable parse there are no
      // trustworthy defects to make claims about, so none is computed.
      const coverage = unreadable
        ? []
        : matchCorpus(artifact, derived, defects, corpus);
      const covered = coverage.filter((c) => c.coveredBy.length > 0).length;

      // ── The JSON report: artifact + derived + coverage. PII-free by type; it
      // still goes ONLY to the gitignored out dir. ────────────────────────────
      const report = {
        path,
        corpusSize: corpus.length,
        unreadable,
        defects: unreadable ? [] : defects,
        informational: unreadable ? [] : informational,
        withheld,
        unavailableOracles: blindOracles,
        localizerClaims: sweep.defects,
        sections: artifact.sections,
        coverage,
        reproArtifact: artifact,
        derived,
      };
      mkdirSync(outDir, { recursive: true });
      const outFile = join(
        outDir,
        `resume-${basename(path).replace(/\.[^.]+$/, "")}.json`,
      );
      writeFileSync(outFile, JSON.stringify(report, null, 2));

      // ── The read-out. Classes, axes, fixture paths, counts, booleans, static
      // prose. No résumé values, anywhere. ───────────────────────────────────
      console.log(
        `RL_RESUME_PDF résumé sweep for ${path}:\n` +
          `\n  Corpus: ${corpus.length} baked fixtures\n` +
          blindOracles.map(oracleBanner).join("") +
          (unreadable
            ? renderUnreadable(artifact, sweep.defects, withheld)
            : renderDefects(coverage, defects, covered, path)) +
          // The section overview: `name(lineCount)` per routed region, next to
          // rawCharCount/extractedCharCount so an unaccounted-for region is
          // visible — PII-free (counts only), and load-bearing for the
          // advisories immediately below it: a `skills-no-section` on a résumé
          // that HAS a skills block shows up either as a fat `profile`/`other`
          // bucket that swallowed it, or as summed section line counts that
          // don't account for the extracted characters (it vanished entirely).
          `\n\n  Sections detected (rawCharCount=${artifact.rawCharCount} ` +
          `extractedCharCount=${artifact.extractedCharCount}): ${renderSections(artifact)}` +
          // The JSON report zeroes `informational` on the unreadable path (no
          // oracle ran, so an advisory claim is as undecidable as a defect
          // claim); the console must say the same thing, not print a non-empty
          // list that contradicts it.
          (unreadable
            ? `\n\n  INFORMATIONAL — withheld (parse unreadable; see banner above)`
            : `\n\n  INFORMATIONAL (${informational.length}) — not defects; excluded from COVERAGE\n` +
              (informational.length
                ? informational
                    .map(
                      (c) =>
                        `    ${c.padEnd(34)} no such section was routed. If the résumé DOES carry one,\n` +
                        `    ${" ".repeat(34)} the block was mis-routed — look for it in 'Sections detected'\n` +
                        `    ${" ".repeat(34)} above (a fat profile/other bucket that swallowed it), or it\n` +
                        `    ${" ".repeat(34)} landed nowhere at all — compare the section line counts to\n` +
                        `    ${" ".repeat(34)} extractedCharCount above.`,
                    )
                    .join("\n")
                : "    (none)")) +
          `\n\n  Probes per defect: ` +
          (defects.length && !unreadable
            ? defects.map((c) => `${c}=${defectSpec(c).probe}`).join("  ")
            : "(none)") +
          `\n\n  Full JSON → ${outFile}  ⚠️ gitignored; do NOT commit.`,
      );

      // The sweep is a diagnostic: it never fails on what it FINDS. But it must
      // fail if it could not do its job — a corpus that loaded to nothing would
      // report every defect as "NO FIXTURE COVERS THIS", which reads as a
      // legitimate result. (`loadCorpus` also throws on a stale snapshot; this
      // is the belt to its braces.)
      expect(corpus.length).toBeGreaterThan(0);
    });
  },
);
