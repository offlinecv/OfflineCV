// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

import { describe, expect, it } from "vitest";
import { buildAtsResumeModel } from "./ats-resume-model.ts";
import type { CascadeResult } from "../heuristics/types.ts";
import type { AnonymousAtsScore, BulletObservation } from "../score/score.ts";

function bullet(text: string, index: number): BulletObservation {
  return {
    text,
    index,
    hasMetric: true,
    startsWithActionVerb: true,
    wellFormedLength: true,
    wordCount: text.split(/\s+/).length,
  };
}

function makeResult(
  parsed: Partial<CascadeResult["parsed"]> = {},
): CascadeResult {
  return {
    parsed: {
      full_name: "Jane Candidate",
      email: "jane@example.com",
      phone: "(312) 555-0123",
      location: "Chicago, IL",
      linkedin_url: "linkedin.com/in/jane",
      summary: "Product leader with a decade of B2B SaaS experience.",
      skills: ["TypeScript", "Product Strategy", "SQL"],
      experience: [
        {
          title: "Senior PM",
          company: "Acme",
          start_date: "2020",
          end_date: "2024",
          description:
            "Led migration of legacy auth system to OAuth\nDrove 30% revenue growth across the platform",
        },
      ],
      education: [
        {
          degree: "BS Computer Science",
          institution: "State University",
          year: "2016",
          coursework: ["Algorithms", "Databases"],
        },
      ],
      projects: [],
      heuristic_achievements: [],
      ...parsed,
    },
    fieldConfidence: {
      full_name: 1,
      email: 1,
      phone: 1,
      location: 1,
      linkedin_url: 1,
      github_url: 1,
    },
    confidence: 1,
    triggers: [],
    linkAnnotations: [],
    rawText: "",
  } as unknown as CascadeResult;
}

function makeScore(bullets: BulletObservation[]): AnonymousAtsScore {
  return { bullets } as unknown as AnonymousAtsScore;
}

describe("buildAtsResumeModel", () => {
  it("builds contact, summary, and standard-order sections", () => {
    const result = makeResult();
    const score = makeScore([
      bullet("Led migration of legacy auth system to OAuth", 0),
      bullet("Drove 30% revenue growth across the platform", 1),
    ]);

    const model = buildAtsResumeModel(result, score);

    expect(model.contact.name).toBe("Jane Candidate");
    expect(model.contact.email).toBe("jane@example.com");
    expect(model.contact.phone).toBe("(312) 555-0123");
    expect(model.contact.location).toBe("Chicago, IL");
    expect(model.contact.links).toContain("linkedin.com/in/jane");
    expect(model.summary).toMatch(/Product leader/);

    const headings = model.sections.map((s) => s.heading);
    // Experience precedes Education precedes Skills.
    expect(headings).toEqual(["Experience", "Education", "Skills"]);

    const exp = model.sections[0].entries[0];
    expect(exp.headerLine).toBe("Senior PM · Acme");
    expect(exp.subLine).toBe("2020 – 2024");
    expect(exp.bullets).toEqual([
      "Led migration of legacy auth system to OAuth",
      "Drove 30% revenue growth across the platform",
    ]);

    const edu = model.sections[1].entries[0];
    expect(edu.headerLine).toBe("BS Computer Science — State University");
    expect(edu.bullets[0]).toMatch(/Coursework: Algorithms, Databases/);

    const skills = model.sections[2].entries[0];
    expect(skills.headerLine).toContain("TypeScript");
  });

  it("surfaces the major (field) joined to the degree, and a degree-less program's title alone", () => {
    const result = makeResult({
      education: [
        {
          degree: "Bachelor of Science",
          field: "Mechanical Engineering",
          institution: "Riverside College Of Engineering",
        },
        {
          // Degree-less program (#238): title lives in `field`, no credential.
          degree: "",
          field: "Applied Robotics Program",
          institution: "ACME Professional Education",
          year: "2024",
        },
      ],
    });
    const model = buildAtsResumeModel(result, makeScore([]));
    const edu = model.sections.find((s) => s.heading === "Education")!;
    expect(edu.entries[0].headerLine).toBe(
      "Bachelor of Science, Mechanical Engineering — Riverside College Of Engineering",
    );
    expect(edu.entries[1].headerLine).toBe(
      "Applied Robotics Program — ACME Professional Education",
    );
  });

  it("falls back to description split when no graded bullets are attributed", () => {
    const result = makeResult();
    const model = buildAtsResumeModel(result, makeScore([]));
    expect(model.sections[0].entries[0].bullets).toEqual([
      "Led migration of legacy auth system to OAuth",
      "Drove 30% revenue growth across the platform",
    ]);
  });

  it("applies contact overrides like ContactCard ('' clears, value replaces)", () => {
    const result = makeResult();
    const model = buildAtsResumeModel(result, makeScore([]), {
      contactOverrides: { full_name: "Janet Q. Candidate", phone: "" },
      bulletOverrides: {},
    });
    expect(model.contact.name).toBe("Janet Q. Candidate");
    expect(model.contact.phone).toBeUndefined();
  });

  it("applies bullet overrides to the rendered bullet text", () => {
    const result = makeResult();
    const score = makeScore([
      bullet("Led migration of legacy auth system to OAuth", 0),
      bullet("Drove 30% revenue growth across the platform", 1),
    ]);
    const model = buildAtsResumeModel(result, score, {
      contactOverrides: {},
      bulletOverrides: { 0: "Rewrote the auth layer, cutting login latency 40%" },
    });
    expect(model.sections[0].entries[0].bullets[0]).toBe(
      "Rewrote the auth layer, cutting login latency 40%",
    );
  });

  it("promotes Achievements above Experience when placement says so", () => {
    const result = makeResult({
      heuristic_achievements: [{ title: "Patent US123", year: "2022" }],
      achievements_placement: "above_experience",
    });
    const model = buildAtsResumeModel(result, makeScore([]));
    const headings = model.sections.map((s) => s.heading);
    expect(headings[0]).toBe("Achievements");
    expect(headings.indexOf("Achievements")).toBeLessThan(
      headings.indexOf("Experience"),
    );
  });

  it("omits empty sections", () => {
    const result = makeResult({
      experience: [],
      education: [],
      skills: [],
      summary: undefined,
    });
    const model = buildAtsResumeModel(result, makeScore([]));
    expect(model.sections).toEqual([]);
    expect(model.summary).toBeUndefined();
  });
});
