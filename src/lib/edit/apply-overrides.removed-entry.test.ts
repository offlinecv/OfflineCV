// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * #856 — a PARSED entry the user deleted has to leave the résumé, and every
 * entry that SURVIVES the deletion has to keep its own edits.
 *
 * The second half is the load-bearing one and the reason `removedEntries` is a
 * tombstone set folded LAST rather than a splice. `applyExperienceHeader-
 * Overrides`, `applyEducationFieldOverrides` and `applyCredentialOverrides`
 * are each keyed by PARSED ARRAY INDEX; removing entry 0 by splicing it out of
 * the array before they run shifts every later entry down one, so entry 2's
 * title edit silently lands on what used to be entry 3. Nothing throws and the
 * count is right — the résumé just quietly says the wrong thing. The first
 * describe block below is that regression, run against all three index-keyed
 * sections.
 */

import { describe, it, expect } from "vitest";
import { applyOverrides } from "./apply-overrides.ts";
import { computeAnonymousAtsScore } from "../score/score.ts";
import type { HeuristicParsedResume } from "../heuristics/types.ts";
import type { SectionedResume } from "../heuristics/sections.ts";
import { projectScoreSections } from "../heuristics/projections.ts";

/** Positional stand-ins for `applyOverrides`' long default tail, so each case
 *  below spells out only the arguments it actually exercises. */
const NO_CONTACT = {};
const NO_OBS: never[] = [];

function makeSections(lines: readonly string[] = []): SectionedResume {
  const byName = new Map<string, readonly string[]>();
  if (lines.length > 0) byName.set("experience", lines);
  return {
    byName: byName as SectionedResume["byName"],
    accomplishmentSections: ["experience", "projects", "achievements"],
    source: "regex",
  };
}

/** Three of everything, so "delete the first, keep the other two straight" is
 *  expressible in each index-keyed section. */
function baseParsed(): HeuristicParsedResume {
  return {
    full_name: "Robin Vasquez",
    email: "robin.vasquez@example.com",
    skills: ["typescript"],
    experience: [
      { title: "Intern", company: "Initech", description: "Filed reports" },
      { title: "Engineer", company: "Acme", description: "Built a thing" },
      { title: "Staff Engineer", company: "Globex", description: "Led a team" },
    ],
    education: [
      { degree: "AA", institution: "City College" },
      { degree: "BS", institution: "State University" },
      { degree: "MS", institution: "Tech Institute" },
    ],
    projects: [
      { name: "Ghost Project", description: "Stitched out of two blocks" },
      { name: "Real Project", description: "Shipped it" },
    ],
    heuristic_achievements: [
      { type: "Patent", title: "Phantom method", year: "2019" },
      { type: "Award", title: "Best Paper", year: "2020" },
      { type: "Talk", title: "Scaling parsers", year: "2021" },
    ],
  };
}

/** `applyOverrides` with only the arguments a removal case needs. */
function fold(
  parsed: HeuristicParsedResume,
  opts: {
    rawText?: string;
    sections?: SectionedResume;
    experience?: Parameters<typeof applyOverrides>[4];
    education?: Parameters<typeof applyOverrides>[7];
    achievements?: Parameters<typeof applyOverrides>[14];
    descriptions?: Parameters<typeof applyOverrides>[15];
    removedEntries?: ReadonlySet<string>;
  } = {},
) {
  return applyOverrides(
    parsed,
    opts.rawText ?? "",
    opts.sections ?? makeSections(),
    NO_CONTACT,
    opts.experience ?? {},
    {},
    NO_OBS,
    opts.education ?? {},
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    opts.achievements ?? {},
    opts.descriptions ?? {},
    undefined,
    opts.removedEntries ?? new Set(),
  );
}

