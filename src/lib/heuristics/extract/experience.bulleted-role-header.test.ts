// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Regression tests for #662: a date range is the role heading and the first
 * bullet below it carries `Title, Company` before the accomplishment bullets.
 *
 * Recovery must stay narrower than "promote the first bullet". A date-only
 * block containing ordinary achievement prose is the #145 phantom shape and
 * must still be dropped, even when that prose happens to mention a title word.
 */

import { describe, expect, it } from "vitest";
import { toCanonicalResume } from "../canonical.ts";
import { mkItems } from "../__test-utils__/mkItem.ts";
import { extractExperience } from "../extract-fields.ts";
import {
  findSection,
  groupIntoLines,
  splitIntoSections,
  toSectionedResume,
} from "../sections.ts";
import type { CascadeResult, HeuristicParsedResume } from "../types.ts";
import { buildAtsResumeModel } from "../../pdf/ats-resume-model.ts";
import { computeAnonymousAtsScore } from "../../score/score.ts";

function parseExperienceSection(
  specs: Array<{ text: string; fontSize?: number }>,
) {
  const sections = splitIntoSections(groupIntoLines(mkItems(specs)));
  const experience = findSection(sections, "experience");
  expect(experience).toBeDefined();
  return {
    roles: extractExperience(experience).value,
    sections: toSectionedResume(sections, "regex"),
  };
}

function rolesFromSection(specs: Array<{ text: string; fontSize?: number }>) {
  return parseExperienceSection(specs).roles;
}

