// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

import {
  computeAtsScore,
  computeAnonymousAtsScore,
  getScoreTier,
  getScoreLabel,
} from "./score";
import type { AnonymousAtsScoreInput } from "./score";
import type { ResumeData } from "./types";
import type { SectionedResume } from "../heuristics/sections";

/** Build the typed section view the anonymous scorer now consumes (#133). The
 *  scorer pools bullets from the accomplishment sections (experience /
 *  projects / achievements) and never from skills, so populate `byName` per the
 *  options. Lines are passed exactly as the cascade would supply them: trimmed,
 *  non-empty, leading bullet markers intact. */
function makeSections(opts: {
  experience?: readonly string[];
  skills?: readonly string[];
  projects?: readonly string[];
  achievements?: readonly string[];
} = {}): SectionedResume {
  const byName = new Map<string, readonly string[]>();
  if (opts.experience && opts.experience.length > 0)
    byName.set("experience", opts.experience);
  if (opts.projects && opts.projects.length > 0)
    byName.set("projects", opts.projects);
  if (opts.achievements && opts.achievements.length > 0)
    byName.set("achievements", opts.achievements);
  if (opts.skills && opts.skills.length > 0) byName.set("skills", opts.skills);
  return {
    byName: byName as SectionedResume["byName"],
    accomplishmentSections: ["experience", "projects", "achievements"],
    source: "regex",
  };
}

// The scoreSpecificity pipeline wraps bulletHasMetric. Rather than export the
// helper, we exercise it end-to-end by scoring a single-entry resume whose
// description is just the bullet under test — if the bullet registers as a
// metric, `flagged_bullets` is empty; otherwise it contains the entry id.
function bulletRegistersAsMetric(bullet: string): boolean {
  const result = computeAtsScore({
    full_name: "T",
    email: "t@example.com",
    phone: "1",
    location: "X",
    summary: "",
    skills: [],
    experience: [
      {
        id: "probe",
        title: "Role",
        company: "Co",
        description: `- ${bullet}`,
      },
    ],
    education: [],
  });
  return !result.dimensions.specificity.flagged_bullets.includes("probe");
}

function makeResume(overrides: Partial<ResumeData> = {}): ResumeData {
  return {
    full_name: "Jane Doe",
    email: "jane@example.com",
    phone: "555-0100",
    location: "San Francisco, CA",
    summary: "Experienced software engineer with 10 years of backend development.",
    skills: ["TypeScript", "Go", "PostgreSQL"],
    experience: [
      {
        id: "exp-1",
        title: "Senior Engineer",
        company: "Acme Corp",
        start_date: "Jan 2020",
        end_date: "Present",
        description: "- Led migration of **3 microservices** reducing latency by **40%**\n- Managed team of **5 engineers**",
        is_current: true,
      },
    ],
    education: [
      { degree: "BS Computer Science", institution: "MIT", year: "2014" },
    ],
    ...overrides,
  };
}

describe("computeAtsScore", () => {
  it("returns a score with all dimensions", () => {
    const result = computeAtsScore(makeResume());
    expect(result.overall).toBeGreaterThanOrEqual(0);
    expect(result.overall).toBeLessThanOrEqual(100);
    expect(result.mode).toBe("deterministic");
    expect(result.scored_at).toBeTruthy();
    expect(result.dimensions.specificity).toBeDefined();
    expect(result.dimensions.structure).toBeDefined();
    expect(result.dimensions.completeness).toBeDefined();
  });

  it("gives high specificity when bullets have metrics", () => {
    const resume = makeResume({
      experience: [
        {
          id: "exp-1",
          title: "Engineer",
          company: "Corp",
          description: "- Increased throughput by **50%**\n- Reduced costs by **$2M**\n- Managed **12 engineers**",
        },
      ],
    });
    const result = computeAtsScore(resume);
    expect(result.dimensions.specificity.score).toBeGreaterThan(50);
    expect(result.dimensions.specificity.flagged_bullets).toHaveLength(0);
  });

  it("flags entries without metrics", () => {
    const resume = makeResume({
      experience: [
        {
          id: "exp-no-metrics",
          title: "Engineer",
          company: "Corp",
          description: "- Worked on various projects\n- Collaborated with team members",
        },
      ],
    });
    const result = computeAtsScore(resume);
    expect(result.dimensions.specificity.flagged_bullets).toContain("exp-no-metrics");
  });

  it("skips metrics_na entries for specificity flagging", () => {
    const resume = makeResume({
      experience: [
        {
          id: "exp-na",
          title: "Engineer",
          company: "Corp",
          description: "- General responsibilities",
          metrics_na: true,
        },
      ],
    });
    const result = computeAtsScore(resume);
    expect(result.dimensions.specificity.flagged_bullets).not.toContain("exp-na");
  });

  it("reports missing fields in completeness", () => {
    const resume = makeResume({ email: undefined, summary: undefined });
    const result = computeAtsScore(resume);
    expect(result.dimensions.completeness.missing).toContain("email");
    expect(result.dimensions.completeness.missing).toContain("summary");
  });

  it("scores 0 for empty experience", () => {
    const resume = makeResume({ experience: [] });
    const result = computeAtsScore(resume);
    expect(result.dimensions.specificity.score).toBe(0);
    expect(result.dimensions.structure.score).toBe(0);
  });
});

