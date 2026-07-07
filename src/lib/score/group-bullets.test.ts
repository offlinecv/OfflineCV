// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

import { promises as fsp } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  groupBulletsByExperience,
  suppressTitleOwnedBullets,
  formatExperienceHeader,
  normalizeBulletText,
  type BulletExperience,
} from "./group-bullets.ts";
import type { BulletObservation } from "./score.ts";
import { runCascade } from "../heuristics/cascade.ts";
import { computeAnonymousAtsScore } from "./score.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = join(HERE, "../../..", "tests/fixtures/pdfs");

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeBullet(
  text: string,
  index: number,
  overrides: Partial<BulletObservation> = {},
): BulletObservation {
  return {
    text,
    index,
    hasMetric: false,
    startsWithActionVerb: true,
    wellFormedLength: true,
    wordCount: text.split(/\s+/).length,
    ...overrides,
  };
}

function makeExp(
  title: string,
  company: string,
  description: string,
  overrides: Partial<BulletExperience> = {},
): BulletExperience {
  return { title, company, description, ...overrides };
}

// ── normalizeBulletText ───────────────────────────────────────────────────────

describe("normalizeBulletText", () => {
  it("lowercases and trims", () => {
    expect(normalizeBulletText("  Led the team  ")).toBe("led the team");
  });

  it("strips leading bullet glyphs", () => {
    expect(normalizeBulletText("• Built a pipeline")).toBe("built a pipeline");
    expect(normalizeBulletText("- Built a pipeline")).toBe("built a pipeline");
    expect(normalizeBulletText("* Built a pipeline")).toBe("built a pipeline");
  });

  it("strips numbered list prefixes", () => {
    expect(normalizeBulletText("1. Led the project")).toBe("led the project");
    expect(normalizeBulletText("2) Managed the team")).toBe("managed the team");
  });

  it("collapses internal whitespace", () => {
    expect(normalizeBulletText("Led  the   team")).toBe("led the team");
  });
});

// ── groupBulletsByExperience ──────────────────────────────────────────────────

describe("groupBulletsByExperience", () => {
  it("exact match — bullet text identical to a description line → grouped under that experience", () => {
    const exp = makeExp("Engineer", "Acme", "Led a team\nBuilt a pipeline");
    const bullets = [makeBullet("Led a team", 0), makeBullet("Built a pipeline", 1)];
    const groups = groupBulletsByExperience(bullets, [exp]);

    expect(groups).toHaveLength(1);
    expect(groups[0].experienceIndex).toBe(0);
    expect(groups[0].experience).toBe(exp);
    expect(groups[0].bullets).toEqual(bullets);
  });

  it("whitespace/marker drift — bullet with leading marker vs plain description line still matches", () => {
    // Description line has no marker; bullet text has a bullet marker
    const exp = makeExp("PM", "Corp", "Improved retention by 20%");
    const bullet = makeBullet("• Improved  retention  by  20%", 0);
    const groups = groupBulletsByExperience([bullet], [exp]);

    expect(groups).toHaveLength(1);
    expect(groups[0].experienceIndex).toBe(0);
    expect(groups[0].bullets[0]).toBe(bullet);
  });

  it("no-experience — empty experiences array → all bullets in a single Other group", () => {
    const bullets = [makeBullet("Led a team", 0), makeBullet("Shipped a feature", 1)];
    const groups = groupBulletsByExperience(bullets, []);

    expect(groups).toHaveLength(1);
    expect(groups[0].experienceIndex).toBeNull();
    expect(groups[0].experience).toBeNull();
    expect(groups[0].bullets).toEqual(bullets);
  });

  it("all-unmatched — experiences present but no bullet matches → only Other group returned", () => {
    const exp = makeExp("Engineer", "Acme", "Deployed microservices");
    const bullets = [makeBullet("Something completely different", 0)];
    const groups = groupBulletsByExperience(bullets, [exp]);

    expect(groups).toHaveLength(1);
    expect(groups[0].experienceIndex).toBeNull();
    expect(groups[0].bullets).toEqual(bullets);
  });

  it("duplicate text across two roles — bullet maps to first experience (first-match tiebreak)", () => {
    const exp0 = makeExp("Role A", "CompA", "Led the migration");
    const exp1 = makeExp("Role B", "CompB", "Led the migration");
    const bullet = makeBullet("Led the migration", 0);
    const groups = groupBulletsByExperience([bullet], [exp0, exp1]);

    // Only experience[0] group should appear
    expect(groups).toHaveLength(1);
    expect(groups[0].experienceIndex).toBe(0);
    expect(groups[0].experience).toBe(exp0);
  });

  it("preserves bullet order within each group", () => {
    const exp = makeExp("Engineer", "Acme", "Alpha task\nBeta task\nGamma task");
    const bullets = [
      makeBullet("Gamma task", 2),
      makeBullet("Alpha task", 0),
      makeBullet("Beta task", 1),
    ];
    const groups = groupBulletsByExperience(bullets, [exp]);

    expect(groups[0].bullets.map((b) => b.index)).toEqual([2, 0, 1]);
  });

  it("returns experience groups in experience order with Other group last", () => {
    const exp0 = makeExp("Role A", "CompA", "Task A");
    const exp1 = makeExp("Role B", "CompB", "Task B");
    const bullets = [
      makeBullet("Task B", 1),
      makeBullet("Task A", 0),
      makeBullet("Unmatched task", 2),
    ];
    const groups = groupBulletsByExperience(bullets, [exp0, exp1]);

    expect(groups).toHaveLength(3);
    expect(groups[0].experienceIndex).toBe(0);
    expect(groups[1].experienceIndex).toBe(1);
    expect(groups[2].experienceIndex).toBeNull();
  });

  it("no Other group when all bullets match", () => {
    const exp = makeExp("Engineer", "Acme", "Task A\nTask B");
    const bullets = [makeBullet("Task A", 0), makeBullet("Task B", 1)];
    const groups = groupBulletsByExperience(bullets, [exp]);

    expect(groups.every((g) => g.experienceIndex !== null)).toBe(true);
  });

  it("experience with no description is skipped in grouping — bullets fall to Other", () => {
    const exp: BulletExperience = { title: "Engineer", company: "Acme" };
    const bullet = makeBullet("Some task", 0);
    const groups = groupBulletsByExperience([bullet], [exp]);

    expect(groups).toHaveLength(1);
    expect(groups[0].experienceIndex).toBeNull();
  });
});