describe("date-heading roles with a bulleted header (#662)", () => {
  it("recovers two roles without grading or exporting the promoted header bullets", () => {
    const specs = [
      { text: "Experience", fontSize: 13 },
      { text: "Mar 2021 - Present" },
      { text: "• Staff Engineer, Globex Systems LLC" },
      { text: "• Led the payments platform migration across 14 services" },
      { text: "• Cut median deploy time from 42 minutes to 9 minutes" },
      { text: "Jun 2017 - Feb 2021" },
      { text: "• Senior Engineer, Initech Analytics" },
      { text: "• Rebuilt the ingest pipeline handling 3M events per day" },
      { text: "• Mentored four engineers through the on-call rotation" },
    ];
    const { roles, sections } = parseExperienceSection(specs);

    expect(roles).toHaveLength(2);
    expect(roles[0]).toMatchObject({
      title: "Staff Engineer",
      company: "Globex Systems LLC",
      start_date: "Mar 2021",
      is_current: true,
    });
    expect(roles[0].end_date).toBeUndefined();
    expect(roles[0].description?.split("\n")).toEqual([
      "Led the payments platform migration across 14 services",
      "Cut median deploy time from 42 minutes to 9 minutes",
    ]);

    expect(roles[1]).toMatchObject({
      title: "Senior Engineer",
      company: "Initech Analytics",
      start_date: "Jun 2017",
      end_date: "Feb 2021",
    });
    expect(roles[1].description?.split("\n")).toEqual([
      "Rebuilt the ingest pipeline handling 3M events per day",
      "Mentored four engineers through the on-call rotation",
    ]);

    const parsed = {
      skills: [],
      experience: roles,
      education: [],
    } satisfies HeuristicParsedResume;
    const score = computeAnonymousAtsScore({
      parsed,
      fieldConfidence: {},
      triggers: [],
      rawText: specs.map((spec) => spec.text).join("\n"),
      sections,
    });
    const achievementBullets = [
      "Led the payments platform migration across 14 services",
      "Cut median deploy time from 42 minutes to 9 minutes",
      "Rebuilt the ingest pipeline handling 3M events per day",
      "Mentored four engineers through the on-call rotation",
    ];
    expect(score.bullets?.map((bullet) => bullet.text)).toEqual(
      achievementBullets,
    );

    const cascade: CascadeResult = {
      canonical: toCanonicalResume(parsed, sections, {}),
      confidence: 1,
      triggers: [],
      suggestedEscalation: "none",
      tiers: ["t1_openresume"],
      rawText: specs.map((spec) => spec.text).join("\n"),
      linkAnnotations: [],
      diagnostics: {
        rawCharCount: 0,
        extractedCharCount: 0,
        pages: 1,
        elapsedMs: 0,
        sectionSource: "regex",
      },
      timings: { t0_layout_ms: 0, t1_openresume_ms: 0 },
    };
    const model = buildAtsResumeModel(cascade, score);
    const exported = model.sections.find(
      (section) => section.kind === "experience",
    );
    expect(exported?.entries.flatMap((entry) => entry.bullets)).toEqual(
      achievementBullets,
    );
  });

  // The suppression keys are matched against the WHOLE pooled bullet set, so
  // scoping it to promoted entries is what keeps it from reaching across
  // sections. Here nothing is promoted: an ordinary header line parses normally
  // and an authored Achievements line restates it. Before the
  // `header_from_bullet` gate that line was filtered out of `score.bullets` —
  // losing both its editable row and, via `resolveBullets`, its exported slot,
  // because the entry beside it still had a graded bullet so the raw
  // `description` fallback never fired.
  it("keeps an authored line that restates a NORMALLY-parsed header (#662 review)", () => {
    const specs = [
      { text: "Experience", fontSize: 13 },
      { text: "Staff Engineer, Globex Systems LLC" },
      { text: "Mar 2021 - Present" },
      { text: "• Led the payments platform migration across 14 services" },
      { text: "Achievements", fontSize: 13 },
      { text: "• Staff Engineer, Globex Systems LLC" },
      { text: "• Cut median deploy time from 42 minutes to 9 minutes" },
    ];
    const allSections = splitIntoSections(groupIntoLines(mkItems(specs)));
    const roles = extractExperience(findSection(allSections, "experience")).value;
    const sections = toSectionedResume(allSections, "regex");

    // Parsed from a header line, so the promotion path never ran.
    expect(roles).toHaveLength(1);
    expect(roles[0]).toMatchObject({
      title: "Staff Engineer",
      company: "Globex Systems LLC",
    });
    expect(roles[0].header_from_bullet).toBeUndefined();

    const score = computeAnonymousAtsScore({
      parsed: {
        skills: [],
        experience: roles,
        education: [],
      } satisfies HeuristicParsedResume,
      fieldConfidence: {},
      triggers: [],
      rawText: specs.map((spec) => spec.text).join("\n"),
      sections,
    });
    expect(score.bullets?.map((bullet) => bullet.text)).toContain(
      "Staff Engineer, Globex Systems LLC",
    );
  });

  it("does not revive a date-only phantom from achievement prose", () => {
    const roles = rolesFromSection([
      { text: "Experience", fontSize: 13 },
      { text: "Mar 2021 - Present" },
      { text: "• Led Engineering Team, North America" },
      { text: "• Cut median deploy time from 42 minutes to 9 minutes" },
    ]);

    expect(roles).toEqual([]);
  });

  it("does not treat a lowercase prose tail as a company suffix", () => {
    const roles = rolesFromSection([
      { text: "Experience", fontSize: 13 },
      { text: "Mar 2021 - Present" },
      { text: "• Engineering Roadmap, improving Distributed Systems" },
      { text: "• Cut median deploy time from 42 minutes to 9 minutes" },
    ]);

    expect(roles).toEqual([]);
  });

  // "Owned Developer Platform" is rejected by the role-noun grammar alone
  // ("Platform" is not a role noun), so it cannot prove the verb gate. Each of
  // the others ends in a genuine role noun and carries header casing, so the
  // ONLY thing standing between them and a fabricated role — plus the silent
  // loss of the staffing/mentoring bullet they were built from — is
  // `startsWithActionVerb`.
  for (const prose of [
    "Owned Developer Platform, Cloud Infrastructure",
    "Hired Staff Engineer, Cloud Infrastructure",
    "Managed Senior Engineer, Payments Platform LLC",
    "Mentored Junior Developer, Core Services Inc",
  ]) {
    it(`does not promote title-keyword accomplishment prose: "${prose}" (#145)`, () => {
      const roles = rolesFromSection([
        { text: "Experience", fontSize: 13 },
        { text: "Mar 2021 - Present" },
        { text: `• ${prose}` },
        { text: "• Cut median deploy time from 42 minutes to 9 minutes" },
      ]);

      expect(roles).toEqual([]);
    });
  }

  it("accepts Latin Extended casing in a genuine role header", () => {
    const roles = rolesFromSection([
      { text: "Experience", fontSize: 13 },
      { text: "Mar 2021 - Present" },
      { text: "• Élite Staff Engineer, Société Générale LLC" },
      { text: "• Cut median deploy time from 42 minutes to 9 minutes" },
    ]);

    expect(roles).toMatchObject([
      {
        title: "Élite Staff Engineer",
        company: "Société Générale LLC",
        description: "Cut median deploy time from 42 minutes to 9 minutes",
      },
    ]);
  });

  it("does not revive a date-only phantom without both role fields", () => {
    const roles = rolesFromSection([
      { text: "Experience", fontSize: 13 },
      { text: "Mar 2021 - Present" },
      { text: "• Staff Engineer" },
      { text: "• Cut median deploy time from 42 minutes to 9 minutes" },
    ]);

    expect(roles).toEqual([]);
  });
});