describe("bulletHasMetric — industry-aligned detection", () => {
  describe("Mallika v8 regression corpus", () => {
    const positives = [
      "sustain 2 releases / week across web, iOS, and Android",
      "managing a team of ~5-6 QA members across the US and India",
      "launched ~7-8 new features within a one-year period",
      "led migration of 25 countries from Google Play",
      "Certified ~200+ server builds annually (~4 daily)",
      "~10-15 major feature launches annually",
      "~50+ new features annually",
      "Ran 5 builds / week",
      "Final Cut Studio across all 5 components, with 4 builds / week",
    ];
    it.each(positives)("registers as a metric: %s", (bullet) => {
      expect(bulletRegistersAsMetric(bullet)).toBe(true);
    });
  });

  describe("industry examples", () => {
    it("VMock: 'Led a team of 5'", () => {
      expect(bulletRegistersAsMetric("Led a team of 5")).toBe(true);
    });
    it("Resume Worded: '25,000 monthly active users'", () => {
      expect(bulletRegistersAsMetric("Grew to 25,000 monthly active users")).toBe(true);
    });
    it("Teal: 'Increased profits 50% in 5 weeks'", () => {
      expect(bulletRegistersAsMetric("Increased profits 50% in 5 weeks")).toBe(true);
    });
    it("VMock: 'Managed $3M turnaround'", () => {
      expect(bulletRegistersAsMetric("Managed $3M turnaround")).toBe(true);
    });
  });

  describe("negative cases", () => {
    it("no digits at all", () => {
      expect(bulletRegistersAsMetric("Managed the team effectively")).toBe(false);
    });
    it("year tokens only — date-range bullet", () => {
      expect(
        bulletRegistersAsMetric("From 2013 to 2021 I worked on the platform"),
      ).toBe(false);
    });
    it("no digits — 'Filed bugs in Radar'", () => {
      expect(bulletRegistersAsMetric("Filed bugs in Radar")).toBe(false);
    });
    it("no digits — 'Authored and ran daily test cases'", () => {
      expect(bulletRegistersAsMetric("Authored and ran daily test cases")).toBe(false);
    });
  });

  describe("strong-signal patterns still work end-to-end", () => {
    it("% metric", () => expect(bulletRegistersAsMetric("Reduced latency by 40%")).toBe(true));
    it("$ metric", () => expect(bulletRegistersAsMetric("Saved $500K annually")).toBe(true));
    it("K/M/B suffix", () => expect(bulletRegistersAsMetric("Served 2M users")).toBe(true));
    it("Nx multiplier", () => expect(bulletRegistersAsMetric("Achieved 3x throughput")).toBe(true));
  });
});

describe("getScoreTier", () => {
  it("returns high for 80+", () => expect(getScoreTier(80)).toBe("high"));
  it("returns medium for 60-79", () => expect(getScoreTier(65)).toBe("medium"));
  it("returns low for <60", () => expect(getScoreTier(40)).toBe("low"));
});

describe("getScoreLabel", () => {
  it("returns Strong for high", () => expect(getScoreLabel("high")).toBe("Strong"));
  it("returns Getting There for medium", () => expect(getScoreLabel("medium")).toBe("Getting There"));
  it("returns Needs Work for low", () => expect(getScoreLabel("low")).toBe("Needs Work"));
});

