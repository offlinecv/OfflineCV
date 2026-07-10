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
  sectionHeadings?: Partial<Record<string, string>>,
): CascadeResult {
  return {
    ...(sectionHeadings
      ? { sections: { sectionHeadings: new Map(Object.entries(sectionHeadings)) } }
      : {}),
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
    // Stacked round-trip shape (#284): title leads the bold header, the
    // "Company · Location  Dates" line (carrying the parser's date anchor) sits
    // on the sub-line so the emitted role re-segments back to one entry. With no
    // location the company is bare, so the date is joined with a " · " org-signature
    // marker (#298 review) — "Company · Dates" — so the re-parse anchor is
    // recognizably the company, not the title.
    expect(exp.headerLine).toBe("Senior PM");
    expect(exp.subLine).toBe("Acme · 2020 – 2024");
    expect(exp.bullets).toEqual([
      "Led migration of legacy auth system to OAuth",
      "Drove 30% revenue growth across the platform",
    ]);

    const edu = model.sections[1].entries[0];
    // Stacked shape (#291): degree leads the header, institution moves to the
    // sub-line (mirroring experience) so it round-trips back through the parser.
    expect(edu.headerLine).toBe("BS Computer Science");
    expect(edu.subLine).toBe("State University  2016");
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
    // Stacked shape (#291): degree(+field) on the header, institution on the
    // sub-line (with the date anchor appended after a whitespace gap).
    expect(edu.entries[0].headerLine).toBe(
      "Bachelor of Science, Mechanical Engineering",
    );
    expect(edu.entries[0].subLine).toBe("Riverside College Of Engineering");
    // Degree-less program (#302): the header carries NO degree cue, so the
    // graduation date stays INLINE on the header (making it an
    // `isInlineDatedProgram` entry lead the re-parser segments on) and the
    // institution drops alone to the sub-line — otherwise two degree-less entries
    // collapse to one on round-trip.
    expect(edu.entries[1].headerLine).toBe("Applied Robotics Program  2024");
    expect(edu.entries[1].subLine).toBe("ACME Professional Education");
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

  it("uses the verbatim source heading when present, falling back to canonical otherwise (#285)", () => {
    const result = makeResult({}, { experience: "Work History" });
    const model = buildAtsResumeModel(result, makeScore([]));

    const experienceSection = model.sections.find(
      (s) => s.heading === "Work History",
    );
    expect(experienceSection).toBeDefined();
    // Education had no rawHeading recorded — falls back to the canonical word.
    expect(model.sections.some((s) => s.heading === "Education")).toBe(true);
    // Summary heading falls back too when no rawHeading was recorded for it.
    expect(model.summaryHeading).toBeUndefined();
  });

  it("uses the verbatim source heading for Summary when present", () => {
    const result = makeResult({}, { summary: "Profile" });
    const model = buildAtsResumeModel(result, makeScore([]));
    expect(model.summaryHeading).toBe("Profile");
  });

  // ── #425 ───────────────────────────────────────────────────────────────────

  it("puts the role team/division on the org sub-line as the third middot segment (#425)", () => {
    const result = makeResult({
      experience: [
        {
          title: "Senior PM",
          company: "Google",
          location: "Mountain View, CA",
          team: "Enterprise Platforms",
          start_date: "2021",
          end_date: "2024",
          description: "Owned the platform roadmap",
        },
      ],
    });
    const model = buildAtsResumeModel(result, makeScore([]));
    const exp = model.sections.find((s) => s.heading === "Experience")!;
    // Company · Location · Team on the sub-line; the range date is carried
    // separately in `subLineDate` and drawn flush-right (#425), not glued.
    expect(exp.entries[0].subLine).toBe(
      "Google · Mountain View, CA · Enterprise Platforms",
    );
    expect(exp.entries[0].subLineDate).toBe("2021 – 2024");
  });

  it("omits the team segment cleanly when a role has no team (#425)", () => {
    const result = makeResult({
      experience: [
        {
          title: "Senior PM",
          company: "Google",
          location: "Mountain View, CA",
          start_date: "2021",
          end_date: "2024",
          description: "Owned the platform roadmap",
        },
      ],
    });
    const model = buildAtsResumeModel(result, makeScore([]));
    const exp = model.sections.find((s) => s.heading === "Experience")!;
    // Org on the sub-line; the range date is drawn flush-right via `subLineDate`.
    expect(exp.entries[0].subLine).toBe("Google · Mountain View, CA");
    expect(exp.entries[0].subLineDate).toBe("2021 – 2024");
  });

  it("keeps the #298 org signature glued (no flush-right) for a location-less titled role (#425)", () => {
    // A neutral, location-less company with a title needs the " · " org signature
    // on the anchor line so the re-parser reads it as the company, not the title.
    // A flush-right date draws no middot between them, so this case stays GLUED:
    // the date is on `subLine` after " · ", and `subLineDate` is unset.
    const result = makeResult({
      experience: [
        {
          title: "Chair",
          company: "Leadership Experience",
          start_date: "2021",
          end_date: "2024",
          description: "Ran the committee",
        },
      ],
    });
    const model = buildAtsResumeModel(result, makeScore([]));
    const exp = model.sections.find((s) => s.heading === "Experience")!;
    expect(exp.entries[0].subLine).toBe("Leadership Experience · 2021 – 2024");
    expect(exp.entries[0].subLineDate).toBeUndefined();
  });

  it("keeps a single-token (non-range) date glued rather than flush-right (#425)", () => {
    // Only a lone year is known — not a range — so it is NOT drawn flush-right
    // (the flush() exemption only protects ranges); it stays glued on `subLine`.
    const result = makeResult({
      experience: [
        {
          title: "Analyst",
          company: "Globex",
          location: "Austin, TX",
          start_date: "2022",
          description: "Did analysis",
        },
      ],
    });
    const model = buildAtsResumeModel(result, makeScore([]));
    const exp = model.sections.find((s) => s.heading === "Experience")!;
    expect(exp.entries[0].subLine).toBe("Globex · Austin, TX  2022");
    expect(exp.entries[0].subLineDate).toBeUndefined();
  });

  it("fully display-formats contact links (scheme + www stripped) so the www round-trip holds (#425)", () => {
    const result = makeResult({
      linkedin_url: "https://www.linkedin.com/in/janesmith",
      github_url: "https://github.com/janesmith",
      portfolio_url: "https://jane.dev/",
    });
    const model = buildAtsResumeModel(result, makeScore([]));
    // Scheme, a leading `www.`, and any trailing slash are all dropped. Full
    // www-stripping round-trips because the parser's `normalizeUrl` canonicalizes
    // `www.` away on both the original parse and the re-parse of this display.
    expect(model.contact.links).toContain("linkedin.com/in/janesmith");
    expect(model.contact.links).toContain("github.com/janesmith");
    expect(model.contact.links).toContain("jane.dev");
    for (const link of model.contact.links)
      expect(link).not.toMatch(/^https?:\/\//i);
  });

  it("marks the skills entry as regular-weight (headerBold=false); other entries stay bold (#425)", () => {
    const result = makeResult();
    const model = buildAtsResumeModel(result, makeScore([]));
    const skills = model.sections.find((s) => s.heading === "Skills")!;
    expect(skills.entries[0].headerBold).toBe(false);
    // Experience headers do not opt out — they render bold (headerBold undefined,
    // which the renderer defaults to true).
    const exp = model.sections.find((s) => s.heading === "Experience")!;
    expect(exp.entries[0].headerBold).toBeUndefined();
  });
});