describe("#856 index integrity — a deletion must not rebind a survivor's edits", () => {
  it("keeps each surviving ACHIEVEMENT holding its own override", () => {
    const { fields } = fold(baseParsed(), {
      achievements: { 1: { title: "Best Paper (revised)" }, 2: { year: "2022" } },
      removedEntries: new Set(["achievements:0"]),
    });

    const titles = fields.heuristic_achievements!.map((a) => a.title);
    expect(titles).toEqual(["Best Paper (revised)", "Scaling parsers"]);
    // The year edit filed against index 2 must still be on index 2's entry —
    // under a splice-first fold it would have landed on the "Award" above.
    expect(fields.heuristic_achievements![1].year).toBe("2022");
    expect(fields.heuristic_achievements![0].year).toBe("2020");
  });

  it("keeps each surviving EXPERIENCE role holding its own override", () => {
    const { fields } = fold(baseParsed(), {
      experience: { 1: { title: "Senior Engineer" }, 2: { company: "Globex Inc." } },
      removedEntries: new Set(["experience:0"]),
    });

    expect(fields.experience.map((e) => e.title)).toEqual([
      "Senior Engineer",
      "Staff Engineer",
    ]);
    expect(fields.experience[1].company).toBe("Globex Inc.");
    expect(fields.experience[0].company).toBe("Acme");
  });

  it("keeps each surviving EDUCATION entry holding its own override", () => {
    const { fields } = fold(baseParsed(), {
      education: { 1: { degree: "B.S." }, 2: { institution: "MIT" } },
      removedEntries: new Set(["education:0"]),
    });

    expect(fields.education.map((e) => e.degree)).toEqual(["B.S.", "MS"]);
    expect(fields.education[1].institution).toBe("MIT");
    expect(fields.education[0].institution).toBe("State University");
  });

  it("keeps a surviving entry's PROSE description override (#489 keys too)", () => {
    const { fields } = fold(baseParsed(), {
      descriptions: { "projects:1": "Rewritten blurb" },
      removedEntries: new Set(["projects:0"]),
    });

    expect(fields.projects).toEqual([
      { name: "Real Project", description: "Rewritten blurb" },
    ]);
  });

  it("removes two entries in one fold without shifting the second's key", () => {
    const { fields } = fold(baseParsed(), {
      achievements: { 2: { title: "Scaling parsers, revisited" } },
      removedEntries: new Set(["achievements:0", "achievements:1"]),
    });

    expect(fields.heuristic_achievements).toEqual([
      { type: "Talk", title: "Scaling parsers, revisited", year: "2021" },
    ]);
  });
});

describe("#856 fold basics", () => {
  it("is a no-op with an empty tombstone set", () => {
    const { fields } = fold(baseParsed());
    expect(fields.experience).toHaveLength(3);
    expect(fields.education).toHaveLength(3);
    expect(fields.projects).toHaveLength(2);
    expect(fields.heuristic_achievements).toHaveLength(3);
  });

  it("never mutates the input parse", () => {
    const parsed = baseParsed();
    fold(parsed, {
      removedEntries: new Set([
        "experience:0",
        "education:0",
        "projects:0",
        "achievements:0",
      ]),
    });
    expect(parsed.experience).toHaveLength(3);
    expect(parsed.education).toHaveLength(3);
    expect(parsed.projects).toHaveLength(2);
    expect(parsed.heuristic_achievements).toHaveLength(3);
  });

  it("ignores a tombstone the parse has no entry for", () => {
    // A stale key out of a replayed draft, the same staleness the index-keyed
    // override maps absorb with `if (!edu) continue`.
    const { fields } = fold(baseParsed(), {
      removedEntries: new Set(["achievements:99", "coursework:0", "projects:"]),
    });
    expect(fields.heuristic_achievements).toHaveLength(3);
    expect(fields.projects).toHaveLength(2);
  });

  it("ignores an ADDED entry's id — those are spliced out upstream", () => {
    const { fields } = fold(baseParsed(), {
      removedEntries: new Set(["added:3"]),
    });
    expect(fields.experience).toHaveLength(3);
  });
});

