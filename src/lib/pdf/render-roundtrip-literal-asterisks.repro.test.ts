// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Round-trip regression for #284/#425 — literal `**` in a bullet must survive
 * export + re-parse BYTE-IDENTICALLY.
 *
 * The #425 auto-bold feature wraps quantifiable metrics in emphasis markers so
 * the renderer can draw them bold. The first cut used literal `**…**` markers,
 * which `parseBoldRuns` stripped before drawing — so a bullet that ALREADY
 * contained literal `**` (a user who typed markdown, or coincidental asterisks)
 * had those characters silently DELETED from the drawn glyphs. Re-parsing the
 * PDF then read back "Wrote important design docs" from "Wrote **important**
 * design docs" — a #284 round-trip corruption.
 *
 * The fix: emphasis markers are Private-Use-Area sentinels (U+E000 / U+E001),
 * codepoints that cannot occur in résumé text, so literal `**` is inert and
 * drawn verbatim. This test drives the REAL pipeline — `buildAtsResumeModel` →
 * `renderAtsResumePdf` → `runCascade` — and asserts each role's re-parsed
 * description is byte-identical to the input, for balanced, unbalanced, and
 * metric-adjacent literal `**`.
 *
 * PII-free: synthetic persona, all fields fabricated.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { runCascade } from "../heuristics/cascade.ts";
import type { AnonymousAtsScore } from "../score/score.ts";
import type { CascadeResult } from "../heuristics/types.ts";
import { buildAtsResumeModel } from "./ats-resume-model.ts";
import { renderAtsResumePdf } from "./render-ats-pdf.ts";

const ROLES = [
  {
    title: "Staff Engineer",
    company: "Google",
    location: "Mountain View, CA",
    start_date: "2021",
    end_date: "2024",
    // Balanced literal `**important**` — the reviewer's exact repro.
    description: "Wrote **important** design docs for the team",
  },
  {
    title: "Senior Engineer",
    company: "Meta",
    location: "Menlo Park, CA",
    start_date: "2018",
    end_date: "2021",
    // Unbalanced + adjacent literal `**`, next to a real metric that DOES bold.
    description: "Shipped **fast and cut latency 40% with ** stray marks",
  },
];

function makeResult(): CascadeResult {
  return {
    canonical: {
      fields: {
      full_name: "Jane Candidate",
      email: "jane@example.com",
      phone: "(312) 555-0123",
      location: "Chicago, IL",
      summary:
        "Product leader with a decade of B2B SaaS experience building teams.",
      skills: ["TypeScript", "Product Strategy", "SQL"],
      experience: ROLES,
      education: [],
      projects: [],
      heuristic_achievements: [],
      },
      sections: { byName: new Map(), accomplishmentSections: [], source: "regex" },
      fieldConfidence: {},
    },
    confidence: 1,
    triggers: [],
    linkAnnotations: [],
    rawText: "",
  } as unknown as CascadeResult;
}

const fakeScore = { bullets: [] } as unknown as AnonymousAtsScore;

describe("#284/#425 — literal `**` in a bullet round-trips byte-identically", () => {
  let reparsed: CascadeResult;

  beforeAll(async () => {
    const model = buildAtsResumeModel(makeResult(), fakeScore);
    reparsed = await runCascade(await renderAtsResumePdf(model));
  });

  it("re-parses each role's description with its literal `**` intact", () => {
    const reExp = reparsed.canonical.fields.experience ?? [];
    expect(reExp.length).toBe(ROLES.length);
    ROLES.forEach((orig, i) => {
      const desc = reExp[i]?.description ?? "";
      // Byte-identical: not one asterisk added or removed vs. the source bullet.
      expect(desc).toBe(orig.description);
    });
  });

  it("did not strip the `**` (would have, pre-fix)", () => {
    const reExp = reparsed.canonical.fields.experience ?? [];
    expect(reExp[0]?.description).toContain("**important**");
    // The pre-fix corruption signature — must NOT appear.
    expect(reExp[0]?.description).not.toBe(
      "Wrote important design docs for the team",
    );
  });
});
