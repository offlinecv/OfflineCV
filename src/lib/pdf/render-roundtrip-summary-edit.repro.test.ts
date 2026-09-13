// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Round-trip guard for #625 — the Summary is now editable, and CLEARABLE.
 *
 * Before #625 the summary was parsed, scored and drawn into the download while
 * being invisible in the reconstructed view, so a mis-segmented one was
 * uncorrectable. This closes the loop end to end: reconstructed edit →
 * applyOverrides → ats-resume-model → PDF → re-parse.
 *
 * The load-bearing case is the CLEAR. `render-ats-pdf` draws the heading and the
 * body under one `if (model.summary)`, so proving the body is gone is NOT proof
 * the heading went with it — a clear that stored `""` instead of deleting the
 * key would still satisfy `parsed.summary?.trim() || undefined`, but a clear
 * that stored, say, a single space would not. So the clear case asserts against
 * the rendered PDF's own extracted text, with a VERBATIM custom heading
 * ("Professional Profile", #285) that appears nowhere else in the document —
 * a generic "Summary" would be indistinguishable from any other occurrence.
 *
 * PII-free: synthetic persona, all fields fabricated.
 */

import { describe, it, expect } from "vitest";
import { runCascade } from "../heuristics/cascade.ts";
import { applyOverrides } from "../edit/apply-overrides.ts";
import type { AnonymousAtsScore } from "../score/score.ts";
import type { CascadeResult, HeuristicParsedResume } from "../heuristics/types.ts";
import type { SectionedResume } from "../heuristics/sections.ts";
import { buildAtsResumeModel } from "./ats-resume-model.ts";
import { renderAtsResumePdf } from "./render-ats-pdf.ts";

const PARSED_SUMMARY =
  "Platform engineer with a decade of distributed-systems experience.";

const PARSED: HeuristicParsedResume = {
  full_name: "Jane Candidate",
  email: "jane@example.com",
  phone: "(312) 555-0123",
  location: "Chicago, IL",
  summary: PARSED_SUMMARY,
  skills: ["TypeScript", "Go", "PostgreSQL"],
  experience: [
    {
      title: "Staff Engineer",
      company: "Acme",
      location: "Chicago, IL",
      start_date: "2021",
      end_date: "2024",
      description:
        "Led migration of legacy auth to OAuth for 50K users\nCut p99 checkout latency by 38%",
    },
  ],
  education: [],
};

/** The verbatim source heading (#285) the exporter must honour — and, on a
 *  clear, must drop along with the body. */
const HEADING = "Professional Profile";

const SECTIONS: SectionedResume = {
  byName: new Map() as SectionedResume["byName"],
  accomplishmentSections: ["experience", "projects", "achievements"],
  source: "regex",
  sectionHeadings: new Map([["summary", HEADING]]),
} as unknown as SectionedResume;

function makeResult(fields: HeuristicParsedResume): CascadeResult {
  return {
    canonical: { fields, sections: SECTIONS, fieldConfidence: {} },
    confidence: 1,
    triggers: [],
    linkAnnotations: [],
    rawText: "",
  } as unknown as CascadeResult;
}

const fakeScore = { bullets: [] } as unknown as AnonymousAtsScore;

/** Fold ONLY a summary override through the real pipeline, then build the model
 *  the exporter draws from. */
function exportModel(summaryOverride: string | undefined) {
  const edited = applyOverrides(
    {
      parsed: PARSED,
      rawText: "",
      sections: SECTIONS,
      observations: [],
    },
    {
      summaryOverride,
    },
  );
  return buildAtsResumeModel(makeResult(edited.fields), fakeScore);
}

// A real pdf-lib render plus a full re-parse per case is fast in isolation
// (~0.7s) but blows the 5s default under a coverage-instrumented full-suite
// `verify` run; scope a higher timeout to just this suite rather than bumping
// vitest's global default (#360, same treatment as the corpus round-trips).
describe("#625 — an edited summary round-trips through the export", { timeout: 20000 }, () => {
  it("honours the verbatim source heading when untouched", () => {
    const model = exportModel(undefined);
    expect(model.summary).toBe(PARSED_SUMMARY);
    expect(model.summaryHeading).toBe(HEADING);
  });

  it("draws the EDITED text, and the re-parse reads it back", async () => {
    const edited =
      "Distributed-systems engineer who cut p99 checkout latency by 38%.";
    const model = exportModel(edited);
    expect(model.summary).toBe(edited);

    const reparsed = await runCascade((await renderAtsResumePdf(model)).bytes);
    expect(reparsed.rawText).toContain(edited);
    expect(reparsed.rawText).not.toContain(PARSED_SUMMARY);
  });

  // AC3: no orphan heading. Both halves of `if (model.summary) { heading; body }`
  // must be gone, so this asserts against the rendered bytes, not just the model.
  it.each([
    ["an empty string", ""],
    ["a whitespace-only string", "   \n "],
  ])("drops BOTH the heading and the body when cleared with %s", async (
    _label,
    override,
  ) => {
    const model = exportModel(override);
    expect(model.summary).toBeUndefined();

    const reparsed = await runCascade((await renderAtsResumePdf(model)).bytes);
    expect(reparsed.rawText).not.toContain(PARSED_SUMMARY);
    expect(reparsed.rawText).not.toContain(HEADING);
    // The rest of the résumé is untouched — the clear removed a section, not
    // the document.
    expect(reparsed.rawText).toContain("Staff Engineer");
  });
});