describe("computeAnonymousAtsScore", () => {
  // Six bullets, all metric, all action-verb-led, all in the 8–30-word window.
  const STRONG_BULLETS = [
    "- Led migration of 3 microservices reducing latency by 40%",
    "- Managed team of 5 engineers shipping weekly releases",
    "- Reduced infrastructure cost by 35% through right-sizing and reserved capacity",
    "- Increased conversion rate by 22% through experimentation framework rollout",
    "- Built CI pipeline cutting deploy time from 45 minutes to 8 minutes",
    "- Drove adoption of typed APIs across 12 backend services",
  ].join("\n");

  function makeAnonInput(
    overrides: Partial<AnonymousAtsScoreInput> = {},
  ): AnonymousAtsScoreInput {
    const base: AnonymousAtsScoreInput = {
      parsed: {
        full_name: "Jane Doe",
        email: "jane@example.com",
        phone: "555-0100",
        location: "San Francisco, CA",
        linkedin_url: "https://www.linkedin.com/in/janedoe",
        summary: "Backend engineer with ten years of distributed systems work.",
        skills: ["TypeScript", "Go", "PostgreSQL"],
        experience: [
          { title: "Senior Engineer", company: "Acme", start_date: "Jan 2020" },
          { title: "Engineer", company: "Beta", start_date: "Mar 2017" },
        ],
        education: [{ degree: "BS CS", institution: "MIT" }],
      },
      fieldConfidence: {
        full_name: 0.9,
        email: 0.95,
        phone: 0.9,
        location: 0.8,
        linkedin_url: 0.95,
      },
      triggers: [],
      rawText: STRONG_BULLETS,
      // Placeholder; replaced below from the (post-override) rawText unless the
      // caller explicitly passes its own sections.
      sections: makeSections(),
      ...overrides,
    };
    // The bullet pool now comes from the experience section (#133), not rawText.
    // To keep the legacy `makeAnonInput({ rawText: ... })` tests working, route
    // the rawText bullet lines into the experience section by default — but only
    // when the caller didn't supply its own `sections`.
    if (overrides.sections === undefined) {
      const expLines = base.rawText
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      base.sections = makeSections({ experience: expLines });
    }
    return base;
  }

  it("scores near-100 for a clean resume with strong bullets", () => {
    const result = computeAnonymousAtsScore(makeAnonInput());
    expect(result.overall).toBeGreaterThanOrEqual(95);
    expect(result.specificity.gradable).toBe(true);
    expect(result.structure.gradable).toBe(true);
    expect(result.completeness.score).toBe(30);
    expect(result.layout.multiplier).toBe(1);
  });

  it("zeroes the score when the PDF is scanned, regardless of bullets", () => {
    const result = computeAnonymousAtsScore(
      makeAnonInput({ triggers: ["scanned"] }),
    );
    expect(result.overall).toBe(0);
    expect(result.layout.scanned).toBe(true);
    expect(result.layout.multiplier).toBe(0);
  });

  it("applies a 15% penalty for one non-scanned layout trigger", () => {
    const input = makeAnonInput({ triggers: ["two_column"] });
    const result = computeAnonymousAtsScore(input);
    expect(result.layout.multiplier).toBe(0.85);
    expect(result.overall).toBe(Math.round(result.preLayoutOverall * 0.85));
  });

  it("marks bullet-level dims ungradable when no bullets are detected", () => {
    const result = computeAnonymousAtsScore(
      makeAnonInput({
        rawText: "Just a paragraph of text with no bullet markers anywhere.",
      }),
    );
    expect(result.specificity.gradable).toBe(false);
    expect(result.structure.gradable).toBe(false);
    expect(result.specificity.totalBullets).toBe(0);
    expect(result.specificity.score).toBe(0);
    expect(result.structure.score).toBe(0);
  });

  it("counts short bullets in the visible total even when too short to score well (issue #9)", () => {
    // Issue #9: previously ANON_BULLET_MIN_WORDS = 4 silently dropped short
    // bullets like "• Everything that matters." (3 words after marker
    // strip), so the displayed bullet count under-reported what the user
    // could see in the PDF. The fix counts every marker-prefixed line and
    // lets the well-formed length window flag short bullets in per-bullet
    // feedback rather than hiding them.
    const mixedLengths = [
      "- Led migration of 3 microservices reducing latency by 40%",
      "- Managed team of 5 engineers shipping weekly releases",
      "- Reduced infrastructure cost by 35% through right-sizing efforts",
      "- Increased conversion rate by 22% through experimentation",
      "- Built CI pipeline cutting deploy time from 45 to 8 minutes",
      "- Everything that matters.", // 3 words — pre-fix this was dropped
    ].join("\n");
    const result = computeAnonymousAtsScore(
      makeAnonInput({ rawText: mixedLengths }),
    );
    expect(result.specificity.totalBullets).toBe(6);
    expect(result.bullets?.length).toBe(6);
    // The short bullet adds 1 to the denominator without contributing to
    // metric/structure numerators, so quality scores drop slightly — that's
    // the correct grading, previously masked by hiding the bullet.
    expect(result.specificity.metricBullets).toBe(5);
  });

  it("drops Specificity proportional to non-metric bullets", () => {
    // Each line has multiple words after the marker so all six register as
    // bullets. (Min words to count as a bullet is 1; quality grading is
    // handled by the length-window check, not the count filter.)
    const fewMetrics = [
      "- Reduced latency by 40%",
      "- Built a thing for users to enjoy",
      "- Owned the test plan and execution rollout",
      "- Went to lots of meetings about projects",
      "- Helped with various team initiatives",
      "- Worked closely with cross-functional partners",
    ].join("\n");
    const result = computeAnonymousAtsScore(
      makeAnonInput({ rawText: fewMetrics }),
    );
    expect(result.specificity.metricBullets).toBe(1);
    expect(result.specificity.totalBullets).toBe(6);
    expect(result.specificity.score).toBeLessThan(15); // out of 40 — 1/6 of 0.6 floor
  });

  it("drops Structure when bullets lack action verbs", () => {
    const noVerbs = [
      "- The project was a great success for the team",
      "- During this time many things happened",
      "- Among the activities undertaken were several initiatives",
      "- Work was done across multiple repositories successfully",
    ].join("\n");
    const result = computeAnonymousAtsScore(
      makeAnonInput({ rawText: noVerbs }),
    );
    expect(result.structure.score).toBeLessThan(20); // half-credit at most
  });

  it("does not credit contact fields below the confidence floor", () => {
    const result = computeAnonymousAtsScore(
      makeAnonInput({
        fieldConfidence: {
          full_name: 0.4, // below floor
          email: 0.95,
          phone: 0.9,
          location: 0.8,
          linkedin_url: 0.95,
        },
      }),
    );
    expect(result.completeness.missing).toContain("name");
  });

  it("flags missing sections in completeness", () => {
    // With empty parsed.experience AND no experience section, the experience
    // completeness check fails (#133 — it now asks "is there a non-empty
    // experience section?", not "did we see any bullet anywhere?"). rawText is
    // empty so the default makeAnonInput builds an empty experience section.
    const result = computeAnonymousAtsScore(
      makeAnonInput({
        rawText: "",
        parsed: {
          full_name: "Jane",
          email: "jane@example.com",
          phone: "555-0100",
          location: "SF",
          linkedin_url: "linkedin.com/in/x",
          skills: ["TS"], // <3
          experience: [],
          education: [],
        },
      }),
    );
    expect(result.completeness.missing).toEqual(
      expect.arrayContaining(["skills", "work experience", "education"]),
    );
  });

  it("treats scoring tier the same way as the authed score", () => {
    const strong = computeAnonymousAtsScore(makeAnonInput());
    expect(getScoreTier(strong.overall)).toBe("high");
  });

  describe("per-bullet observations", () => {
    it("returns one observation per extracted bullet, in order", () => {
      const result = computeAnonymousAtsScore(makeAnonInput());
      expect(result.bullets).toBeDefined();
      expect(result.bullets).toHaveLength(6);
      // Index is stable across the array.
      result.bullets!.forEach((b, i) => expect(b.index).toBe(i));
    });

    it("flags hasMetric / startsWithActionVerb / wellFormedLength per bullet", () => {
      // Bullets must clear the 4-word extractor floor to reach analyzeBullets,
      // so the "too short" cases use 5–7 words (below the 8-word wellFormed floor).
      const mixed = [
        "- Led migration of 3 microservices reducing latency by 40%", // pass all three
        "- Things happened over multiple weeks", // 5 words, no verb, no metric, too short
        "- Reduced costs over multiple quarters", // 5 words, has verb, no metric, too short
        "- Built a thing for users to enjoy across the entire platform stack and beyond extra extra extra extra extra extra extra extra extra extra extra extra extra extra extra extra extra words now", // >30 words, has verb, no metric
      ].join("\n");
      const result = computeAnonymousAtsScore(
        makeAnonInput({ rawText: mixed }),
      );
      const bullets = result.bullets!;
      expect(bullets).toHaveLength(4);

      // Bullet 0: pass all
      expect(bullets[0].hasMetric).toBe(true);
      expect(bullets[0].startsWithActionVerb).toBe(true);
      expect(bullets[0].wellFormedLength).toBe(true);

      // Bullet 1: no verb, no metric, too short
      expect(bullets[1].hasMetric).toBe(false);
      expect(bullets[1].startsWithActionVerb).toBe(false);
      expect(bullets[1].wellFormedLength).toBe(false);
      expect(bullets[1].wordCount).toBe(5);

      // Bullet 2: verb passes, but too short and no metric
      expect(bullets[2].hasMetric).toBe(false);
      expect(bullets[2].startsWithActionVerb).toBe(true);
      expect(bullets[2].wellFormedLength).toBe(false);

      // Bullet 3: long bullet — verb passes, but >30 words, no metric
      expect(bullets[3].hasMetric).toBe(false);
      expect(bullets[3].startsWithActionVerb).toBe(true);
      expect(bullets[3].wellFormedLength).toBe(false);
      expect(bullets[3].wordCount).toBeGreaterThan(30);
    });

    it("returns an empty bullets array when no bullet-shaped lines are detected", () => {
      const result = computeAnonymousAtsScore(
        makeAnonInput({
          rawText: "Just a paragraph of text with no bullet markers anywhere.",
        }),
      );
      expect(result.bullets).toEqual([]);
    });

    it("treats U+F0B7 (Word's Symbol-font bullet) as a bullet marker", () => {
      // Real-world case: Microsoft Word exports every default `•` bullet as
      // U+F0B7 in the Symbol font's private-use area. pdfjs hands this glyph
      // through unchanged. Without recognizing it, every bullet from a
      // Word-exported resume disappears from the per-bullet feedback section.
      const wordBullets = [
        " Led migration of 3 microservices reducing latency by 40%",
        " Built CI pipeline cutting deploy time from 45 to 8 minutes",
        " Reduced infrastructure cost by 35% through right-sizing",
        " Drove adoption of typed APIs across 12 backend services",
      ].join("\n");
      const result = computeAnonymousAtsScore(
        makeAnonInput({ rawText: wordBullets }),
      );
      expect(result.bullets).toHaveLength(4);
      expect(result.bullets!.every((b) => b.hasMetric)).toBe(true);
    });

    it("treats U+FFFD (font-substituted bullet glyph) as a bullet marker", () => {
      // Real-world case: a PDF carries the • glyph but its ToUnicode map
      // doesn't decode it, so pdfjs emits U+FFFD ("□") in its place. The
      // rest of the line decodes fine, so the cascade doesn't trip
      // `fonts_unmappable` — but without recognizing U+FFFD as a marker, every
      // bullet would silently disappear from the per-bullet feedback section.
      const fontSubstituted = [
        "� Led migration of 3 microservices reducing latency by 40%",
        "� Built CI pipeline cutting deploy time from 45 to 8 minutes",
        "� Reduced infrastructure cost by 35% through right-sizing",
        "� Drove adoption of typed APIs across 12 backend services",
      ].join("\n");
      const result = computeAnonymousAtsScore(
        makeAnonInput({ rawText: fontSubstituted }),
      );
      expect(result.bullets).toHaveLength(4);
      expect(result.bullets!.every((b) => b.hasMetric)).toBe(true);
    });

    it("preserves the same bullet pool the dimension scoring uses", () => {
      const result = computeAnonymousAtsScore(makeAnonInput());
      // The totalBullets reported by dimensions must match the bullets-array length.
      expect(result.bullets!.length).toBe(result.specificity.totalBullets);
      expect(result.bullets!.length).toBe(result.structure.totalBullets);
      // And the per-bullet hasMetric flags must sum to the dimension's metricBullets.
      const metricCount = result.bullets!.filter((b) => b.hasMetric).length;
      expect(metricCount).toBe(result.specificity.metricBullets);
    });
  });

  describe("skills are never in the experience pool — by construction (#133)", () => {
    // A bulleted skills section ("• Project management, Data analysis") must not
    // be judged by the action-verb / metric / length rules. Under #133 the pool
    // is sourced from the accomplishment sections only, so skills lines can
    // never enter it — there is no subtraction step. Section membership, not a
    // subtraction set, is what determines pooling.
    const skillsLines = [
      "• Project management, Data analysis",
      "• Communication, Problem-solving",
    ];

    it("drops skills-section lines from the pool", () => {
      // Skills lines live only in the skills section (no experience section) →
      // nothing pools.
      const result = computeAnonymousAtsScore(
        makeAnonInput({ sections: makeSections({ skills: skillsLines }) }),
      );
      expect(result.bullets ?? []).toHaveLength(0);
    });

    it("counts the SAME lines when placed in the experience section — proving section membership is what pools them", () => {
      // The exact lines that were dropped from the skills section DO count when
      // they sit in the experience section. This pins that pooling is by section
      // identity, not by a subtraction set.
      const result = computeAnonymousAtsScore(
        makeAnonInput({ sections: makeSections({ experience: skillsLines }) }),
      );
      expect((result.bullets ?? []).length).toBe(2);
    });

    it("does not exclude genuine experience bullets outside the skills section", () => {
      const expLines = STRONG_BULLETS.split("\n");
      const result = computeAnonymousAtsScore(
        makeAnonInput({
          sections: makeSections({
            experience: expLines,
            skills: skillsLines,
          }),
        }),
      );
      expect(result.bullets!.length).toBe(6);
    });
  });

  describe("lone-bullet glyph merge (Word-table layout, #30)", () => {
    // pdfjs/pdftotext can split a table-cell bullet so the "•" lands on its own
    // line and the text on the next. toSectionedResume filters blank lines, so
    // within a section the glyph line is immediately followed by its text line;
    // the extractor merges them before scoring.
    it("merges a marker-only line with the following text line in the same section", () => {
      const result = computeAnonymousAtsScore(
        makeAnonInput({
          sections: makeSections({
            experience: [
              "•",
              "Led migration of 3 microservices reducing latency by 40%",
            ],
          }),
        }),
      );
      expect(result.bullets!.map((b) => b.text)).toEqual([
        "Led migration of 3 microservices reducing latency by 40%",
      ]);
    });

    it("a lone-bullet skills entry never enters the pool (skills is not an accomplishment section)", () => {
      const result = computeAnonymousAtsScore(
        makeAnonInput({
          sections: makeSections({
            skills: ["•", "Project management, Data analysis"],
          }),
        }),
      );
      expect(result.bullets ?? []).toHaveLength(0);
    });
  });

  describe("redacted role dates (#31)", () => {
    // A role whose date is a redaction stub ("August 20XX") stays incomplete,
    // but must score distinctly from a role with no date text at all and drive
    // the "use 4-digit years" guidance.
    const undatedRole = [{ title: "Office Manager", company: "Acme" }];
    function inputWith(rawText: string): AnonymousAtsScoreInput {
      return makeAnonInput({
        parsed: {
          full_name: "Jane Doe",
          email: "jane@example.com",
          phone: "555-0100",
          location: "San Francisco, CA",
          linkedin_url: "https://www.linkedin.com/in/janedoe",
          summary: "Backend engineer with ten years of distributed systems work.",
          skills: ["TypeScript", "Go", "PostgreSQL"],
          experience: undatedRole,
          education: [{ degree: "BS CS", institution: "MIT" }],
        },
        rawText,
      });
    }

    it("flags redacted dates incomplete but scores above wholly-missing dates", () => {
      const redacted = computeAnonymousAtsScore(
        inputWith("Office Manager, Acme\nAugust 20XX – March 20XX"),
      );
      const missing = computeAnonymousAtsScore(
        inputWith("Office Manager, Acme"),
      );
      expect(redacted.completeness.redactedDates).toBe(true);
      expect(redacted.completeness.missing).toContain("role dates");
      expect(missing.completeness.redactedDates).toBeFalsy();
      expect(redacted.completeness.score).toBeGreaterThan(
        missing.completeness.score,
      );
    });

    it.each([
      "August 20XX – March 20XX",
      "Jan XXXX – Dec XXXX",
      "Mar #### – Jun ####",
      "August 20-- – March 20--",
    ])("detects the redaction token family in %s", (dateLine) => {
      const result = computeAnonymousAtsScore(inputWith(`Role, Co\n${dateLine}`));
      expect(result.completeness.redactedDates).toBe(true);
    });

    it("does not flag a bare XXXX outside a date context", () => {
      const result = computeAnonymousAtsScore(
        inputWith("Office Manager, Acme\nBadge ID XXXX-7 issued on site"),
      );
      expect(result.completeness.redactedDates).toBeFalsy();
    });
  });
});
