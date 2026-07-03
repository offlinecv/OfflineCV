// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Round-trip regression for #284 — the "Download PDF" reconstructed résumé must
 * re-segment cleanly through our own text-only parser.
 *
 * Pipeline exercised end to end: parse a multi-role résumé → `buildAtsResumeModel`
 * → `renderAtsResumePdf` → RE-parse the rendered bytes with `runCascade`. Before
 * the fix, the re-parse LOST work-experience roles (8 → 5): the renderer emitted
 * each role header as a single combined `Title · Company · Location` line above a
 * bare date line, and a "Company Inc. Location" header trips the description-prose
 * detector (an "Inc. Seoul"-style internal sentence break), so the parser folded
 * the header into the previous role's body and dropped the role — while a
 * bulletless role had no date anchor at all.
 *
 * The fix (`ats-resume-model.ts`) emits the STACKED shape the parser is tuned for:
 * the role TITLE on the bold header line, and "Company · Location  Dates" on the
 * sub-line — the date lives on the sub-line so it becomes the `date_range` anchor
 * (one anchor per role), title one line above within the header lookback.
 *
 * Uses the in-tree synthetic fixture `tests/fixtures/pdfs/latex/awesome-cv-resume.pdf`
 * (persona: Jane Smith, 8 roles) as the round-trip input — no new PDF and no
 * real-person PII. The lossy `*.expected.json` goldens record only counts and
 * cannot catch a title/company swap, so this asserts the field mapping directly.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect, beforeAll } from "vitest";
import { runCascade } from "../heuristics/cascade.ts";
import { computeAnonymousAtsScore } from "../score/score.ts";
import type { CascadeResult } from "../heuristics/types.ts";
import { buildAtsResumeModel } from "./ats-resume-model.ts";
import { renderAtsResumePdf } from "./render-ats-pdf.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(
  HERE,
  "../../..",
  "tests/fixtures/pdfs/latex/awesome-cv-resume.pdf",
);

/** Grade a parsed résumé exactly the way the app's surfaces do (#133): the scorer
 *  pools bullets from `sections`, so the model's bullet attribution mirrors what
 *  the reconstructed surface shows. */
function scoreFor(cascade: CascadeResult) {
  return computeAnonymousAtsScore({
    parsed: {
      full_name: cascade.parsed.full_name,
      email: cascade.parsed.email,
      phone: cascade.parsed.phone,
      location: cascade.parsed.location,
      linkedin_url: cascade.parsed.linkedin_url,
      summary: cascade.parsed.summary,
      skills: cascade.parsed.skills,
      experience: cascade.parsed.experience,
      education: cascade.parsed.education,
    },
    fieldConfidence: cascade.fieldConfidence,
    triggers: cascade.triggers,
    rawText: cascade.rawText,
    sections: cascade.sections,
  });
}

describe("#284 — Download-PDF reconstructed résumé round-trips through the parser", () => {
  let original: CascadeResult;
  let reparsed: CascadeResult;

  beforeAll(async () => {
    original = await runCascade(new Uint8Array(readFileSync(FIXTURE)));
    const model = buildAtsResumeModel(original, scoreFor(original));
    const bytes = await renderAtsResumePdf(model);
    reparsed = await runCascade(bytes);
  });

  it("preserves the work-experience role count end to end (AC#1)", () => {
    const origExp = original.parsed.experience ?? [];
    const reExp = reparsed.parsed.experience ?? [];
    // Baseline sanity: the fixture parses to 8 roles.
    expect(origExp.length).toBe(8);
    expect(reExp.length).toBe(origExp.length);
  });

  it("re-parses each role's title / company back into the right fields (AC#3)", () => {
    const origExp = original.parsed.experience ?? [];
    const reExp = reparsed.parsed.experience ?? [];
    origExp.forEach((orig, i) => {
      expect(reExp[i]?.title).toBe(orig.title);
      expect(reExp[i]?.company).toBe(orig.company);
      expect(reExp[i]?.start_date).toBe(orig.start_date);
      expect(reExp[i]?.end_date).toBe(orig.end_date);
    });
  });

  it("re-parses education degree / field / institution back into the right fields (#291)", () => {
    const origEdu = original.parsed.education ?? [];
    const reEdu = reparsed.parsed.education ?? [];
    // Baseline: the fixture parses to at least one education entry.
    expect(origEdu.length).toBeGreaterThan(0);
    expect(reEdu.length).toBe(origEdu.length);
    origEdu.forEach((orig, i) => {
      expect(reEdu[i]?.degree).toBe(orig.degree);
      expect(reEdu[i]?.field).toBe(orig.field);
      // Institution must round-trip clean — before the fix the reconstructed
      // "Institution  Dates" one-liner glued the date range onto `institution`.
      expect(reEdu[i]?.institution).toBe(orig.institution);
      expect(reEdu[i]?.institution ?? "").not.toMatch(/\b\d{4}\s*$/);
      expect(reEdu[i]?.start_date).toBe(orig.start_date);
      expect(reEdu[i]?.end_date).toBe(orig.end_date);
    });
  });

  it("preserves the summary text end to end (#292)", () => {
    const s1 = original.parsed.summary ?? "";
    const s3 = reparsed.parsed.summary ?? "";
    expect(s1.length).toBeGreaterThan(0);
    // The reconstructed-résumé renderer re-wraps prose, which can push a
    // sentence-level en/em dash to the start of a line; the summary extractor
    // used to drop that line as a "bullet" (#292), shrinking the summary.
    // Round-trip must now preserve it within whitespace-normalization noise.
    const norm = (s: string) => s.replace(/\s+/g, " ").trim();
    expect(norm(s3)).toBe(norm(s1));
  });

  it("leaves no role description ending with the NEXT role's header (AC#2)", () => {
    const reExp = reparsed.parsed.experience ?? [];
    // A swallowed next-role header manifests as a trailing description line that
    // reads "Title · Company …". Assert no role's description tail matches any
    // other role's rendered header signature (title token + the "·" join).
    const titles = reExp.map((e) => e.title).filter(Boolean) as string[];
    for (const role of reExp) {
      const tail = (role.description ?? "").split("\n").pop()?.trim() ?? "";
      for (const otherTitle of titles) {
        if (otherTitle === role.title) continue;
        // The next role's header would appear as "<otherTitle> · <company>".
        expect(tail.startsWith(`${otherTitle} ·`)).toBe(false);
      }
    }
  });
});
