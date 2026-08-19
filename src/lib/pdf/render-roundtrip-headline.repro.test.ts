// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect, beforeAll } from "vitest";
import { runCascade } from "../heuristics/cascade.ts";
import { computeAnonymousAtsScore } from "../score/score.ts";
import type { CascadeResult } from "../heuristics/types.ts";
import { buildAtsResumeModel } from "./ats-resume-model.ts";
import { renderAtsResumePdf } from "./render-ats-pdf.ts";
import { MAX_HEADLINE_LENGTH, headlineRoundTripWarning } from "../edit/headline.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(
  HERE,
  "../../..",
  "tests/fixtures/pdfs/latex/awesome-cv-resume.pdf",
);

function scoreFor(cascade: CascadeResult) {
  return computeAnonymousAtsScore({
    parsed: cascade.canonical.fields,
    fieldConfidence: cascade.canonical.fieldConfidence,
    triggers: cascade.triggers,
    rawText: cascade.rawText,
    sections: cascade.canonical.sections,
  });
}

describe("Headline round-trip", () => {
  let baseCascade: CascadeResult;

  beforeAll(async () => {
    baseCascade = await runCascade(new Uint8Array(readFileSync(FIXTURE)));
  });

  /**
   * Round-trip the fixture with `headline` substituted, returning BOTH the
   * recovered headline and a witness that the rest of the parse survived.
   *
   * The witness exists because `not.toBe(tooLong)` — the shape this file used
   * to assert — is satisfied by a truncation, by `undefined`, and equally by
   * the fixture having stopped parsing altogether (#605 review). Pinning the
   * name + experience count makes a broken fixture fail loudly instead of
   * passing green for the wrong reason.
   */
  async function roundTripWithHeadline(headline: string): Promise<{
    headline: string | undefined;
    name: string | undefined;
    experienceCount: number;
  }> {
    const canonical = {
      ...baseCascade.canonical,
      fields: {
        ...baseCascade.canonical.fields,
        headline,
      },
    };
    const modifiedCascade = { ...baseCascade, canonical };
    const model = buildAtsResumeModel(modifiedCascade, scoreFor(modifiedCascade));
    const { bytes } = await renderAtsResumePdf(model);
    const reparsed = await runCascade(bytes);
    return {
      headline: reparsed.canonical.fields.headline,
      name: reparsed.canonical.fields.full_name,
      experienceCount: reparsed.canonical.fields.experience.length,
    };
  }

  /** The rest of the résumé came back — so a headline assertion below is
   *  reporting on the headline, not on a fixture that failed to parse. */
  function expectParseSurvived(result: { name: string | undefined; experienceCount: number }) {
    expect(result.name).toBe(baseCascade.canonical.fields.full_name);
    expect(result.experienceCount).toBe(baseCascade.canonical.fields.experience.length);
  }

  it("round-trips a headline at exactly MAX_HEADLINE_LENGTH characters", async () => {
    const headlineBase = "Director Of Engineering Product Management And Development";
    const exactHeadline = headlineBase.padEnd(MAX_HEADLINE_LENGTH, "X");

    expect(exactHeadline.length).toBe(MAX_HEADLINE_LENGTH);
    expect(headlineRoundTripWarning(exactHeadline)).toBeNull();

    const result = await roundTripWithHeadline(exactHeadline);
    expectParseSurvived(result);
    expect(result.headline).toBe(exactHeadline);
  });

  it("truncates and warns on a headline exceeding MAX_HEADLINE_LENGTH", async () => {
    const tooLong = "Director Of Engineering Product Management And Development And More";
    expect(tooLong.length).toBeGreaterThan(MAX_HEADLINE_LENGTH);

    expect(headlineRoundTripWarning(tooLong)).not.toBeNull();

    const result = await roundTripWithHeadline(tooLong);
    expectParseSurvived(result);
    // What the warning promises: an over-long headline does not come back
    // whole. Assert the recovered VALUE is either absent or within the limit —
    // `not.toBe(tooLong)` would also pass on a garbled 200-char line.
    expect(
      result.headline === undefined ||
        result.headline.length <= MAX_HEADLINE_LENGTH,
    ).toBe(true);
  });

  it("warns on a prose-shaped headline that fails looksLikeTitle", async () => {
    const proseHeadline = "A driven professional looking for opportunities";
    expect(proseHeadline.length).toBeLessThanOrEqual(MAX_HEADLINE_LENGTH);

    expect(headlineRoundTripWarning(proseHeadline)).not.toBeNull();

    const result = await roundTripWithHeadline(proseHeadline);
    expectParseSurvived(result);
    // A prose line fails `extractHeadline`'s own `looksLikeTitle` gate, so it
    // is not recovered as a headline at all. Assert that, not mere inequality.
    expect(result.headline).toBeUndefined();
  });
});
