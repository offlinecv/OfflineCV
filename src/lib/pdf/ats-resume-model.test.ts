// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { describe, expect, it } from "vitest";
import { bulletId } from "../score/bullet-id.ts";
import { buildAtsResumeModel } from "./ats-resume-model.ts";
import { EMPHASIS_OPEN, EMPHASIS_CLOSE } from "./auto-bold-metrics.ts";
import type {
  CascadeResult,
  HeuristicParsedResume,
} from "../heuristics/types.ts";
import { ACCOMPLISHMENT_SECTION_NAMES } from "../heuristics/sections.ts";
import type { AnonymousAtsScore, BulletObservation } from "../score/score.ts";
import { countWords } from "../score/score.ts";

function bullet(text: string, index: number): BulletObservation {
  return {
    text,
    id: bulletId(text, 0),
    index,
    hasMetric: true,
    startsWithActionVerb: true,
    wellFormedLength: true,
    wordCount: countWords(text),
  };
}

function makeResult(
  parsed: Partial<HeuristicParsedResume> = {},
  sectionHeadings?: Partial<Record<string, string>>,
): CascadeResult {
  return {
    canonical: {
    sections: {
      byName: new Map(),
      accomplishmentSections: ACCOMPLISHMENT_SECTION_NAMES,
      source: "regex",
      ...(sectionHeadings
        ? { sectionHeadings: new Map(Object.entries(sectionHeadings)) }
        : {}),
    },
    fields: {
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
    // One-line header (#436): "Title · Company, Location" on a single header
    // line, the range date drawn flush-right via `headerLineDate` (no sub-line).
    // With no location the company is bare, so the header is "Senior PM · Acme".
    expect(exp.headerLine).toBe("Senior PM · Acme");
    expect(exp.headerLineDate).toBe("2020 – 2024");
    expect(exp.subLine).toBeUndefined();
    expect(exp.bullets).toEqual([
      "Led migration of legacy auth system to OAuth",
      "Drove 30% revenue growth across the platform",
    ]);

    const edu = model.sections[1].entries[0];
    // Institution-led shape (#882): the institution leads the bold header with
    // the graduation date flush-right on that line, and degree + field + notes
    // drop to the sub-line. Before #882 the stacked shape ran the other way
    // (#291) — the flip is safe only because the segmenter gained an
    // institution-lead cue; see `education-hintless-institution-lead.pdf`.
    expect(edu.headerLine).toBe("State University");
    expect(edu.headerLineDate).toBe("2016");
    expect(edu.subLine).toBe("BS Computer Science");
    expect(edu.subLineDate).toBeUndefined();
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
    // DEGREE-led, not institution-led (#882): this entry carries no date at all,
    // and `orgCanLead` requires the date column, because the institution-lead
    // segmenter cue recognises the leading line by its inline date. So the entry
    // keeps the pre-#882 shape that anchors the boundary on `DEGREE_RE`, with the
    // institution alone on the sub-line and no date drawn anywhere.
    expect(edu.entries[0].headerLine).toBe(
      "Bachelor of Science, Mechanical Engineering",
    );
    expect(edu.entries[0].headerLineDate).toBeUndefined();
    expect(edu.entries[0].subLine).toBe("Riverside College Of Engineering");
    expect(edu.entries[0].subLineDate).toBeUndefined();
    // Degree-less program (#302): the header carries NO degree cue, so the
    // graduation date stays on the HEADER line (making it an
    // `isInlineDatedProgram` entry lead the re-parser segments on) and the
    // institution drops alone to the sub-line — otherwise two degree-less entries
    // collapse to one on round-trip. #882 leaves this shape deliberately
    // untouched while flipping the degreed one: the institution-lead cue it
    // introduces requires a DEGREE on the following line, which this shape has
    // not got, so the program title keeps both the header and the date.
    expect(edu.entries[1].headerLine).toBe("Applied Robotics Program");
    expect(edu.entries[1].headerLineDate).toBe("2024");
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

  // #648 Phase 3: the builder takes NO override maps. It renders the
  // already-folded canonical résumé + its re-graded score, so these two pin the
  // contract "what applyOverrides produced is what the PDF draws" rather than a
  // second copy of the override semantics living here.
  it("renders the contact edits already folded into the canonical fields", () => {
    const result = makeResult({ full_name: "Janet Q. Candidate" });
    // An edit CLEARS phone: applyOverrides zeroes its confidence, and that
    // gating — not an override map — is what drops it from the export.
    result.canonical.fieldConfidence.phone = 0;
    const model = buildAtsResumeModel(result, makeScore([]));
    expect(model.contact.name).toBe("Janet Q. Candidate");
    expect(model.contact.phone).toBeUndefined();
  });

  it("renders the bullet text carried by the (re-graded) pool", () => {
    // The pool and the entry description are BOTH post-edit, which is what
    // `applyOverrides` guarantees — `groupBulletsByExperience` attributes a
    // pooled bullet to its entry by matching normalised text, so a pool that
    // disagreed with the description would strand the bullet (that desync,
    // manufactured by a test harness, was #487).
    const result = makeResult({
      experience: [
        {
          title: "Senior PM",
          company: "Acme",
          start_date: "2020",
          end_date: "2024",
          description:
            "Rewrote the auth layer, cutting login latency 40%\nDrove 30% revenue growth across the platform",
        },
      ],
    });
    const score = makeScore([
      bullet("Rewrote the auth layer, cutting login latency 40%", 0),
      bullet("Drove 30% revenue growth across the platform", 1),
    ]);
    const model = buildAtsResumeModel(result, score);
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

  it("exports an achievement's year behind the source's own separator (#380)", () => {
    // Ground truth on the fixture is "Globex Engineering Excellence, 2021". The
    // exporter re-composes the header from the stored parts, so without the
    // parsed `year_separator` it re-punctuated the résumé's comma into a middot
    // — and the on-screen header and the PDF have to agree, so both read it.
    const result = makeResult({
      heuristic_achievements: [
        {
          title: "Globex Engineering Excellence",
          year: "2021",
          year_separator: ",",
        },
      ],
    });
    const model = buildAtsResumeModel(result, makeScore([]));
    const ach = model.sections.find((s) => s.kind === "achievements");
    expect(ach!.entries[0].headerLine).toBe(
      "Globex Engineering Excellence, 2021",
    );
  });

  it("falls back to the middot when the source set the year off with a space", () => {
    const result = makeResult({
      heuristic_achievements: [{ title: "Best Paper Award", year: "2021" }],
    });
    const model = buildAtsResumeModel(result, makeScore([]));
    const ach = model.sections.find((s) => s.kind === "achievements");
    expect(ach!.entries[0].headerLine).toBe("Best Paper Award · 2021");
  });

  it("bolds only the leading type label of a 'Type · description' achievement", () => {
    const result = makeResult({
      heuristic_achievements: [
        {
          type: "Patent",
          title: "Issued US10275736B1; bulk catalog editor",
          year: "2019",
        },
      ],
    });
    const model = buildAtsResumeModel(result, makeScore([]));
    const ach = model.sections.find((s) => s.kind === "achievements");
    const entry = ach!.entries[0];
    // The `type` field ("Patent") is wrapped in the PUA emphasis sentinels; the
    // rest of the header — title and year — stays outside them (regular weight).
    expect(entry.headerLine).toBe(
      `${EMPHASIS_OPEN}Patent${EMPHASIS_CLOSE} · ` +
        "Issued US10275736B1; bulk catalog editor · 2019",
    );
    // Base line drawn regular; the sentinels carry the per-run bold.
    expect(entry.headerBold).toBe(false);
  });

  it("keeps a type-less achievement header fully bold (no emphasis sentinels)", () => {
    const result = makeResult({
      heuristic_achievements: [{ title: "Best Paper Award", year: "2021" }],
    });
    const model = buildAtsResumeModel(result, makeScore([]));
    const entry = model.sections.find((s) => s.kind === "achievements")!
      .entries[0];
    expect(entry.headerLine).toBe("Best Paper Award · 2021");
    expect(entry.headerLine).not.toContain(EMPHASIS_OPEN);
    expect(entry.headerBold).toBe(true);
  });

  it("does not treat a long prose first segment as a type label", () => {
    // A " · " inside a full sentence must not bold the whole clause — the
    // leading segment exceeds the type-label length guard.
    const longFirst =
      "Recognized across the org for sustained impact over many years · runner-up";
    const result = makeResult({
      heuristic_achievements: [{ title: longFirst, year: "2020" }],
    });
    const model = buildAtsResumeModel(result, makeScore([]));
    const entry = model.sections.find((s) => s.kind === "achievements")!
      .entries[0];
    expect(entry.headerLine).not.toContain(EMPHASIS_OPEN);
    expect(entry.headerBold).toBe(true);
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

  it("puts the role team/division on the one-line header as the trailing segment (#436)", () => {
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
    // One-line header: "Title · Company, Location · Team"; the range date is
    // carried separately in `headerLineDate` and drawn flush-right, not glued.
    expect(exp.entries[0].headerLine).toBe(
      "Senior PM · Google, Mountain View, CA · Enterprise Platforms",
    );
    expect(exp.entries[0].headerLineDate).toBe("2021 – 2024");
    expect(exp.entries[0].subLine).toBeUndefined();
  });

  it("omits the team segment cleanly when a role has no team (#436)", () => {
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
    // No team → header is "Title · Company, Location"; date flush-right.
    expect(exp.entries[0].headerLine).toBe(
      "Senior PM · Google, Mountain View, CA",
    );
    expect(exp.entries[0].headerLineDate).toBe("2021 – 2024");
    expect(exp.entries[0].subLine).toBeUndefined();
  });

  it("renders a location-less titled role on one line, date flush-right (#436)", () => {
    // The old two-line shape needed a " · " org signature on a separate anchor
    // line so the re-parser read the neutral company as the company, not the
    // title (#298). The one-line header drops that mechanism; the re-parse
    // title/company disambiguation for this shape is deferred to #436.
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
    expect(exp.entries[0].headerLine).toBe("Chair · Leadership Experience");
    expect(exp.entries[0].headerLineDate).toBe("2021 – 2024");
    expect(exp.entries[0].subLine).toBeUndefined();
  });

  it("draws a lone-year Experience header flush-right, matching a range (#618)", () => {
    // Since #618 the EXPORTER routes a bare `(19|20)\d{2}` year to
    // `headerLineDate` via `isLoneDateRange(..., { allowSingle: true })`, so a
    // lone year on an Experience header takes the same slot a range does. The
    // parser side is unchanged; see the `isLoneDateRange` docblock. `subLine`
    // stays undefined for the one-line shape. A single-token date that is NOT
    // a bare year (e.g. `May 2020` — month-year) still glues, since
    // `allowSingle` narrowly admits only 4-digit years.
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
    expect(exp.entries[0].headerLine).toBe("Analyst · Globex, Austin, TX");
    expect(exp.entries[0].headerLineDate).toBe("2022");
    expect(exp.entries[0].subLine).toBeUndefined();
  });

  it("pins the separator contract: middot header join vs comma empty-company join (#620)", () => {
    // Standard shape: title/company-location/team all join with " · ", and
    // company/location join with ", " — the exporter's fixed, parser-coupled
    // separator set (docs/canonical-resume-model.md §10). A future "normalize
    // the separators" refactor should fail THIS assertion, not silently
    // re-route fields on a real résumé.
    const standard = buildAtsResumeModel(
      makeResult({
        experience: [
          {
            title: "Senior PM",
            company: "Acme",
            location: "Chicago, IL",
            team: "Growth",
            start_date: "2021",
            end_date: "2024",
            description: "Owned the roadmap",
          },
        ],
      }),
      makeScore([]),
    );
    const standardExp = standard.sections.find(
      (s) => s.heading === "Experience",
    )!;
    expect(standardExp.entries[0].headerLine).toBe(
      "Senior PM · Acme, Chicago, IL · Growth",
    );

    // #466 empty-company branch: with `company` empty and `team` set, the
    // header joins Title and Team with a COMMA (not " · ") so the re-parser's
    // role-comma split routes the segment back into `team` instead of
    // mislabeling it as the company.
    const emptyCompany = buildAtsResumeModel(
      makeResult({
        experience: [
          {
            title: "Chair",
            company: "",
            team: "Leadership Council",
            start_date: "2021",
            end_date: "2024",
            description: "Ran the committee",
          },
        ],
      }),
      makeScore([]),
    );
    const emptyCompanyExp = emptyCompany.sections.find(
      (s) => s.heading === "Experience",
    )!;
    expect(emptyCompanyExp.entries[0].headerLine).toBe(
      "Chair, Leadership Council",
    );
  });

  // The GLUE branch, on both sections. #618 rewrote the test above from
  // asserting that a single-token date stays glued to asserting that it goes
  // flush-right — correct for a bare year, but it left the glue branches with no
  // model-level coverage at all. `line-primitives.test.ts` pins the PREDICATE
  // (`isLoneDateRange("May 2020", { allowSingle: true }) === false`); these pin
  // the resulting MODEL SHAPE, which is a different layer: a later change to
  // `rightAlignEduDate` or the Experience gate could route month-year to the
  // flush-right slot and every predicate test would still pass.
  it("keeps a non-year single-token date glued rather than flush-right (#436)", () => {
    const result = makeResult({
      experience: [
        {
          title: "Analyst",
          company: "Globex",
          location: "Austin, TX",
          end_date: "May 2020",
          description: "Cut latency by 40%",
        },
      ],
    });
    const exp = buildAtsResumeModel(result, makeScore([])).sections.find(
      (s) => s.heading === "Experience",
    )!;
    expect(exp.entries[0].headerLine).toBe(
      "Analyst · Globex, Austin, TX  May 2020",
    );
    expect(exp.entries[0].headerLineDate).toBeUndefined();
  });

  it("draws a lone MONTH-YEAR graduation date in the date column too (#882)", () => {
    const result = makeResult({
      education: [
        {
          degree: "BS Data Science",
          institution: "Ridgemont State University",
          end_date: "May 2020",
        },
      ],
    });
    const edu = buildAtsResumeModel(result, makeScore([])).sections.find(
      (s) => s.heading === "Education",
    )!;
    // Pre-#882 this was the GLUED case: `isLoneDateRange` admits a range and
    // (since #618) a bare year, but never a lone month-year, so "May 2020" drew
    // two spaces after the institution. It is the most common graduation shape
    // of all, and it now takes the same flush-right column every other date does.
    expect(edu.entries[0].headerLine).toBe("Ridgemont State University");
    expect(edu.entries[0].headerLineDate).toBe("May 2020");
    expect(edu.entries[0].subLine).toBe("BS Data Science");
  });

  it("falls back to the degree-led shape when a hint-less institution has no date (#882)", () => {
    const result = makeResult({
      education: [{ degree: "B.S.", field: "Computer Science", institution: "MIT" }],
    });
    const edu = buildAtsResumeModel(result, makeScore([])).sections.find(
      (s) => s.heading === "Education",
    )!;
    // `MIT` is `isEntryHeaderShape`-clean, so shape alone would let it lead — but
    // with no date it carries no cue any education segmenter predicate can see:
    // `INSTITUTION_HINTS` misses the name, and `isInstitutionLeadAt` needs the
    // inline date. Leading with it would export an entry the re-parser cannot
    // bound, absorbing the NEXT entry's institution. The degree leads instead.
    expect(edu.entries[0].headerLine).toBe("B.S., Computer Science");
    expect(edu.entries[0].subLine).toBe("MIT");
    expect(edu.entries[0].headerLineDate).toBeUndefined();
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

  it("exports one entry per category under its (edited) label (#473/#476)", () => {
    const result = makeResult({
      skills: ["PostgreSQL", "Redis", "Java"],
      skillCategories: [
        { label: "Data Stores", skills: ["PostgreSQL", "Redis"] },
        { label: "Backend", skills: ["Java"] },
      ],
    });
    const model = buildAtsResumeModel(result, makeScore([]));
    const skills = model.sections.find((s) => s.heading === "Skills")!;
    expect(skills.entries.map((e) => e.fields?.skillCategory)).toEqual([
      "Data Stores",
      "Backend",
    ]);
    // The label leads the line in bold, carried apart from the members so they
    // keep atomic middot wrapping (#881); its trailing space is drawn.
    expect(skills.entries[0].headerBoldLead).toBe("Data Stores: ");
    expect(skills.entries[0].headerLine).toBe("PostgreSQL · Redis");
    expect(skills.entries[1].headerBoldLead).toBe("Backend: ");
  });

  it("drops an empty category so the PDF renders no dangling 'Label:' (#476)", () => {
    const result = makeResult({
      skills: ["Java"],
      skillCategories: [
        { label: "Data Stores", skills: [] }, // emptied in the editor
        { label: "Backend", skills: ["Java"] },
      ],
    });
    const model = buildAtsResumeModel(result, makeScore([]));
    const skills = model.sections.find((s) => s.heading === "Skills")!;
    expect(skills.entries.map((e) => e.fields?.skillCategory)).toEqual(["Backend"]);
  });

  // ── Ungrouped remainder (#791) ───────────────────────────────────────────────
  // `skillCategories` may cover only a SUBSET of the flat `skills` list once a
  // user has created the first category on a résumé that wasn't already fully
  // grouped — see the `types.ts` docblock and `skills-categories.ts`.

  it("appends the remainder as one trailing, uncategorised entry after the categories", () => {
    const result = makeResult({
      skills: ["PostgreSQL", "Redis", "Excel", "PowerPoint"],
      skillCategories: [{ label: "Data Stores", skills: ["PostgreSQL", "Redis"] }],
    });
    const model = buildAtsResumeModel(result, makeScore([]));
    const skills = model.sections.find((s) => s.heading === "Skills")!;
    expect(skills.entries).toHaveLength(2); // 1 category + 1 trailing remainder.
    expect(skills.entries[0].fields?.skillCategory).toBe("Data Stores");
    expect(skills.entries[1].fields?.skillCategory).toBeUndefined();
    expect(skills.entries[1].headerLine).toBe("Excel · PowerPoint");
    // The remainder is a plain flat line — no bold lead to invent a label for
    // skills the user never grouped (#881 AC).
    expect(skills.entries[1].headerBoldLead).toBeUndefined();
    // The union across every entry equals the flat list — nothing lost or
    // duplicated.
    const exported = skills.entries.flatMap((e) => e.fields?.skills ?? []);
    expect(new Set(exported)).toEqual(new Set(result.canonical.fields.skills));
  });

  it("a category snapshot with no remainder is unchanged — no trailing entry (byte-identical, #791 AC)", () => {
    const result = makeResult({
      skills: ["PostgreSQL", "Redis", "Java"],
      skillCategories: [
        { label: "Data Stores", skills: ["PostgreSQL", "Redis"] },
        { label: "Backend", skills: ["Java"] },
      ],
    });
    const model = buildAtsResumeModel(result, makeScore([]));
    const skills = model.sections.find((s) => s.heading === "Skills")!;
    expect(skills.entries).toHaveLength(2);
    expect(skills.entries.every((e) => e.fields?.skillCategory !== undefined)).toBe(
      true,
    );
  });

  it("a fully uncategorised résumé still exports the single flat entry (byte-identical, #791 AC)", () => {
    const result = makeResult({ skills: ["React", "TypeScript", "Node.js"] });
    const model = buildAtsResumeModel(result, makeScore([]));
    const skills = model.sections.find((s) => s.heading === "Skills")!;
    expect(skills.entries).toHaveLength(1);
    expect(skills.entries[0].headerLine).toBe("React · TypeScript · Node.js");
    expect(skills.entries[0].headerBoldLead).toBeUndefined();
    expect(skills.entries[0].fields?.skillCategory).toBeUndefined();
  });

  it("composes honors and grade onto the degree line, in résumé order (#883)", () => {
    const result = makeResult({
      education: [
        {
          degree: "B.S.",
          field: "Computer Science",
          institution: "State University",
          honors: "cum laude",
          gpa: "3.72/4.00",
          year: "2024",
        },
      ],
    });
    const model = buildAtsResumeModel(result, makeScore([]));
    const edu = model.sections.find((s) => s.heading === "Education")!;
    expect(edu.entries[0].subLine).toBe(
      "B.S., Computer Science, cum laude, GPA: 3.72/4.00",
    );
    // Never a bullet: a bullet under an education entry re-parses as coursework.
    expect(edu.entries[0].bullets).toEqual([]);
    expect(edu.entries[0].fields?.score).toBe("3.72/4.00");
  });

  it("leaves a classification unlabelled — 'GPA: First Class' is not a thing (#883)", () => {
    const result = makeResult({
      education: [
        {
          degree: "B.A.",
          field: "Economics",
          institution: "Northwind University",
          gpa: "First Class",
          year: "2024",
        },
      ],
    });
    const model = buildAtsResumeModel(result, makeScore([]));
    const edu = model.sections.find((s) => s.heading === "Education")!;
    expect(edu.entries[0].subLine).toBe("B.A., Economics, First Class");
  });

  it("carries honors and grade on a degree-LESS program header too (#883)", () => {
    const result = makeResult({
      education: [
        {
          degree: "",
          field: "Applied Robotics Certificate",
          institution: "Northwind Institute",
          gpa: "3.5",
          year: "2023",
        },
      ],
    });
    const model = buildAtsResumeModel(result, makeScore([]));
    const edu = model.sections.find((s) => s.heading === "Education")!;
    expect(edu.entries[0].headerLine).toContain("Applied Robotics Certificate");
    expect(edu.entries[0].headerLine).toContain("GPA: 3.5");
  });

  it("emits no dangling separator when an entry carries neither (#883)", () => {
    const model = buildAtsResumeModel(makeResult(), makeScore([]));
    const edu = model.sections.find((s) => s.heading === "Education")!;
    expect(edu.entries[0].subLine).toBe("BS Computer Science");
    expect(edu.entries[0].fields?.score).toBeUndefined();
  });
});

describe("buildAtsResumeModel — certifications as their own section (#884)", () => {
  it("draws a certifications-only résumé under its own verbatim heading", () => {
    // The regression this issue names: `sectionHeadings` has always carried the
    // source's "Certifications" under the `certifications` key, and the exporter
    // read only the `achievements` one — so a résumé whose ONLY such section is
    // Certifications shipped a PDF headed "Achievements" (#285 violation).
    const result = makeResult(
      {
        heuristic_achievements: [],
        heuristic_certifications: [
          { title: "AWS Certified Solutions Architect", year: "2022" },
        ],
      },
      { certifications: "CERTIFICATIONS" },
    );
    const model = buildAtsResumeModel(result, makeScore([]));
    const headings = model.sections.map((s) => s.heading);
    expect(headings).toContain("CERTIFICATIONS");
    expect(headings).not.toContain("Achievements");
    const certs = model.sections.find((s) => s.kind === "certifications")!;
    expect(certs.entries.map((e) => e.headerLine)).toEqual([
      "AWS Certified Solutions Architect · 2022",
    ]);
  });

  it("exports TWO sections, each under its own heading, when both are present", () => {
    const result = makeResult(
      {
        heuristic_achievements: [{ title: "Best Paper Award", year: "2021" }],
        heuristic_certifications: [{ title: "CKA", year: "2023" }],
      },
      { achievements: "HONORS & AWARDS", certifications: "CERTIFICATIONS" },
    );
    const model = buildAtsResumeModel(result, makeScore([]));
    const headings = model.sections.map((s) => s.heading);
    expect(headings).toContain("HONORS & AWARDS");
    expect(headings).toContain("CERTIFICATIONS");
    // Default document order: achievements first, certifications immediately
    // after — the two are adjacent blocks, not one merged one.
    expect(headings.indexOf("CERTIFICATIONS")).toBe(
      headings.indexOf("HONORS & AWARDS") + 1,
    );
  });

  it("puts Certifications first when the résumé wrote it first", () => {
    const result = makeResult(
      {
        heuristic_achievements: [{ title: "Best Paper Award", year: "2021" }],
        heuristic_certifications: [{ title: "CKA", year: "2023" }],
        certifications_placement: "above_achievements",
      },
      { achievements: "AWARDS", certifications: "CERTIFICATIONS" },
    );
    const headings = buildAtsResumeModel(result, makeScore([])).sections.map(
      (s) => s.heading,
    );
    expect(headings.indexOf("CERTIFICATIONS")).toBe(
      headings.indexOf("AWARDS") - 1,
    );
  });

  it("leaves an achievements-only résumé exactly as it was", () => {
    // The no-drift half of the change: with no certifications bucket, the model
    // must be indistinguishable from the pre-#884 one.
    const result = makeResult({
      heuristic_achievements: [{ title: "Best Paper Award", year: "2021" }],
    });
    const model = buildAtsResumeModel(result, makeScore([]));
    expect(model.sections.filter((s) => s.kind === "certifications")).toEqual(
      [],
    );
    expect(model.sections.map((s) => s.heading)).toEqual([
      "Experience",
      "Achievements",
      "Education",
      "Skills",
    ]);
  });

  it("carries a credential URL, which the awards mapping has no slot for", () => {
    const result = makeResult({
      heuristic_achievements: [],
      heuristic_certifications: [
        {
          type: "AWS",
          title: "Solutions Architect – Professional",
          year: "2022",
          url: "https://verify.example.com/abc",
        },
      ],
    });
    const entry = buildAtsResumeModel(result, makeScore([])).sections.find(
      (s) => s.kind === "certifications",
    )!.entries[0];
    expect(entry.fields?.url).toBe("https://verify.example.com/abc");
    // `title` recomposes the label back onto the name (#456).
    expect(entry.fields?.title).toBe("AWS · Solutions Architect – Professional");
    expect(entry.fields?.startDate).toBe("2022");
  });
});
