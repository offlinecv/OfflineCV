// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * guidance.ts — dimension score → located action (#810).
 *
 * Pure module, tested at module scope in the shape `recommendation.test.ts`
 * and `ScoreDimensionRow.test.tsx`'s `formatCompletenessHint` block use: build
 * a minimal typed stub, assert behaviour rather than structure.
 *
 * The cases that matter most are the two the acceptance criteria turn on —
 * that a clean résumé produces NOTHING (so the caller renders no chrome rather
 * than an empty container), and that every statement names a place rather than
 * a category. The copy assertions are deliberately about what must NOT appear:
 * a vendor claim, a predicted outcome, or a remark about our own scoring are
 * the three failure modes the house rules name, and each is invisible in code
 * review once the string reads fluently.
 */

import { describe, it, expect } from "vitest";
import {
  buildScoreGuidance,
  locateBullets,
  lengthAdvice,
  type LocatedBullet,
} from "./guidance.ts";
import {
  BULLET_LENGTH_MIN_WORDS,
  BULLET_LENGTH_MAX_WORDS,
  type BulletObservation,
} from "./score.ts";
import type { ContactDisplayField } from "../contact.ts";

/** A bullet that passes every check; each test overrides only what it needs. */
function bullet(overrides: Partial<BulletObservation> = {}): BulletObservation {
  return {
    text: "Shipped the billing rewrite, cutting invoice errors by 40%",
    id: "0|shipped the billing rewrite",
    index: 0,
    hasMetric: true,
    startsWithActionVerb: true,
    wellFormedLength: true,
    wordCount: 12,
    ...overrides,
  };
}

function located(
  b: BulletObservation,
  path = "Experience → Staff Engineer — Acme → bullet 1",
): LocatedBullet {
  return { bullet: b, path };
}

/** A real `ContactDisplayField`, not an assertion over a partial one: if the
 *  shape gains a required member, this stub must fail to compile rather than
 *  let a cast hide it. */
function contactField(label: string): ContactDisplayField {
  return { key: "phone", label, group: "contact", value: "", gated: true };
}

describe("locateBullets", () => {
  it("names section, entry and 1-based bullet position", () => {
    const out = locateBullets([
      {
        heading: "Experience",
        groups: [
          {
            experienceIndex: 0,
            experience: { title: "Staff Engineer", company: "Acme" },
            bullets: [bullet(), bullet({ index: 1 })],
          },
        ],
      },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].path).toBe("Experience → Staff Engineer — Acme → bullet 1");
    expect(out[1].path).toBe("Experience → Staff Engineer — Acme → bullet 2");
  });

  it("uses the section's own heading, not a hardcoded one", () => {
    const out = locateBullets([
      {
        heading: "Selected Projects",
        groups: [
          {
            experienceIndex: 0,
            experience: { title: "Parser" },
            bullets: [bullet()],
          },
        ],
      },
    ]);
    expect(out[0].path).toContain("Selected Projects → Parser");
  });

  it("names the unmatched group honestly rather than claiming a role", () => {
    const out = locateBullets([
      {
        heading: "Experience",
        groups: [{ experienceIndex: null, experience: null, bullets: [bullet()] }],
      },
    ]);
    expect(out[0].path).toBe("Experience → Other bullets → bullet 1");
  });

  it("elides an entry name long enough to be a paragraph", () => {
    const long = "A".repeat(200);
    const out = locateBullets([
      {
        heading: "Experience",
        groups: [
          { experienceIndex: 0, experience: { title: long }, bullets: [bullet()] },
        ],
      },
    ]);
    expect(out[0].path.length).toBeLessThan(120);
    expect(out[0].path).toContain("…");
  });
});

describe("lengthAdvice", () => {
  it("quotes the scorer's own window rather than a hardcoded one", () => {
    const advice = lengthAdvice(bullet({ wordCount: 3, wellFormedLength: false }));
    expect(advice).toContain(`${BULLET_LENGTH_MIN_WORDS}–${BULLET_LENGTH_MAX_WORDS}`);
  });

  it("distinguishes too short from too long, and names the count", () => {
    expect(lengthAdvice(bullet({ wordCount: 3 }))).toContain("Too short");
    expect(lengthAdvice(bullet({ wordCount: 3 }))).toContain("(3)");
    expect(lengthAdvice(bullet({ wordCount: 44 }))).toContain("Too long");
    expect(lengthAdvice(bullet({ wordCount: 44 }))).toContain("(44)");
  });
});

describe("buildScoreGuidance — the no-chrome contract (#810)", () => {
  it("returns nothing for a résumé where every bullet passes and nothing is missing", () => {
    expect(
      buildScoreGuidance({ located: [located(bullet()), located(bullet())] }),
    ).toEqual([]);
  });

  it("returns nothing when there are no bullets at all", () => {
    expect(buildScoreGuidance({ located: [] })).toEqual([]);
  });
});

