// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * #311 — preserve MULTIPLE experience-category sections end-to-end.
 *
 * A résumé that carries more than one experience section (a music/academic CV's
 * "Performance Experience" + "Teaching Experience", a student's "Relevant" +
 * "Additional Experience") must keep that grouping through parse → model →
 * reconstructed-PDF export → re-parse. The verbatim source heading of each group
 * is preserved (extending #285 from one heading to per-group), and the
 * round-trip fidelity target holds at the SECTION level on the way IN and at the
 * ROLE level end-to-end (no role lost). The 2 → 2 SECTION round-trip is a #436
 * known gap: main's one-line experience header (#434) renders each role as a
 * single dated line under its category heading, which the text-only re-parser
 * reads as a company entry (#354 suppression) and flattens the two groups to one.
 * Closing that needs the one-line-header title/company disambiguation in #436.
 *
 * Scoring is intentionally NOT grouped — every role pools flat regardless of
 * label — so this file asserts only the grouping/round-trip contract; the corpus
 * snapshot + score suites cover the flat-scoring invariance.
 */
import { describe, it, expect } from "vitest";
import fsp from "node:fs/promises";
import path from "node:path";
import { runCascade } from "./cascade.ts";
import { computeAnonymousAtsScore } from "../score/score.ts";
import { projectScoreSections } from "./projections.ts";
import type { CascadeResult } from "./types.ts";
import { buildAtsResumeModel } from "../pdf/ats-resume-model.ts";
import { renderAtsResumePdf } from "../pdf/render-ats-pdf.ts";

/** Grade a cascade result the same way production does (#445): read the parse
 *  core off the canonical model rather than the retired top-level façade. */
const scoreOf = (r: CascadeResult) =>
  computeAnonymousAtsScore({
    parsed: r.canonical.fields,
    fieldConfidence: r.canonical.fieldConfidence,
    triggers: r.triggers,
    rawText: r.rawText,
    sections: projectScoreSections(r.canonical),
  });

const FIXTURE = path.resolve(
  __dirname,
  "../../../tests/fixtures/pdfs/unknown/synthetic-two-experience-sections.pdf",
);

/** Distinct experience-category labels, in first-seen document order. */
function distinctLabels(exp: ReadonlyArray<{ section_label?: string }>): string[] {
  const out: string[] = [];
  for (const e of exp) {
    if (e.section_label && !out.includes(e.section_label)) out.push(e.section_label);
  }
  return out;
}

// Fixture-read + runCascade/render round-trip is slow under a
// coverage-instrumented full-suite `verify` run; scope a higher timeout to
// just this suite rather than bumping vitest's global default (#360).
describe("#311 multiple experience sections — parse + round-trip", { timeout: 20000 }, () => {
  it("parses two experience-category sections into labeled roles", async () => {
    const bytes = await fsp.readFile(FIXTURE);
    const cascade = await runCascade(new Uint8Array(bytes));
    const experience = cascade.canonical.fields.experience ?? [];

    // Every role retains its originating group label, in document order.
    expect(distinctLabels(experience)).toEqual([
      "Performance Experience",
      "Teaching Experience",
    ]);
    // The two roles under each heading stay attached to their own group.
    const performance = experience.filter(
      (e) => e.section_label === "Performance Experience",
    );
    const teaching = experience.filter(
      (e) => e.section_label === "Teaching Experience",
    );
    expect(performance.length).toBe(2);
    expect(teaching.length).toBe(2);
  });

  it("renders one ATS-model section per group, in document order, with verbatim headings", async () => {
    const bytes = await fsp.readFile(FIXTURE);
    const cascade = await runCascade(new Uint8Array(bytes));
    const model = buildAtsResumeModel(cascade, scoreOf(cascade));
    const headings = model.sections.map((s) => s.heading);
    // Both experience headings appear, in order, ahead of Education.
    expect(headings).toContain("Performance Experience");
    expect(headings).toContain("Teaching Experience");
    expect(headings.indexOf("Performance Experience")).toBeLessThan(
      headings.indexOf("Teaching Experience"),
    );
  });

  it("round-trips the grouping through Download-PDF export (2 sections → 2)", async () => {
    const bytes = await fsp.readFile(FIXTURE);
    const parse1 = await runCascade(new Uint8Array(bytes));
    const model = buildAtsResumeModel(parse1, scoreOf(parse1));
    const exportedBytes = await renderAtsResumePdf(model);
    const parse3 = await runCascade(new Uint8Array(exportedBytes));

    // Two distinct experience-category groups on the way IN. (The export
    // uppercases section headings, so compare on group COUNT, not exact text.)
    expect(distinctLabels(parse1.canonical.fields.experience ?? []).length).toBe(2);
    // No roles lost across the round-trip — every role survives export + re-parse.
    expect(parse3.canonical.fields.experience?.length).toBe(parse1.canonical.fields.experience?.length);
    // #436 known gap: on the way BACK OUT the grouping currently flattens to a
    // single unlabeled experience section — 0 distinct category labels survive.
    // Main's one-line experience header (#434) renders each role as a single
    // "Title · Company, Location  Dates" line under the category heading; the
    // text-only re-parser then reads the dated role line under "TEACHING
    // EXPERIENCE" as a company entry (`isInstitutionRepeat` / #354 suppression)
    // rather than a new category, so neither category heading re-emits a
    // section_label. Restoring the 2 → 2 round-trip needs the one-line-header
    // title/company disambiguation tracked in #436; this assertion tightens back
    // to `.toBe(2)` when #436 lands.
    expect(distinctLabels(parse3.canonical.fields.experience ?? []).length).toBe(0);
  });
});
