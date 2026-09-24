// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { describe, it, expect } from "vitest";
import {
  computeScoreGuidance,
  bulletAnchorId,
  contactFieldAnchorId,
} from "./guidance.ts";
import {
  metricBulletsToFullSpecificity,
  type AnonymousAtsScore,
  type BulletObservation,
} from "./score.ts";

function createMockScore(overrides?: Partial<AnonymousAtsScore>): AnonymousAtsScore {
  return {
    overall: 55,
    preLayoutOverall: 55,
    specificity: {
      score: 15,
      max: 40,
      gradable: true,
      metricBullets: 1,
      totalBullets: 3,
    },
    structure: {
      score: 20,
      max: 30,
      gradable: true,
      goodBullets: 2,
      verbLedBullets: 2,
      inWindowBullets: 2,
      totalBullets: 3,
    },
    completeness: {
      score: 20,
      max: 30,
      gradable: true,
      missing: ["phone", "summary"],
    },
    layout: {
      triggers: [],
      multiplier: 1,
      scanned: false,
    },
    bullets: [
      {
        id: "0|shipped something great",
        text: "Shipped something great",
        index: 0,
        hasMetric: false,
        startsWithActionVerb: true,
        wellFormedLength: false, // 3 words -> < 8
        wordCount: 3,
      },
      {
        id: "1|helped with 5 projects",
        text: "Helped with 5 projects across the engineering organization",
        index: 1,
        hasMetric: true,
        startsWithActionVerb: false, // "Helped" is weak or assume startsWithActionVerb false
        wellFormedLength: true,
        wordCount: 8,
      },
      {
        id: "2|engineered high-throughput pipeline handling 100k requests daily",
        text: "Engineered high-throughput pipeline handling 100k requests daily",
        index: 2,
        hasMetric: true,
        startsWithActionVerb: true,
        wellFormedLength: true,
        wordCount: 8,
      },
    ],
    ...overrides,
  };
}

