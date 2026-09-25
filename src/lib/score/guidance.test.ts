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
import type { BulletFinding } from "../webllm/critique-resume.ts";

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

  describe("folds the on-device critique's bullet findings in (#1008)", () => {
    // The three mock bullets: 0 fails metric + length, 1 fails the verb check,
    // 2 passes everything.
    const parsed = {
      experience: [
        {
          title: "Senior Engineer",
          company: "Acme Corp",
          description:
            "Shipped something great\nHelped with 5 projects across the engineering organization\nEngineered high-throughput pipeline handling 100k requests daily",
        },
      ],
    };
    const PIPELINE = "Engineered high-throughput pipeline handling 100k requests daily";
    const bulletItem = (items: ReturnType<typeof computeScoreGuidance>, id: string) =>
      items.find((i) => i.bulletId === id);

    it("changes nothing when no critique is passed", () => {
      const score = createMockScore();
      expect(computeScoreGuidance(score, parsed, [])).toEqual(
        computeScoreGuidance(score, parsed),
      );
    });

    it("gives a bullet every heuristic check passed a step of its own, with the model's suggestion", () => {
      const findings: BulletFinding[] = [
        { bullet: PIPELINE, issue: "vague", suggestion: "Built the order pipeline" },
      ];
      const items = computeScoreGuidance(createMockScore(), parsed, findings);
      const item = bulletItem(items, `2|${PIPELINE.toLowerCase()}`)!;
      expect(item).toBeDefined();
      expect(item.targetType).toBe("bullet");
      expect(item.targetAnchor).toBe(bulletAnchorId(item.bulletId!));
      expect(item.location).toBe("Experience → Senior Engineer — Acme Corp → bullet 3");
      expect(item.dimension).toBe("specificity");
      expect(item.issues).toHaveLength(1);
      expect(item.issues[0]).toMatchObject({
        check: "critique",
        title: "Local AI: vague wording",
      });
      expect(item.issues[0].suggestion).toContain('"Built the order pipeline"');
      // In document order with the heuristic steps, not appended at the end.
      expect(items.filter((i) => i.targetType === "bullet").map((i) => i.bulletId)).toEqual([
        "0|shipped something great",
        "1|helped with 5 projects",
        `2|${PIPELINE.toLowerCase()}`,
      ]);
    });

    it("adds the finding to a bullet's existing step, after its heuristic issues", () => {
      const items = computeScoreGuidance(createMockScore(), parsed, [
        { bullet: "Shipped something great", issue: "vague" },
      ]);
      const item = bulletItem(items, "0|shipped something great")!;
      expect(item.issues.map((i) => i.check)).toEqual(["metric", "length", "critique"]);
      expect(item.summary).toContain("Local AI: vague wording");
      // No suggestion from the model: the category's own advice stands in.
      expect(item.issues[2].suggestion).toMatch(/specific/);
    });

    it("injects nothing for an `ok` finding", () => {
      const score = createMockScore();
      const findings: BulletFinding[] = [
        { bullet: PIPELINE, issue: "ok" },
        { bullet: "Shipped something great", issue: "ok" },
      ];
      expect(computeScoreGuidance(score, parsed, findings)).toEqual(
        computeScoreGuidance(score, parsed),
      );
    });

    it("drops a suggestion-less finding that only restates a check the bullet already fails", () => {
      const items = computeScoreGuidance(createMockScore(), parsed, [
        { bullet: "Helped with 5 projects across the engineering organization", issue: "weak_verb" },
      ]);
      expect(bulletItem(items, "1|helped with 5 projects")!.issues.map((i) => i.check)).toEqual([
        "verb",
      ]);
      // …but keeps it when the model offered wording to try.
      const withSuggestion = computeScoreGuidance(createMockScore(), parsed, [
        {
          bullet: "Helped with 5 projects across the engineering organization",
          issue: "weak_verb",
          suggestion: "Delivered 5 projects across engineering",
        },
      ]);
      expect(
        bulletItem(withSuggestion, "1|helped with 5 projects")!.issues.map((i) => i.check),
      ).toEqual(["verb", "critique"]);
    });

    it("does not spend the metric budget", () => {
      // Gradable, 2 of 3 bullets carry a metric: the shortfall to full
      // specificity decides how many metric asks survive. A critique finding
      // on the one metric-less bullet must not change that.
      const score = createMockScore();
      const base = computeScoreGuidance(score, parsed);
      const withCritique = computeScoreGuidance(score, parsed, [
        { bullet: "Shipped something great", issue: "no_quantification", suggestion: "Shipped X" },
      ]);
      const metricAsks = (items: typeof base) =>
        items.filter((i) => i.issues.some((x) => x.check === "metric")).length;
      expect(metricAsks(withCritique)).toBe(metricAsks(base));
    });

    it("gives a read-only project bullet no step, even with a finding for its text", () => {
      const withProject = {
        experience: [
          {
            title: "Senior Engineer",
            company: "Acme Corp",
            description:
              "Shipped something great\nHelped with 5 projects across the engineering organization",
          },
        ],
        projects: [{ title: "Data Engine", description: PIPELINE }],
      };
      const items = computeScoreGuidance(createMockScore(), withProject, [
        { bullet: PIPELINE, issue: "vague", suggestion: "anything" },
      ]);
      expect(items.find((i) => i.bulletId?.includes("pipeline"))).toBeUndefined();
    });

    it("drops a finding from Fix It once its bullet is edited (stale)", () => {
      const findings: BulletFinding[] = [{ bullet: PIPELINE, issue: "vague" }];
      const edited = "Engineered an order pipeline handling 100k requests daily";
      const score = createMockScore({
        bullets: createMockScore().bullets!.map((b) =>
          b.index === 2 ? { ...b, id: `2|${edited.toLowerCase()}`, text: edited } : b,
        ),
      });
      const editedParsed = {
        experience: [
          {
            ...parsed.experience[0]!,
            description: parsed.experience[0]!.description.replace(PIPELINE, edited),
          },
        ],
      };
      const items = computeScoreGuidance(score, editedParsed, findings);
      expect(items.some((i) => i.issues.some((x) => x.check === "critique"))).toBe(false);
    });

    it("tie-breaks duplicate text across roles: agreeing findings mark both rows", () => {
      const dup = "Led weekly 1:1s with the whole platform engineering team";
      const obs = (i: number): BulletObservation => ({
        id: `${i}|${dup.toLowerCase()}`,
        text: dup,
        index: i,
        hasMetric: true,
        startsWithActionVerb: true,
        wellFormedLength: true,
        wordCount: 9,
      });
      const score = createMockScore({ bullets: [obs(0), obs(1)] });
      const twoRoles = {
        experience: [
          { title: "Lead", company: "A", description: dup },
          { title: "Lead", company: "B", description: dup },
        ],
      };
      const vague: BulletFinding = { bullet: dup, issue: "vague" };
      const both = computeScoreGuidance(score, twoRoles, [vague, { ...vague }]);
      expect(both.filter((i) => i.targetType === "bullet")).toHaveLength(2);
      // Disagreeing verdicts pair in render order: only the second row. (Which
      // role the grouper files each copy under is its own concern, so this
      // asserts the row's identity rather than its breadcrumb.)
      const paired = computeScoreGuidance(score, twoRoles, [
        { bullet: dup, issue: "ok" },
        vague,
      ]);
      expect(
        paired.filter((i) => i.targetType === "bullet").map((i) => i.bulletId),
      ).toEqual([`1|${dup.toLowerCase()}`]);
    });
  });
});
