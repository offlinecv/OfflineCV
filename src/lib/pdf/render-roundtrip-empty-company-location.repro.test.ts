// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Round-trip guard for the #466 empty-company + location shape (PR #483
 * review).
 *
 * The `company === title` backstop in `disambiguateCompanyTitle` clears a
 * mirrored-title company slot so a role with no recognizable employer reads
 * as an honest miss (`company === ""`) rather than as bad data. That backstop
 * makes empty-company roles more common than before, and the exporter's
 * `Title · Company, Location · Team` middot join previously re-parsed as
 * `Title · Company` when company was empty — writing the LOCATION into the
 * company slot and losing location entirely.
 *
 * The empty-company branch of `buildAtsResumeModel` now:
 *   1. joins Title + Team with a COMMA (`Title, Team`) so the parser's
 *      role-comma split + `company === title` backstop round-trip clean, and
 *   2. routes the LOCATION onto a separate `subLine` (`City, ST` on its own
 *      row below the header), which `parseEntryBlocks` captures as a
 *      below-anchor whole cell and `recoverLocation` step 3c (extended for
 *      whole-cell below-anchor bare locations) surfaces back into `location`.
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
    title: "Software Engineer II",
    company: "", // ← the empty-company shape this guard exists to cover.
    location: "Chicago, IL",
    team: "Payments Platform",
    start_date: "Aug 2024",
    is_current: true,
    description:
      "Owned the payment settlement rails handling 4M transactions daily",
  },
];

function makeResult(): CascadeResult {
  return {
    canonical: {
      fields: {
        full_name: "Casey Nolan",
        email: "casey.nolan@example.com",
        phone: "(312) 555-0157",
        location: "Chicago, IL",
        skills: [],
        experience: ROLES,
        education: [],
        projects: [],
        heuristic_achievements: [],
      },
      sections: {
        byName: new Map(),
        accomplishmentSections: ["experience", "projects", "achievements"],
        source: "regex",
      },
      fieldConfidence: {},
    },
    confidence: 1,
    triggers: [],
    linkAnnotations: [],
    rawText: "",
  } as unknown as CascadeResult;
}

const fakeScore = { bullets: [] } as unknown as AnonymousAtsScore;

describe("empty-company + location round-trip (#466 / PR #483 review)", () => {
  let model: ReturnType<typeof buildAtsResumeModel>;
  let reparsed: CascadeResult;

  beforeAll(async () => {
    model = buildAtsResumeModel(makeResult(), fakeScore);
    reparsed = await runCascade(await renderAtsResumePdf(model));
  });

  it("emits Title,Team on the header line and City,ST on a subLine", () => {
    const exp = model.sections.find((s) => s.heading === "Experience");
    const entries = exp?.entries ?? [];
    expect(entries[0]?.headerLine).toBe(
      "Software Engineer II, Payments Platform",
    );
    // Location must NOT be glued into the header (pre-fix bug re-parsed it as
    // company); it lives on its own subLine below the header.
    expect(entries[0]?.headerLine).not.toContain("Chicago");
    expect(entries[0]?.subLine).toBe("Chicago, IL");
  });

  it("re-parses back to the same title / company / location / team", () => {
    const reExp = reparsed.canonical.fields.experience ?? [];
    expect(reExp.length).toBe(1);
    const orig = ROLES[0];
    // The critical round-trip invariants: title stays title, company stays
    // empty (the backstop clears it on re-parse), and location makes it back
    // into the location slot rather than the company slot.
    expect(reExp[0]?.title).toBe(orig.title);
    expect(reExp[0]?.company ?? "").toBe("");
    expect(reExp[0]?.location).toBe(orig.location);
    // The location must NOT have leaked into the company slot — the exact
    // corruption this round-trip guard exists to prevent.
    expect(reExp[0]?.company).not.toBe(orig.location);
  });
});
