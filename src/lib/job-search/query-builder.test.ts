// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { describe, it, expect } from "vitest";
import { buildJobQuery, MAX_SKILLS } from "./query-builder.ts";
import type { ParsedResume, ResumeExperience } from "../score/types.ts";

function baseParsed(overrides: Partial<ParsedResume> = {}): ParsedResume {
  return {
    full_name: "Jamie Rivera",
    skills: [],
    experience: [],
    education: [],
    skills_explicit: [],
    skills_inferred: [],
    ...overrides,
  };
}

function experience(overrides: Partial<ResumeExperience> = {}): ResumeExperience {
  return {
    title: "Software Engineer",
    company: "Acme Corp",
    ...overrides,
  };
}

describe("buildJobQuery", () => {
  it("returns an empty query for a fully empty resume", () => {
    const query = buildJobQuery(baseParsed());
    expect(query).toEqual({ title: "", skills: [], seniority: undefined });
  });

  it("derives title from the most recent (first) experience entry", () => {
    const parsed = baseParsed({
      experience: [
        experience({ title: "Staff Software Engineer" }),
        experience({ title: "Software Engineer II" }),
      ],
    });
    const query = buildJobQuery(parsed);
    expect(query.title).toBe("Staff Software Engineer");
  });

  it("falls back to current_title when there is no experience", () => {
    const parsed = baseParsed({ current_title: "Product Manager" });
    const query = buildJobQuery(parsed);
    expect(query.title).toBe("Product Manager");
  });

  it("falls back to skills-only query when there is no experience and no current_title", () => {
    const parsed = baseParsed({ skills: ["Python", "SQL"] });
    const query = buildJobQuery(parsed);
    expect(query.title).toBe("");
    expect(query.skills).toEqual(["python", "sql"]);
    expect(query.seniority).toBeUndefined();
  });

  it("derives seniority from a keyword in the title", () => {
    expect(
      buildJobQuery(
        baseParsed({ experience: [experience({ title: "Senior Backend Engineer" })] }),
      ).seniority,
    ).toBe("Senior");
    expect(
      buildJobQuery(
        baseParsed({ experience: [experience({ title: "Staff Platform Engineer" })] }),
      ).seniority,
    ).toBe("Staff");
    expect(
      buildJobQuery(
        baseParsed({ experience: [experience({ title: "Junior Developer" })] }),
      ).seniority,
    ).toBe("Junior");
  });

  it("leaves seniority undefined when the title carries no seniority keyword", () => {
    const parsed = baseParsed({
      experience: [experience({ title: "Software Engineer" })],
    });
    expect(buildJobQuery(parsed).seniority).toBeUndefined();
  });

  it("canonicalizes and dedupes skills via the shared SKILLS index", () => {
    const parsed = baseParsed({ skills: ["JS", "Javascript", "React.js", "python3"] });
    const query = buildJobQuery(parsed);
    // "JS" and "Javascript" both canonicalize to the same skill id and collapse.
    expect(query.skills).toEqual(["javascript", "react", "python"]);
  });

  it("passes through an unrecognized skill verbatim (title-cased)", () => {
    const parsed = baseParsed({ skills: ["underwater basket weaving"] });
    const query = buildJobQuery(parsed);
    expect(query.skills).toEqual(["Underwater Basket Weaving"]);
  });

  it("caps skills at MAX_SKILLS", () => {
    const parsed = baseParsed({
      skills: ["python", "java", "go", "rust", "ruby", "php", "swift"],
    });
    const query = buildJobQuery(parsed);
    expect(query.skills).toHaveLength(MAX_SKILLS);
  });

  it("ignores blank/whitespace-only skill entries", () => {
    const parsed = baseParsed({ skills: ["  ", "", "python"] });
    const query = buildJobQuery(parsed);
    expect(query.skills).toEqual(["python"]);
  });
});