// ── formatExperienceHeader ────────────────────────────────────────────────────

describe("formatExperienceHeader", () => {
  it("full — title, company, and dates", () => {
    expect(
      formatExperienceHeader({
        title: "Senior PM",
        company: "Google",
        start_date: "2019",
        end_date: "2023",
      }),
    ).toBe("Senior PM — Google · 2019–2023");
  });

  it("is_current — renders end as 'Present'", () => {
    expect(
      formatExperienceHeader({
        title: "Engineer",
        company: "Stripe",
        start_date: "2021",
        is_current: true,
      }),
    ).toBe("Engineer — Stripe · 2021–Present");
  });

  it("no dates — omits the date segment", () => {
    expect(
      formatExperienceHeader({ title: "Senior PM", company: "Google" }),
    ).toBe("Senior PM — Google");
  });

  it("title only — no company or dates", () => {
    expect(formatExperienceHeader({ title: "Senior PM" })).toBe("Senior PM");
  });

  it("company only — no title or dates", () => {
    expect(formatExperienceHeader({ company: "Google" })).toBe("Google");
  });

  it("start_date only — renders just the start", () => {
    expect(
      formatExperienceHeader({
        title: "Engineer",
        company: "Acme",
        start_date: "2020",
      }),
    ).toBe("Engineer — Acme · 2020");
  });

  it("empty experience — returns empty string", () => {
    expect(formatExperienceHeader({})).toBe("");
  });
});

// ── Wrapped-bullet pool + attribution (#162) ──────────────────────────────────

