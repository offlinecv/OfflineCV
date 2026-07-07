// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * #311 — preserve MULTIPLE experience-category sections end-to-end.
 *
 * A résumé that carries more than one experience section (a music/academic CV's
 * "Performance Experience" + "Teaching Experience", a student's "Relevant" +
 * "Additional Experience") must keep that grouping through parse → model →
 * reconstructed-PDF export → re-parse. The verbatim source heading of each group
 * is preserved (extending #285 from one heading to per-group), and the
 * round-trip fidelity target holds at the SECTION level: two source experience
 * sections re-parse to two, not one (2 → 2), so the candidate's deliberate
 * grouping is never flattened by the Download-PDF surface.
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
import { buildAtsResumeModel } from "../pdf/ats-resume-model.ts";
import { renderAtsResumePdf } from "../pdf/render-ats-pdf.ts";

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

describe("#311 multiple experience sections — parse + round-trip", () => {
  it("parses two experience-category sections into labeled roles", async () => {
    const bytes = await fsp.readFile(FIXTURE);
    const cascade = await runCascade(new Uint8Array(bytes));
    const experience = cascade.parsed.experience ?? [];

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
    const model = buildAtsResumeModel(cascade, computeAnonymousAtsScore(cascade));
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
    const model = buildAtsResumeModel(parse1, computeAnonymousAtsScore(parse1));
    const exportedBytes = await renderAtsResumePdf(model);
    const parse3 = await runCascade(new Uint8Array(exportedBytes));

    // Two distinct experience-category groups on the way in AND on the way back
    // out — the grouping is not flattened by the reconstructed PDF. (The export
    // uppercases section headings, so compare on group COUNT, not exact text.)
    expect(distinctLabels(parse1.parsed.experience ?? []).length).toBe(2);
    expect(distinctLabels(parse3.parsed.experience ?? []).length).toBe(2);
    // No roles lost across the round-trip.
    expect(parse3.parsed.experience?.length).toBe(parse1.parsed.experience?.length);
  });
});
