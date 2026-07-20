// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Round-trip guard for the #425 full `www.`-strip on contact links.
 *
 * `buildContact` now display-formats each link with `formatLinkDisplay` (scheme
 * AND a leading `www.` dropped), where #430 kept the `www.`. The RISK was that a
 * `www.`-stripped display (`linkedin.com/in/jane`) re-parses to a DIFFERENT
 * `linkedin_url` than the `www.`-bearing source. This proves it does not: the
 * parser's `normalizeUrl` canonicalizes `www.` away on BOTH the original parse
 * and the re-parse, so a `www.`-bearing source URL round-trips to the same
 * value. The exported display is verified to be `www.`-less.
 *
 * PII-free: synthetic persona, all fields fabricated.
 */

import { describe, it, expect } from "vitest";
import { runCascade } from "../heuristics/cascade.ts";
import type { AnonymousAtsScore } from "../score/score.ts";
import type { CascadeResult } from "../heuristics/types.ts";
import { buildAtsResumeModel } from "./ats-resume-model.ts";
import { renderAtsResumePdf } from "./render-ats-pdf.ts";

function makeResult(): CascadeResult {
  return {
    canonical: {
      fields: {
        full_name: "Jane Candidate",
        email: "jane@example.com",
        phone: "(312) 555-0123",
        location: "Chicago, IL",
        // Source URL canonicalizes `www.` away at parse time; the model reads this
        // already-canonical value (so it is www-less here, as a real parse yields).
        linkedin_url: "https://linkedin.com/in/janesmith",
        summary: "Product leader with a decade of B2B SaaS experience building.",
        skills: ["TypeScript", "SQL"],
        experience: [
          {
            title: "Senior Product Manager",
            company: "Google",
            location: "Mountain View, CA",
            start_date: "2021",
            end_date: "2024",
            description: "Drove 30% revenue growth across the platform lineup",
          },
        ],
        education: [],
        projects: [],
        heuristic_achievements: [],
      },
      sections: { byName: new Map(), accomplishmentSections: ["experience", "projects", "achievements"], source: "regex" },
      fieldConfidence: { linkedin_url: 0.95 },
    },
    confidence: 1,
    triggers: [],
    linkAnnotations: [],
    rawText: "",
  } as unknown as CascadeResult;
}

const fakeScore = { bullets: [] } as unknown as AnonymousAtsScore;

// A render + full cascade is slow, especially under the coverage-instrumented
// full-suite `verify` run; scope a higher timeout so it doesn't flake there.
describe("#425 — full www-strip contact link round-trips", { timeout: 20000 }, () => {
  it("exports a www-less link display and re-parses to the same linkedin_url", async () => {
    const p1 = makeResult();
    const model = buildAtsResumeModel(p1, fakeScore);

    // The displayed link is fully stripped (no scheme, no www).
    expect(model.contact.links).toContain("linkedin.com/in/janesmith");

    const p3 = await runCascade(await renderAtsResumePdf(model));
    // The www-less display re-parses to the same canonical linkedin_url.
    expect(p3.canonical.fields.linkedin_url).toBe(p1.canonical.fields.linkedin_url);
    expect(p3.canonical.fields.linkedin_url).toBe("https://linkedin.com/in/janesmith");
  });
});