describe("guidance.ts — score guidance generator (#810)", () => {
  it("encodes bullet anchors as valid DOM IDs", () => {
    expect(bulletAnchorId("0|shipped something")).toBe("bullet-0_7c_shipped_20_something");
    expect(bulletAnchorId("0|naïve café")).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(contactFieldAnchorId("phone")).toBe("contact-field-phone");
  });

  it("never gives two bullet ids the same anchor", () => {
    // The old `_` substitution mapped all three of these to `bullet-0_a_b`.
    const ids = ["0|a b", "0|a_b", "0|a|b", "0|a__b", "0|a_7c_b"];
    expect(new Set(ids.map(bulletAnchorId)).size).toBe(ids.length);
  });

  it("derives contact completeness guidance with actionable copy", () => {
    const score = createMockScore({
      completeness: {
        score: 10,
        max: 30,
        gradable: true,
        missing: ["name", "email", "phone", "location", "LinkedIn"],
      },
      bullets: [],
    });

    const items = computeScoreGuidance(score, {});

    expect(items.map((i) => i.location)).toEqual([
      "Contact → Name",
      "Contact → Email",
      "Contact → Phone",
      "Contact → Location",
      "Contact → Professional profile",
    ]);

    const phoneItem = items.find((i) => i.fieldName === "phone")!;
    expect(phoneItem.dimension).toBe("completeness");
    expect(phoneItem.targetAnchor).toBe("contact-field-phone");
    expect(phoneItem.issues[0].suggestion).toContain("phone number with area code");
  });

  it("derives section completeness guidance for summary, experience, education, skills", () => {
    const score = createMockScore({
      completeness: {
        score: 5,
        max: 30,
        gradable: true,
        missing: ["summary", "work experience", "education", "skills"],
      },
      bullets: [],
    });

    const items = computeScoreGuidance(score, {});
    const locations = items.map((i) => i.location);

    expect(locations).toContain("Summary");
    expect(locations).toContain("Experience");
    expect(locations).toContain("Education");
    expect(locations).toContain("Skills");
  });

  it("handles redacted role dates specifically", () => {
    const score = createMockScore({
      completeness: {
        score: 20,
        max: 30,
        gradable: true,
        missing: ["role dates"],
        redactedDates: true,
      },
      bullets: [],
    });

    const items = computeScoreGuidance(score, {
      experience: [{ title: "Dev", company: "Acme" }],
    });

    const dateItem = items.find((i) => i.id === "completeness-role-dates")!;
    expect(dateItem).toBeDefined();
    expect(dateItem.issues[0].title).toBe("Role dates use placeholders");
    expect(dateItem.issues[0].suggestion).toContain("Replace placeholder years");
    // Not the whole-résumé section, whose first control is the name (#810 review).
    expect(dateItem.targetAnchor).toBe("resume-experience-dates");
  });

  it("maps bullet issues to role location breadcrumbs and dimensions", () => {
    const score = createMockScore();
    const parsed = {
      experience: [
        {
          title: "Senior Engineer",
          company: "Acme Corp",
          description: "Shipped something great\nHelped with 5 projects across the engineering organization",
        },
      ],
      projects: [
        {
          title: "Data Engine",
          description: "Engineered high-throughput pipeline handling 100k requests daily",
        },
      ],
    };

    const items = computeScoreGuidance(score, parsed);

    // Bullet 0: lacks metric (specificity) AND is too short (structure)
    const bullet0 = items.find((i) => i.id === "bullet-0|shipped something great")!;
    expect(bullet0).toBeDefined();
    expect(bullet0.location).toBe("Experience → Senior Engineer — Acme Corp → bullet 1");
    expect(bullet0.dimensions).toContain("specificity");
    expect(bullet0.dimensions).toContain("structure");
    expect(bullet0.issues.length).toBe(2);
    expect(bullet0.issues[0].title).toBe("Missing measurable metric");
    expect(bullet0.issues[1].title).toBe("Too short (3 words)");

    // Bullet 1: weak verb (structure)
    const bullet1 = items.find((i) => i.id === "bullet-1|helped with 5 projects")!;
    expect(bullet1).toBeDefined();
    expect(bullet1.location).toBe("Experience → Senior Engineer — Acme Corp → bullet 2");
    expect(bullet1.dimensions).toEqual(["structure"]);
    expect(bullet1.issues[0].title).toBe("Weak opening verb");

    // Bullet 2 has no issues (all pass) -> not in items!
    const bullet2 = items.find((i) => i.id.includes("pipeline"));
    expect(bullet2).toBeUndefined();
  });

  it("returns an empty array when all dimensions pass", () => {
    const perfectScore = createMockScore({
      overall: 95,
      completeness: {
        score: 30,
        max: 30,
        gradable: true,
        missing: [],
      },
      bullets: [
        {
          id: "perfect",
          text: "Engineered high-throughput pipeline handling 100k requests daily",
          index: 0,
          hasMetric: true,
          startsWithActionVerb: true,
          wellFormedLength: true,
          wordCount: 8,
        },
      ],
    });

    const items = computeScoreGuidance(perfectScore, {});
    expect(items).toEqual([]);
  });

  it("follows deterministic document order", () => {
    const score = createMockScore({
      completeness: {
        score: 15,
        max: 30,
        gradable: true,
        missing: ["name", "email", "summary", "skills"],
      },
      bullets: [
        {
          id: "exp-bullet",
          text: "Worked on stuff",
          index: 0,
          hasMetric: false,
          startsWithActionVerb: false,
          wellFormedLength: false,
          wordCount: 3,
        },
      ],
    });

    const parsed = {
      experience: [{ title: "Dev", company: "Corp", description: "Worked on stuff" }],
    };

    const items = computeScoreGuidance(score, parsed);
    const locations = items.map((i) => i.location);

    // Document sequence: Contact Name -> Contact Email -> Summary -> Experience -> Skills
    expect(locations).toEqual([
      "Contact → Name",
      "Contact → Email",
      "Summary",
      "Experience → Dev — Corp → bullet 1",
      "Skills",
    ]);
  });

  describe("metric guidance stops where the score stops counting", () => {
    function bullet(i: number, hasMetric: boolean): BulletObservation {
      const text = `Built service number ${i} for the payments platform team`;
      return {
        id: `${i}|${text.toLowerCase()}`,
        text,
        index: i,
        hasMetric,
        startsWithActionVerb: true,
        wellFormedLength: true,
        wordCount: 9,
      };
    }
    function scoreWith(bullets: BulletObservation[]): AnonymousAtsScore {
      const metric = bullets.filter((b) => b.hasMetric).length;
      return createMockScore({
        specificity: {
          score: 0,
          max: 40,
          gradable: true,
          metricBullets: metric,
          totalBullets: bullets.length,
        },
        completeness: { score: 30, max: 30, gradable: true, missing: [] },
        bullets,
      });
    }
    const metricItems = (score: AnonymousAtsScore) =>
      computeScoreGuidance(score, {}).filter((i) => i.dimension === "specificity");

    it("reads the shortfall off the scorer's own formula", () => {
      expect(metricBulletsToFullSpecificity(12, 20)).toBe(0); // 60% — full
      expect(metricBulletsToFullSpecificity(11, 20)).toBe(1);
      expect(metricBulletsToFullSpecificity(1, 5)).toBe(2);
      expect(metricBulletsToFullSpecificity(0, 3)).toBe(2);
    });

    it("flags no metric once Specificity is full", () => {
      // 20 bullets, 12 with a metric: Specificity 40/40. The 8 without one
      // would change the score by exactly zero.
      const bullets = Array.from({ length: 20 }, (_, i) => bullet(i, i < 12));
      expect(metricItems(scoreWith(bullets))).toEqual([]);
    });

    it("flags only the shortfall, first in document order", () => {
      const bullets = Array.from({ length: 5 }, (_, i) => bullet(i, i === 4));
      expect(metricItems(scoreWith(bullets)).map((i) => i.bulletId)).toEqual([
        bullets[0].id,
        bullets[1].id,
      ]);
    });

    it("keeps every metric-less bullet while the dimension is ungraded", () => {
      const bullets = [bullet(0, false), bullet(1, false)];
      const score = scoreWith(bullets);
      score.specificity.gradable = false;
      expect(metricItems(score)).toHaveLength(2);
    });
  });

  describe("follows the rendered section order", () => {
    const expText = "Worked on stuff";
    const achText = "Won the regional hackathon";
    const certText = "Maintained a cloud certification";
    function obs(i: number, text: string): BulletObservation {
      return {
        id: `${i}|${text.toLowerCase()}`,
        text,
        index: i,
        hasMetric: true,
        startsWithActionVerb: false,
        wellFormedLength: false,
        wordCount: 4,
      };
    }
    const score = createMockScore({
      completeness: { score: 25, max: 30, gradable: true, missing: ["role dates"] },
      bullets: [obs(0, expText), obs(1, achText), obs(2, certText)],
    });
    const base = {
      experience: [{ title: "Dev", company: "Corp", description: expText }],
      heuristic_achievements: [{ title: "Awards", description: achText }],
      heuristic_certifications: [{ title: "Certs", description: certText }],
    };

    it("steps only through bullets the page lets the user edit", () => {
      // Achievement and certification rows render read-only, so a step there
      // could never be resolved — but they still claim their own bullets,
      // which must not leak into the Experience tail either.
      expect(computeScoreGuidance(score, base).map((i) => i.location)).toEqual([
        "Experience → Dates",
        "Experience → Dev — Corp → bullet 1",
      ]);
    });

    it("spends the metric shortfall on editable bullets only", () => {
      const noMetric = (b: BulletObservation) => ({
        ...b,
        hasMetric: false,
        startsWithActionVerb: true,
        wellFormedLength: true,
      });
      const items = computeScoreGuidance(
        createMockScore({
          specificity: {
            score: 0,
            max: 40,
            gradable: true,
            metricBullets: 0,
            totalBullets: 3,
          },
          bullets: [obs(1, achText), obs(2, certText), obs(0, expText)].map(
            noMetric,
          ),
        }),
        base,
      );
      const bulletSteps = items.filter((i) => i.targetType === "bullet");
      expect(bulletSteps.map((i) => i.location)).toEqual([
        "Experience → Dev — Corp → bullet 1",
      ]);
    });

    it("puts the role-dates step in front of the first undated role", () => {
      const second = "Shipped the second thing";
      const items = computeScoreGuidance(
        createMockScore({
          completeness: { score: 25, max: 30, gradable: true, missing: ["role dates"] },
          bullets: [obs(0, expText), obs(1, second)],
        }),
        {
          experience: [
            { title: "Dev", company: "Corp", start_date: "2020", description: expText },
            { title: "Lead", company: "Co", description: second },
          ],
        },
      );
      expect(items.map((i) => i.location)).toEqual([
        "Experience → Dev — Corp → bullet 1",
        "Experience → Dates",
        "Experience → Lead — Co → bullet 1",
      ]);
    });
  });
});