describe("#856 the deleted entry's own source line", () => {
  // The shape that makes this more than cosmetic: a title-only achievement is
  // parsed OUT of a `•`-marked line, so that line is in the pool the anonymous
  // scorer grades even though the entry carries no description. Deleting the
  // entry without dropping the line leaves its content grading the résumé.
  const OWNED = "• Patent · Issued US10275736B1, 2019";
  const KEPT = "• Cut p99 checkout latency by 38% via edge caching.";

  function titleOnlyParsed(): HeuristicParsedResume {
    return {
      full_name: "Robin Vasquez",
      email: "robin.vasquez@example.com",
      skills: [],
      experience: [],
      education: [],
      heuristic_achievements: [
        { type: "Patent", title: "Issued US10275736B1", year: "2019" },
      ],
    };
  }

  it("drops the line from rawText AND from the graded pool", () => {
    const before = fold(titleOnlyParsed(), {
      rawText: `${OWNED}\n${KEPT}`,
      sections: makeSections([OWNED, KEPT]),
    });
    const after = fold(titleOnlyParsed(), {
      rawText: `${OWNED}\n${KEPT}`,
      sections: makeSections([OWNED, KEPT]),
      removedEntries: new Set(["achievements:0"]),
    });

    expect(before.rawText).toContain("US10275736B1");
    expect(after.rawText).toBe(KEPT);
    expect(after.fields.heuristic_achievements).toEqual([]);

    const grade = (r: typeof before) =>
      computeAnonymousAtsScore({
        parsed: r.fields,
        fieldConfidence: r.fieldConfidence,
        triggers: [],
        rawText: r.rawText,
        sections: projectScoreSections(r),
      });
    expect(grade(before).bullets?.map((b) => b.text)).toHaveLength(2);
    // The pooled line left with the entry — the whole point.
    expect(grade(after).bullets?.map((b) => b.text)).toEqual([
      "Cut p99 checkout latency by 38% via edge caching.",
    ]);
  });

  it("drops the title's own line out of a two-line header, and only that", () => {
    // "Title" over "Company · dates". Only the first line is identifiable from
    // the entry's fields, so only it goes — the model keeps no source-line
    // provenance to tell us the second line belongs to the same entry.
    const out = fold(baseParsed(), {
      rawText: "Engineer\nAcme · 2020–2022\n• Built a thing",
      sections: makeSections(["• Built a thing"]),
      removedEntries: new Set(["experience:1"]),
    });
    expect(out.rawText).toBe("Acme · 2020–2022\n• Built a thing");
    expect(out.fields.experience.map((e) => e.title)).toEqual([
      "Intern",
      "Staff Engineer",
    ]);
  });

  it("leaves rawText untouched when no line matches the entry at all", () => {
    // A glued one-line header is not reconstructable from the split fields.
    // Best effort by construction, and safe when it misses: the pass never
    // guesses, and the lines it can miss are the UNMARKED ones the bullet pool
    // ignores — so a miss costs a stale line in a disclosure, never a score.
    const raw = "Engineer — Acme · 2020–2022\n• Built a thing";
    const out = fold(baseParsed(), {
      rawText: raw,
      sections: makeSections(["• Built a thing"]),
      removedEntries: new Set(["experience:1"]),
    });
    expect(out.rawText).toBe(raw);
    expect(out.fields.experience).toHaveLength(2);
  });

  it("does not touch a bullet that merely shares a PREFIX with the title", () => {
    // Ownership is exact on the residue-tolerant key, never containment — the
    // same guarantee `suppressTitleOwnedBullets` rests on.
    const near = "• Issued US10275736B1 after a three-year prosecution";
    const out = fold(titleOnlyParsed(), {
      rawText: near,
      sections: makeSections([near]),
      removedEntries: new Set(["achievements:0"]),
    });
    expect(out.rawText).toBe(near);
  });
});
