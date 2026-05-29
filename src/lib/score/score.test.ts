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
    return {
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
      ...overrides,
    };
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

  it("drops Specificity proportional to non-metric bullets", () => {
    // Each line has ≥4 words after the marker so all six register as bullets.
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
    const result = computeAnonymousAtsScore(
      makeAnonInput({
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
});
