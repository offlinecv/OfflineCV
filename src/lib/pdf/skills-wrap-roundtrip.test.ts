// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Round-trip regression for #301 — a multi-word skill token must not split
 * across the line-wrap boundary on the parse → "Download PDF" → re-parse
 * cycle.
 *
 * Mechanism (see `ats-resume-model.ts:361` and `render-ats-pdf.ts`):
 *   - Reconstruction joins all skills into ONE middot-delimited header line
 *     (`skills.join(" · ")`).
 *   - The renderer word-wraps that line. Before the fix, the wrap split on
 *     ANY whitespace (`text.split(/\s+/)`), so a wrap point could fall INSIDE
 *     a multi-word skill (e.g. between "Data" and "Warehousing" in "Cloud
 *     Data Warehousing"), breaking it across two rendered PDF lines.
 *   - On re-parse the skills tokenizer then reads the wrapped continuation as
 *     a brand-new token, so one skill became two (count N → N+1).
 *
 * The fix makes `Layout.wrap()` treat each " · "-delimited segment (a whole
 * skill) as an atomic wrap unit — the wrap point can only fall BETWEEN
 * skills, never inside one.
 *
 * No new binary PDF fixture is needed: this test reuses an in-tree synthetic
 * fixture purely to get a legitimate `CascadeResult` (satisfying
 * `buildAtsResumeModel`'s full input contract), then overrides `parsed.skills`
 * with a long, deliberately multi-word-heavy list engineered to force at
 * least one wrap boundary inside a 2-4 word skill under the old
 * `\s+`-only wrap. Round-trip correctness is asserted as an exact set/count
 * match, independent of exactly where any given line wraps.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect, beforeAll } from "vitest";
import { runCascade } from "../heuristics/cascade.ts";
import { computeAnonymousAtsScore } from "../score/score.ts";
import type { CascadeResult } from "../heuristics/types.ts";
import { buildAtsResumeModel } from "./ats-resume-model.ts";
import { renderAtsResumePdf, wrapSegmentsToLines } from "./render-ats-pdf.ts";
import { loadPdfLibOnce } from "./load-pdf-lib.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(
  HERE,
  "../../..",
  "tests/fixtures/pdfs/latex/awesome-cv-resume.pdf",
);

function scoreFor(cascade: CascadeResult) {
  return computeAnonymousAtsScore({
    parsed: { ...cascade.parsed },
    fieldConfidence: cascade.fieldConfidence,
    triggers: cascade.triggers,
    rawText: cascade.rawText,
    sections: cascade.sections,
  });
}

// A long, multi-word-heavy skill list. Several 2-4 word skills interleaved
// with single-word ones so the joined " · " line spans multiple wrapped
// lines at the renderer's header size/width — under the pre-fix `\s+`-only
// wrap, at least one of these multi-word skills is virtually guaranteed to
// straddle a wrap boundary.
const SYNTHETIC_SKILLS = [
  "Python",
  "Kubernetes",
  "Cloud Data Warehousing",
  "Terraform",
  "Site Reliability Engineering",
  "Docker",
  "Machine Learning Operations",
  "SQL",
  "Customer Relationship Management",
  "AWS",
  "Distributed Systems Design",
  "Golang",
  "Continuous Integration Pipelines",
  "React",
  "Infrastructure As Code",
  "Redis",
  "Data Warehouse Modeling",
  "Linux",
  "Security Incident Response",
  "GraphQL",
];

describe("#301 — multi-word skill does not split at the line-wrap boundary", () => {
  let reparsedSkills: string[];

  // Fixture-read + runCascade/render round-trip is slow under a
  // coverage-instrumented full-suite `verify` run; scope a higher timeout to
  // just this hook rather than bumping vitest's global default (#360).
  beforeAll(async () => {
    const original = await runCascade(new Uint8Array(readFileSync(FIXTURE)));
    const withSyntheticSkills: CascadeResult = {
      ...original,
      parsed: { ...original.parsed, skills: SYNTHETIC_SKILLS },
    };
    const model = buildAtsResumeModel(
      withSyntheticSkills,
      scoreFor(withSyntheticSkills),
    );
    const bytes = await renderAtsResumePdf(model);
    const reparsed = await runCascade(bytes);
    reparsedSkills = reparsed.parsed.skills ?? [];
  }, 20000);

  it("round-trips the same skill count (AC)", () => {
    expect(reparsedSkills.length).toBe(SYNTHETIC_SKILLS.length);
  });

  it("round-trips every multi-word skill intact — none split at a wrap point", () => {
    const reparsedSet = new Set(reparsedSkills);
    for (const skill of SYNTHETIC_SKILLS) {
      expect(reparsedSet.has(skill)).toBe(true);
    }
  });
});

/**
 * Regression for the `wrapSegmentsToLines` first-segment bug: `segments[0]`
 * used to be assigned to `current` before the loop and never measured, so an
 * overlong FIRST segment (a "Company · Location" org line whose company name
 * alone exceeds maxWidth) was emitted verbatim and overflowed the right margin.
 * Proven repro (Helvetica, size 10, maxWidth 468): the 104-char company string
 * measures 476.46pt > 468. Every returned line must now fit within maxWidth.
 */
describe("wrapSegmentsToLines — overlong FIRST segment is wrapped, not overflowed", () => {
  const SIZE = 10;
  const MAX_WIDTH = 468;

  it("no rendered line exceeds maxWidth when segments[0] is too wide", async () => {
    const { PDFDocument, StandardFonts } = await loadPdfLibOnce();
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);

    const segments = [
      "International Business Machines Corporation Yorktown Heights Thomas J Watson Research Center Division",
      "Yorktown Heights NY",
    ];
    // Sanity-check the repro precondition: the first segment alone overflows.
    expect(font.widthOfTextAtSize(segments[0], SIZE)).toBeGreaterThan(MAX_WIDTH);

    const lines = wrapSegmentsToLines(segments, font, SIZE, MAX_WIDTH);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(font.widthOfTextAtSize(line, SIZE)).toBeLessThanOrEqual(MAX_WIDTH);
    }
  });
});