describe("buildScoreGuidance — each dimension points at a place", () => {
  it("names the bullet that carries no metric (Specificity)", () => {
    const items = buildScoreGuidance({
      located: [located(bullet({ hasMetric: false }), "Experience → PM — Globex → bullet 2")],
    });
    const spec = items.filter((i) => i.dimension === "specificity");
    expect(spec).toHaveLength(1);
    expect(spec[0].where).toBe("Experience → PM — Globex → bullet 2");
    expect(spec[0].action).toContain("number");
  });

  it("names the bullet that opens weakly, and the one out of the length window (Structure)", () => {
    const items = buildScoreGuidance({
      located: [
        located(bullet({ startsWithActionVerb: false }), "Experience → A → bullet 1"),
        located(
          bullet({ wellFormedLength: false, wordCount: 4 }),
          "Experience → A → bullet 2",
        ),
      ],
    });
    const structure = items.filter((i) => i.dimension === "structure");
    expect(structure).toHaveLength(2);
    expect(structure[0].where).toBe("Experience → A → bullet 1");
    expect(structure[0].action).toContain("action verb");
    expect(structure[1].where).toBe("Experience → A → bullet 2");
    expect(structure[1].action).toContain("too short");
  });

  it("lists a bullet once per failing check, because they are different edits", () => {
    const items = buildScoreGuidance({
      located: [
        located(
          bullet({
            hasMetric: false,
            startsWithActionVerb: false,
            wellFormedLength: false,
            wordCount: 2,
          }),
        ),
      ],
    });
    expect(items.filter((i) => i.dimension === "specificity")).toHaveLength(1);
    expect(items.filter((i) => i.dimension === "structure")).toHaveLength(2);
  });

  it("names the missing contact field with the label the contact card uses (Completeness)", () => {
    const items = buildScoreGuidance({
      located: [],
      contactMissing: [contactField("Phone")],
    });
    expect(items).toHaveLength(1);
    expect(items[0].dimension).toBe("completeness");
    expect(items[0].where).toBe("Contact → Phone");
  });

  it("maps the scorer's own non-contact labels to a section and an action", () => {
    const items = buildScoreGuidance({
      located: [],
      completeness: { missing: ["summary", "skills", "education"] },
    });
    expect(items.map((i) => i.where)).toEqual(["Summary", "Skills", "Education"]);
  });

  it("ignores a completeness label it has no advice for, rather than inventing one", () => {
    expect(
      buildScoreGuidance({
        located: [],
        completeness: { missing: ["a check renamed in score.ts"] },
      }),
    ).toEqual([]);
  });

  it("prefers the redacted-dates advice over the generic date row", () => {
    const items = buildScoreGuidance({
      located: [],
      completeness: { missing: ["role dates"], redactedDates: true },
    });
    expect(items).toHaveLength(1);
    expect(items[0].action).toContain("4-digit years");
  });
});

describe("buildScoreGuidance — determinism and bounds", () => {
  it("is deterministic: the same input yields the same output", () => {
    const input = {
      located: [
        located(bullet({ hasMetric: false }), "Experience → A → bullet 1"),
        located(bullet({ startsWithActionVerb: false }), "Experience → A → bullet 2"),
      ],
      contactMissing: [contactField("Email")],
    };
    expect(buildScoreGuidance(input)).toEqual(buildScoreGuidance(input));
  });

  it("caps each dimension so a weak résumé does not become a wall of text", () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      located(bullet({ hasMetric: false, index: i }), `Experience → A → bullet ${i + 1}`),
    );
    const items = buildScoreGuidance({ located: many });
    expect(items.filter((i) => i.dimension === "specificity")).toHaveLength(3);
  });

  it("honours an explicit cap, and returns nothing at zero", () => {
    const many = Array.from({ length: 5 }, () => located(bullet({ hasMetric: false })));
    expect(buildScoreGuidance({ located: many, maxPerDimension: 1 })).toHaveLength(1);
    expect(buildScoreGuidance({ located: many, maxPerDimension: 0 })).toEqual([]);
  });

  it("orders dimensions by the weight the score gives them", () => {
    const items = buildScoreGuidance({
      located: [
        located(
          bullet({ hasMetric: false, startsWithActionVerb: false }),
          "Experience → A → bullet 1",
        ),
      ],
      contactMissing: [contactField("Phone")],
    });
    expect(items.map((i) => i.dimension)).toEqual([
      "specificity",
      "structure",
      "completeness",
    ]);
  });
});

describe("buildScoreGuidance — house copy rules (#810)", () => {
  /** Every string the module can emit, across all three dimensions. */
  function allCopy(): string[] {
    const items = buildScoreGuidance({
      located: [
        located(
          bullet({
            hasMetric: false,
            startsWithActionVerb: false,
            wellFormedLength: false,
            wordCount: 2,
          }),
        ),
        located(bullet({ wellFormedLength: false, wordCount: 50 })),
      ],
      contactMissing: [contactField("Phone")],
      completeness: {
        missing: ["summary", "skills", "work experience", "education"],
        redactedDates: true,
      },
    });
    return items.map((i) => i.action);
  }

  it("never implies what a specific applicant tracking system will do", () => {
    for (const copy of allCopy()) {
      expect(copy.toLowerCase()).not.toMatch(
        /\bats\b|applicant tracking|recruiter|will (?:be )?(?:pass|reject|parse|rank|score)/,
      );
    }
  });

  it("never predicts an outcome or promises a score change", () => {
    for (const copy of allCopy()) {
      expect(copy.toLowerCase()).not.toMatch(
        /guarantee|you will|increase your score|more interviews|get hired/,
      );
    }
  });

  it("uses no self-serving negation about our own scoring", () => {
    for (const copy of allCopy()) {
      expect(copy.toLowerCase()).not.toMatch(/we (?:never|don't|do not)|our (?:score|parser)/);
    }
  });

  it("states every action as something to do, not as a fault", () => {
    for (const copy of allCopy()) {
      expect(copy.length).toBeGreaterThan(0);
      expect(copy).not.toMatch(/^You failed|^Bad |^Wrong /);
    }
  });
});