describe("multi-line bullet pool is fully merged and correctly attributed (#162)", () => {
  // A long bullet that wraps onto a marker-less second line used to be TRUNCATED
  // in the per-bullet pool (`extractBulletsFromLines` drops the glyph-less
  // continuation) and the truncated text then no longer matched the merged
  // `projects[]/experience[].description`, so the bullet fell into "Other".
  // Merging wrapped continuations upstream (`mergeWrappedContinuations` in
  // `toSectionedResume`) makes the pool carry each bullet's full text, so it
  // matches its role by construction.
  // Fixture-read + runCascade round-trip is slow under a coverage-instrumented
  // full-suite `verify` run; scope a higher timeout to just this test rather
  // than bumping vitest's global default (#360).
  it("recovers full wrapped-bullet text and attributes it to its role, not Other", async () => {
    const bytes = await fsp.readFile(
      join(
        FIXTURE_ROOT,
        "google-docs/google-docs-skia-proxy-multiline-bullets-coursework.pdf",
      ),
    );
    const cascade = await runCascade(new Uint8Array(bytes));
    const score = computeAnonymousAtsScore({
      parsed: cascade.parsed,
      fieldConfidence: cascade.fieldConfidence,
      triggers: cascade.triggers,
      rawText: cascade.rawText,
      sections: cascade.sections,
    });
    const pool = score.bullets ?? [];

    // (1) The pool carries each previously-truncated bullet's FULL merged text —
    //     the wrap tail (after the marker-less second line) is present, not cut.
    const poolText = pool.map((b) => b.text);
    const fullText = [
      "Collected company revenue from past four years using data from 10-K and 10-Q filings across several reporting periods",
      "Used five different forecasting methods including MA3, Weighted MA, Exponential Smoothing, Linear Trend, and TAF on deseasonalized and reseasonalized revenue data",
      "Identified the most suitable method through a comparison of average forecasting error among all methods evaluated",
      "Conducted tours for museum guests from a variety of backgrounds, explaining exhibits and informing them of available resources",
    ];
    for (const t of fullText) {
      expect(poolText).toContain(t);
    }

    // (2) The merged project bullets attribute to their project entry — NOT the
    //     null "Other" group — through the same combined experience+projects
    //     array the reconstructed-resume UI feeds `groupBulletsByExperience`.
    const toBE = (
      entries: ReadonlyArray<{
        title?: string;
        name?: string;
        description?: string;
        start_date?: string;
        end_date?: string;
        is_current?: boolean;
      }>,
    ): BulletExperience[] =>
      entries.map((e) => ({
        title: e.title ?? e.name,
        description: e.description,
        start_date: e.start_date,
        end_date: e.end_date,
        is_current: e.is_current,
      }));
    const combined = [
      ...toBE(cascade.parsed.experience ?? []),
      ...toBE(cascade.parsed.projects ?? []),
    ];
    const groups = groupBulletsByExperience(pool, combined);

    const other = groups.find((g) => g.experienceIndex === null);
    const otherText = new Set((other?.bullets ?? []).map((b) => b.text));
    // The Revenue-Forecasting project's three (now-merged) bullets land on a
    // real project entry, not Other — the symptom the issue cited for [13]/[14].
    for (const t of fullText.slice(0, 3)) {
      expect(otherText.has(t)).toBe(false);
    }
  }, 20000);
});

// ── suppressTitleOwnedBullets (#224) ────────────────────────────────────────────

describe("suppressTitleOwnedBullets (#224)", () => {
  const titleOnly = (title: string): BulletExperience => ({ title });

  it("drops a bullet owned by a title-only entry — '[year]' bracket shape", () => {
    // Achievement title is date-stripped to a "[]" residue; the pooled bullet
    // keeps "[2019]". The residue-tolerant key reconciles them.
    const entries = [titleOnly("Patent · Ranking e-commerce catalogs. []")];
    const bullets = [
      makeBullet("Patent · Ranking e-commerce catalogs. [2019]", 0),
    ];
    expect(suppressTitleOwnedBullets(bullets, entries)).toEqual([]);
  });

  it("drops a bullet owned by a title-only entry — 'Label, year' shape", () => {
    const entries = [titleOnly("Globex Engineering Excellence")];
    const bullets = [makeBullet("Globex Engineering Excellence, 2021", 0)];
    expect(suppressTitleOwnedBullets(bullets, entries)).toEqual([]);
  });

  it("keeps a genuinely-unmatched bullet that only shares a prefix", () => {
    const entries = [titleOnly("Globex Engineering Excellence")];
    const bullets = [
      makeBullet("Globex Engineering Excellence Award committee chair", 0),
    ];
    expect(suppressTitleOwnedBullets(bullets, entries)).toHaveLength(1);
  });

  it("never suppresses against an entry that has a real description", () => {
    // An entry WITH a bullet body attributes through the description path; its
    // header text must not become an ownership key that strands a similar bullet.
    const entries: BulletExperience[] = [
      { title: "Built a thing, 2021", description: "Did real work here." },
    ];
    const bullets = [makeBullet("Built a thing, 2021", 0)];
    expect(suppressTitleOwnedBullets(bullets, entries)).toHaveLength(1);
  });

  it("returns the list unchanged when there are no title-only entries", () => {
    const bullets = [makeBullet("Shipped feature X across the org", 0)];
    expect(suppressTitleOwnedBullets(bullets, [])).toEqual(bullets);
  });
});
