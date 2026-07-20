// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Education-section dev probe — inert in CI, runs ONLY when
 * `RL_EDUCATION_PDF=<path>` is set:
 *
 *   RL_EDUCATION_PDF=/abs/path/to/resume.pdf npx vitest run \
 *     src/lib/heuristics/probe-education.test.ts
 *
 * Extracts + VERIFIES the education section of one arbitrary PDF so a real
 * (uncommitted, possibly PII-bearing) résumé can be triaged WITHOUT being
 * committed as a fixture. This is the execution vehicle for the
 * `probe-education` skill — sibling of `probe-contact` / `probe-experience` /
 * `probe-roundtrip` / `probe-skills`; the pattern is identical: run the real
 * parser via runCascade (the pdfjs worker only resolves under the vitest
 * transform — no standalone script), then show the section router's INPUT (the
 * header candidates + the education region it scanned) next to its OUTPUT
 * (the parsed entries) so a dropped / merged / mis-chunked entry is
 * localizable to a layer.
 *
 * ── PII guardrail (same rules as the sibling probes) ──
 * 1. The input PDF is local-only. NEVER commit it. `tests/fixtures/pdfs/` is
 *    synthetic-personas-only by policy.
 * 2. The console + JSON output prints degree / institution / field / date
 *    VALUES so the corruption is visible → scratch only. The full JSON goes to
 *    the gitignored `internal/education/` dir. Do not paste raw values into an
 *    issue / PR / Slack — cite the corruption by CATEGORY ("education count
 *    2 → 1; two-degree section collapsed into one entry", "field dropped
 *    though present in the degree line").
 *
 * ── The "verify" pass ──
 * There is no ground truth for a real résumé, so verification is an
 * independent scan of the document's header candidates + a `DEGREE_RE`-token
 * count over the ROUTED region. The oracle:
 *   - parsed entries > 0, no count mismatch          → ok
 *   - 0 entries, education region WAS routed         → EXTRACTION-MISS (region
 *     found; the chunker or field heuristic rejected every candidate line)
 *   - 0 entries, NO region, but a header candidate loosely reads as education
 *     that the strict matcher rejected                → HEADER-UNRECOGNIZED
 *     (leading glyph, out-of-alias wording, two-line wrap — the routing class)
 *   - entries > 0 AND region has MORE `DEGREE_RE` tokens than entries
 *                                                     → UNDER-CHUNKED (two
 *     degrees collapsed into one entry, or a section-routing bug narrowed the
 *     region so a degree line landed outside it)
 *   - 0 parsed, nothing education-like anywhere      → NO-EDUCATION-SECTION
 *
 * A degree-less program entry (e.g. "MIT Applied Data Science Program (2023) —
 * MIT Professional Education", #238) legitimately contributes an entry with
 * NO `DEGREE_RE` match, so `entries > regionDegrees` is intentionally NOT
 * flagged — the oracle is a lower bound, not an upper bound.
 */

import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";
import { runCascade } from "./cascade.ts";
import { computeAnonymousAtsScore } from "../score/score.ts";
import { localizeEducation } from "./localize/education.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

describe.runIf(process.env.RL_EDUCATION_PDF)(
  "education dev probe (RL_EDUCATION_PDF)",
  () => {
    // Deliberate monolithic diagnostic harness (mirrors probe-skills /
    // probe-experience): one linear read-out of parse → verdict so the whole
    // triage is visible in a single scroll. Not production logic.
    // fallow-ignore-next-line complexity
    it("extracts + verifies the education section for RL_EDUCATION_PDF", async () => {
      const path = process.env.RL_EDUCATION_PDF!;
      const outDir =
        process.env.RL_EDUCATION_OUT ??
        join(HERE, "../../..", "internal/education");

      const cascade = await runCascade(new Uint8Array(readFileSync(path)));
      const p = cascade.canonical.fields;

      const score = computeAnonymousAtsScore({
        parsed: { ...p },
        fieldConfidence: cascade.canonical.fieldConfidence,
        triggers: cascade.triggers,
        rawText: cascade.rawText,
        sections: cascade.canonical.sections,
      });

      const {
        entries,
        perEntry,
        educationRegion,
        regionDegrees,
        sectionOverview,
        headerCandidates,
        missedEducationHeaders,
        orphanBlock,
        verdict,
      } = localizeEducation(cascade);

      const report = {
        path,
        score: {
          overall: score.overall,
          preLayoutOverall: score.preLayoutOverall,
          layoutTriggers: [...score.layout.triggers],
          layoutMultiplier: score.layout.multiplier,
        },
        sectionOverview,
        entries,
        perEntry,
        educationRegion,
        regionDegrees,
        headerCandidates,
        missedEducationHeaders,
        orphanBlock,
        verdict,
        triggers: [...cascade.triggers],
      };

      mkdirSync(outDir, { recursive: true });
      const outFile = join(
        outDir,
        `education-${basename(path).replace(/\.[^.]+$/, "")}.json`,
      );
      writeFileSync(outFile, JSON.stringify(report, null, 2));

      const entryLines = entries.length
        ? entries
            .map(
              (e, i) =>
                `    ${i + 1}. degree=${JSON.stringify(e.degree)}  field=${JSON.stringify(e.field)}\n` +
                `       institution=${JSON.stringify(e.institution)}  location=${JSON.stringify(e.location)}\n` +
                `       dates=${JSON.stringify(e.start_date)} → ${JSON.stringify(e.end_date)}  year=${JSON.stringify(e.year)}  coursework=${e.coursework}`,
            )
            .join("\n")
        : "    (none)";

      const perEntryLines = perEntry
        .map(
          (p) =>
            `    ${p.i + 1}. ${
              p.missing.length === 0
                ? "all present"
                : `MISSING: ${p.missing.join(", ")}`
            }`,
        )
        .join("\n");

      console.log(
        `RL_EDUCATION_PDF education probe for ${path}:\n` +
          `\n  Score: overall ${score.overall} (pre-layout ${score.preLayoutOverall}, ` +
          `layout ×${score.layout.multiplier} [${score.layout.triggers.join(", ") || "none"}])\n` +
          `\n  Sections detected: ${sectionOverview.join("  ")}\n` +
          `\n  Parsed education entries (${entries.length}):\n` +
          entryLines +
          `\n\n  Education region scanned (${educationRegion.length} lines, ` +
          `${regionDegrees} DEGREE_RE tokens):\n` +
          (educationRegion.length
            ? educationRegion.map((l) => `    | ${l}`).join("\n")
            : "    (empty — no education region routed)") +
          `\n\n  Education-like headers the router REJECTED (${missedEducationHeaders.length}):\n` +
          (missedEducationHeaders.length
            ? missedEducationHeaders
                .map((h) => `    | ${JSON.stringify(h.text)} — ${h.reason}`)
                .join("\n")
            : "    (none)") +
          (orphanBlock.length
            ? `\n\n  Dropped education content under that header (${orphanBlock.length} lines — values in JSON):`
            : "") +
          (entries.length
            ? `\n\n  Per-entry field presence:\n${perEntryLines}`
            : "") +
          `\n\n  Verify: ${verdict}` +
          `\n\n  Full JSON → ${outFile}  ⚠️ gitignored; may carry PII, do NOT commit.`,
      );

      // Informational only: never fails the suite.
      expect(true).toBe(true);
    });
  },
);
