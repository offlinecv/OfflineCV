// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Round-trip guard for the #425 team-on-the-org-line change.
 *
 * `buildAtsResumeModel` now joins `exp.team` onto the experience sub-line
 * ("Company · Location · Team  Dates"). The team/division was previously dropped
 * at model-build time even though the parser populates it. The RISK is that
 * adding a third `· team` segment to the parser's date-anchor org line perturbs
 * re-segmentation (the #298 company/title-swap signature). This test proves it
 * does not: a two-role résumé carrying company + location + team renders and
 * RE-parses back to the same title / company / location / dates per role.
 *
 * The `team` field itself is not asserted on re-parse — the reconstructed
 * single-column shape shows the team on the org line, but the parser folds the
 * third middot segment into the role header without re-extracting a distinct
 * `team` field. That is acceptable: the export's job is to DISPLAY the team, and
 * the round-trip invariants the corpus gate protects (title/company/dates) stay
 * intact. The sub-line assertion below confirms the team is actually rendered.
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
    title: "Senior Product Manager",
    company: "Google",
    location: "Mountain View, CA",
    team: "Enterprise Platforms",
    start_date: "2021",
    end_date: "2024",
    description:
      "Led migration of legacy auth to OAuth for 50K users\nDrove 30% revenue growth across the platform",
  },
  {
    title: "Product Manager",
    company: "Meta",
    location: "Menlo Park, CA",
    team: "Ads Platform",
    start_date: "2018",
    end_date: "2021",
    description:
      "Shipped 12 features to 200M users\nGrew engagement by 18% quarter over quarter",
  },
];

function makeResult(): CascadeResult {
  return {
    parsed: {
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
    fieldConfidence: {},
    confidence: 1,
    triggers: [],
    linkAnnotations: [],
    rawText: "",
  } as unknown as CascadeResult;
}

const fakeScore = { bullets: [] } as unknown as AnonymousAtsScore;

describe("#425 — team on the org line round-trips through the parser", () => {
  let model: ReturnType<typeof buildAtsResumeModel>;
  let reparsed: CascadeResult;

  beforeAll(async () => {
    model = buildAtsResumeModel(makeResult(), fakeScore);
    reparsed = await runCascade(await renderAtsResumePdf(model));
  });

  it("renders the team as the third middot segment on the org sub-line", () => {
    const exp = model.sections.find((s) => s.heading === "Experience");
    const subLines = exp?.entries.map((e) => e.subLine) ?? [];
    expect(subLines[0]).toBe(
      "Google · Mountain View, CA · Enterprise Platforms  2021 – 2024",
    );
    expect(subLines[1]).toBe(
      "Meta · Menlo Park, CA · Ads Platform  2018 – 2021",
    );
  });

  it("re-parses each role's title / company / location / dates back into the right fields", () => {
    const reExp = reparsed.parsed.experience ?? [];
    expect(reExp.length).toBe(ROLES.length);
    ROLES.forEach((orig, i) => {
      expect(reExp[i]?.title).toBe(orig.title);
      expect(reExp[i]?.company).toBe(orig.company);
      expect(reExp[i]?.location).toBe(orig.location);
      expect(reExp[i]?.start_date).toBe(orig.start_date);
      expect(reExp[i]?.end_date).toBe(orig.end_date);
      // The team segment must not leak into company — the swap guard (#298).
      expect(reExp[i]?.company).not.toContain("·");
    });
  });
});
