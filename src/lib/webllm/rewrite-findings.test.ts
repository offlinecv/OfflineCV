// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Unit tests for the critique → findings-map adapter (#608).
 *
 * Minimal typed literals over full fixtures, per `contact.test.ts` — a
 * `ResumeCritique` is a plain data shape and building one by hand states
 * exactly what each case is about.
 */

import { describe, expect, it } from "vitest";
import { findingsFromCritique } from "./rewrite-findings.ts";
import { findingsKey } from "./steering.ts";
import type { ResumeCritique } from "./critique-resume.ts";

function critique(over: Partial<ResumeCritique> = {}): ResumeCritique {
  return { bulletFindings: [], missingSections: [], ...over };
}

describe("findingsFromCritique", () => {
  it("returns undefined with no critique, so the prompt stays pre-#608", () => {
    expect(findingsFromCritique(undefined)).toBeUndefined();
  });

  it("returns undefined when every finding is `ok`", () => {
    const result = findingsFromCritique(
      critique({
        bulletFindings: [
          { bullet: "Shipped the billing service", issue: "ok" },
          { bullet: "Led the migration", issue: "ok" },
        ],
      }),
    );
    // Not an empty map: `undefined` is the single "contributes nothing" signal
    // the byte-identical-prompt guarantee keys on.
    expect(result).toBeUndefined();
  });

  it("maps each actionable issue to an instruction, not a diagnosis", () => {
    const result = findingsFromCritique(
      critique({
        bulletFindings: [
          { bullet: "Worked on the API", issue: "no_quantification" },
          { bullet: "Was responsible for deploys", issue: "weak_verb" },
          { bullet: "Helped with stuff", issue: "vague" },
        ],
      }),
    );
    expect(result?.get(findingsKey("Worked on the API"))).toEqual([
      "add a concrete metric or outcome",
    ]);
    expect(result?.get(findingsKey("Was responsible for deploys"))).toEqual([
      "lead with a stronger action verb",
    ]);
    expect(result?.get(findingsKey("Helped with stuff"))).toEqual([
      "make this specific — name the system, scope, or result",
    ]);
  });

  it("folds the critique's own suggestion in, labelled as a suggestion", () => {
    const result = findingsFromCritique(
      critique({
        bulletFindings: [
          {
            bullet: "Worked on the API",
            issue: "no_quantification",
            suggestion: "Cut p99 latency 40%",
          },
        ],
      }),
    );
    const notes = result?.get(findingsKey("Worked on the API"));
    expect(notes).toEqual([
      "add a concrete metric or outcome (suggested: Cut p99 latency 40%)",
    ]);
  });

  it("joins on normalised text, so a marker or re-wrap still matches", () => {
    // The critique echoes the bullet back through the model, which routinely
    // re-adds a marker or re-wraps whitespace. Matching raw text would lose the
    // finding for a reason that has nothing to do with the résumé.
    const result = findingsFromCritique(
      critique({
        bulletFindings: [
          { bullet: "•  Worked   on the API", issue: "no_quantification" },
        ],
      }),
    );
    expect(result?.get(findingsKey("Worked on the API"))).toEqual([
      "add a concrete metric or outcome",
    ]);
  });

  it("keeps BOTH notes when two findings normalise to one key", () => {
    // A résumé repeating a bullet verbatim across two roles gets one finding
    // per occurrence. Last-write-wins would silently drop one the user saw.
    const result = findingsFromCritique(
      critique({
        bulletFindings: [
          { bullet: "Led the migration", issue: "no_quantification" },
          { bullet: "Led the migration", issue: "vague" },
        ],
      }),
    );
    expect(result?.get(findingsKey("Led the migration"))).toEqual([
      "add a concrete metric or outcome",
      "make this specific — name the system, scope, or result",
    ]);
  });

  it("collapses an identical note appearing twice", () => {
    const result = findingsFromCritique(
      critique({
        bulletFindings: [
          { bullet: "Led the migration", issue: "vague" },
          { bullet: "Led the migration", issue: "vague" },
        ],
      }),
    );
    expect(result?.get(findingsKey("Led the migration"))).toHaveLength(1);
  });

  it("files summaryFeedback under the summary text the caller supplies", () => {
    const summary = "Engineer with 10 years of experience.";
    const result = findingsFromCritique(
      critique({ summaryFeedback: "Too generic — name a specialism." }),
      summary,
    );
    expect(result?.get(findingsKey(summary))).toEqual([
      "Too generic — name a specialism.",
    ]);
  });

  it("drops summaryFeedback when no summary text is supplied", () => {
    // Better dropped than filed under a key nothing will ever look up.
    const result = findingsFromCritique(
      critique({ summaryFeedback: "Too generic." }),
    );
    expect(result).toBeUndefined();
  });

  it("ignores a finding whose bullet normalises to nothing", () => {
    const result = findingsFromCritique(
      critique({
        bulletFindings: [{ bullet: "  •  ", issue: "vague" }],
      }),
    );
    expect(result).toBeUndefined();
  });
});
