// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Regression tests for #492's second half — a role-scope sentence GLUED onto
 * the anchor line after its date range ("Senior QA Engineer, Northwind Systems,
 * Portland, OR (Mar 2021 - Present) Leads the automation guild.").
 *
 * `stripDateRange` removes the date and leaves everything else on one string,
 * so pre-fix the sentence and the employer arrived at
 * `disambiguateCompanyTitle` as a single header line and the scope sentence
 * came back inside `company`. `splitAnchorProseTail` (entry-blocks.ts) peels it
 * into `belowAnchorBodyProse`, the bucket #615/#708 already established for
 * body prose that must not reach header disambiguation — which is why the
 * guard is `looksLikeBelowAnchorProse`, the same predicate that decides the
 * question for a line BELOW the anchor.
 *
 * This file is deliberately separate from `experience.leading-body-prose.test.ts`:
 * that one owns lines UNDER the anchor (#615/#708), this one owns the anchor
 * line itself. Every case here routes through a real `EXPERIENCE` header, so
 * the peel is tested independently of #492's headerless section recovery
 * (which `sections.test.ts` and `headerless-experience.repro.test.ts` cover).
 *
 * The must-NOT-fire cases carry the weight. A post-date tail is far more often
 * a LOCATION than a sentence, and a `first_line` section (projects,
 * achievements) never reads `belowAnchorBodyProse` at all — so a peel there
 * would not clean a header, it would delete text.
 *
 * All personas are synthetic — no PDF binary, per the fixtures PII policy.
 */

import { describe, it, expect } from "vitest";
import { groupIntoLines, splitIntoSections, findSection } from "../sections.ts";
import { extractProjects } from "../extract-fields.ts";
import { mkItems } from "../__test-utils__/mkItem.ts";
import { roleFromSection } from "../__test-utils__/roleFromSection.ts";

const BULLETS = [
  { text: "• Built an 18-engineer org in under 6 months.", fontSize: 11 },
  { text: "• Won new AI/ML platform charters for the site.", fontSize: 11 },
];

describe("a scope sentence glued onto the anchor line after its date (#492)", () => {
  it("peels the sentence off the header and leads the description with it", () => {
    const roles = roleFromSection([
      { text: "EXPERIENCE", fontSize: 13 },
      {
        text: "Sr. Engineering Manager · Globex, Toronto, Canada 01/2024 – 12/2024 Owned the build system roadmap.",
        fontSize: 11,
      },
      ...BULLETS,
    ]);
    expect(roles).toHaveLength(1);
    const role = roles[0];
    // The regression signature: the sentence riding inside a header field.
    expect(role.company).toBe("Globex");
    expect(role.title).toBe("Sr. Engineering Manager");
    expect(role.location).toBe("Toronto, Canada");
    expect(role.team).toBeUndefined();
    // Dates are still parsed off the same line.
    expect(role.start_date).toBe("01/2024");
    expect(role.end_date).toBe("12/2024");
    // And the sentence leads the body, above the bullets.
    expect(role.description!.split("\n")[0]).toBe(
      "Owned the build system roadmap.",
    );
  });

  it("leaves a post-date LOCATION alone — the common tail, and not prose", () => {
    const roles = roleFromSection([
      { text: "EXPERIENCE", fontSize: 13 },
      {
        text: "Sr. Engineering Manager · Globex 01/2024 – 12/2024 Toronto, Canada",
        fontSize: 11,
      },
      ...BULLETS,
    ]);
    expect(roles).toHaveLength(1);
    expect(roles[0].description ?? "").not.toContain("Toronto");
  });

  it("leaves a separator-led post-date location alone (the #347 sub-line shape)", () => {
    const roles = roleFromSection([
      { text: "EXPERIENCE", fontSize: 13 },
      {
        text: "Sr. Engineering Manager · Globex 01/2024 – 12/2024 · Springfield, IL",
        fontSize: 11,
      },
      ...BULLETS,
    ]);
    expect(roles).toHaveLength(1);
    expect(roles[0].description ?? "").not.toContain("Springfield");
  });

  it("leaves a date-LED line alone — its whole payload sits after the date", () => {
    const roles = roleFromSection([
      { text: "EXPERIENCE", fontSize: 13 },
      {
        text: "01/2024 – 12/2024 Sr. Engineering Manager · Globex, Toronto, Canada",
        fontSize: 11,
      },
      ...BULLETS,
    ]);
    expect(roles).toHaveLength(1);
    const role = roles[0];
    expect(role.title).toBe("Sr. Engineering Manager");
    expect(role.company).toBe("Globex");
    expect(role.description ?? "").not.toContain("Globex");
  });

  it("never empties the header run — a peel must not re-route the block", () => {
    // A date-LED line whose entire payload is prose is the one input where the
    // peel could leave `headerLines` EMPTY, and an empty header run is the gate
    // `promoteBulletedRoleHeader` opens on: it would then consume the first
    // BULLET as the role header (#708's noted hazard). Whether such a block
    // should promote is #145's question, not a cleanup's — so the empty-head
    // check keeps the peel out of it and the bullet stays a bullet.
    const roles = roleFromSection([
      { text: "EXPERIENCE", fontSize: 13 },
      { text: "01/2024 – 12/2024 Owned the build system roadmap.", fontSize: 11 },
      { text: "• Staff Engineer · Globex", fontSize: 11 },
      ...BULLETS.slice(1),
    ]);
    expect(roles).toHaveLength(1);
    const role = roles[0];
    expect(role.header_from_bullet).toBeUndefined();
    expect(role.description!.split("\n")).toContain("Staff Engineer · Globex");
  });

  it("never fires on a `first_line` section, which cannot read the bucket back", () => {
    // `projects.ts` / `achievements.ts` take `description` from `block.body`
    // and never look at `belowAnchorBodyProse`, so a peel here would drop the
    // text outright rather than clean a header.
    const sections = splitIntoSections(
      groupIntoLines(
        mkItems([
          { text: "PROJECTS", fontSize: 13 },
          {
            text: "Ledger Reconciler 01/2024 – 12/2024 Built a double-entry checker.",
            fontSize: 11,
          },
          { text: "• Reconciled 40k transactions a night.", fontSize: 11 },
        ]),
      ),
    );
    const projects = extractProjects(findSection(sections, "projects")).value;
    expect(projects).toHaveLength(1);
    expect(projects[0].name).toContain("Built a double-entry checker.");
  });
});
