// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Direct unit coverage for `splitIntoSections`' visual-primary boundary path
 * (L3 / #112).
 *
 * `splitIntoSections` historically had no direct tests — it was exercised only
 * transitively through the corpus snapshots and the split-letter regression.
 * The visual path adds control flow (a font-distinct, non-keyword line opens a
 * boundary; a name/title/tagline at the top does not), so it gets its own
 * pinning here, separate from the corpus FP gate.
 *
 * All personas are synthetic — no PDF binary, per the fixtures PII policy.
 */

import { promises as fsp } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  collapseLetterSpacing,
  groupIntoLines,
  mergeItemText,
  splitIntoSections,
  toSectionedResume,
  type PdfSection,
} from "./sections.ts";
import type { PdfTextItem } from "./types.ts";
import { runCascade } from "./cascade.ts";
import { mkItems } from "./__test-utils__/mkItem.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = join(HERE, "../../..", "tests/fixtures/pdfs");

function build(
  specs: Array<{ text: string; fontSize?: number; x?: number; lineIndex?: number }>,
  columnBoundaries?: Map<number, number>,
): PdfSection[] {
  const items = mkItems(specs);
  return splitIntoSections(
    groupIntoLines(items, columnBoundaries),
    columnBoundaries,
  );
}

/** Section names in document order (for boundary assertions). */
function names(sections: PdfSection[]): string[] {
  return sections.map((s) => s.name);
}

/** The section whose lines contain `needle` (substring match), or undefined. */
function sectionContaining(
  sections: PdfSection[],
  needle: string,
): PdfSection | undefined {
  return sections.find((s) => s.lines.some((l) => l.text.includes(needle)));
}

describe("splitIntoSections — visual-primary boundary path (#112)", () => {
  it("opens a boundary at a visually-distinct, non-keyword header", () => {
    // "Career Journey" is not a keyword/anchor header, but it is rendered
    // larger than body — it must open a boundary so the role beneath it stops
    // bleeding into the profile/summary above.
    const sections = build([
      { text: "Dana Lopez", fontSize: 20 }, // name
      { text: "dana.lopez@example.com | (312) 555-0123", fontSize: 10 }, // contact
      { text: "Seasoned operator with a long track record of delivery work.", fontSize: 10 },
      { text: "Career Journey", fontSize: 14 }, // invented label, font-distinct
      { text: "Lead Operator, Acme Corp  01/2020 - Present", fontSize: 10 },
      { text: "• Ran the overnight logistics desk for three regions.", fontSize: 10 },
    ]);

    // A boundary opened — the "Career Journey" block is its own section, not
    // appended to the profile.
    const journey = sectionContaining(sections, "Lead Operator, Acme Corp");
    expect(journey).toBeDefined();
    expect(journey!.name).toBe("other");

    // The profile keeps the name + contact + summary, and does NOT contain the
    // role line (no bleed).
    const profile = sections[0];
    expect(profile.name).toBe("profile");
    expect(profile.lines.some((l) => l.text.includes("Dana Lopez"))).toBe(true);
    expect(profile.lines.some((l) => l.text.includes("Lead Operator"))).toBe(
      false,
    );
  });

  it("labels a visual header via the keyword path when its text maps, else 'other'", () => {
    // A font-distinct line whose TEXT is a real keyword must label as that
    // canonical section (keyword path runs first); a font-distinct line whose
    // text is unrecognized labels as the boundary-only 'other' sink.
    const sections = build([
      { text: "Sam Carter", fontSize: 20 },
      { text: "sam.carter@example.com | (312) 555-0150", fontSize: 10 },
      { text: "Engineer focused on backend reliability and tooling.", fontSize: 10 },
      { text: "EXPERIENCE", fontSize: 13 }, // keyword (also font-distinct)
      { text: "Senior Engineer, Globex  06/2019 - Present", fontSize: 10 },
      { text: "Highlights", fontSize: 13 }, // invented, font-distinct → other
      { text: "Speaker at three industry conferences last year.", fontSize: 10 },
    ]);

    // The keyword line is labeled experience, not 'other'.
    const exp = sectionContaining(sections, "Senior Engineer, Globex");
    expect(exp).toBeDefined();
    expect(exp!.name).toBe("experience");

    // The unrecognized visual header still acts as a boundary, labeled 'other'.
    const highlights = sectionContaining(sections, "Speaker at three");
    expect(highlights).toBeDefined();
    expect(highlights!.name).toBe("other");
  });

  it("does NOT classify the top large-font name line as a section header", () => {
    // The largest-font line at the top is the candidate name. Even though it is
    // short, unpunctuated, and font-distinct, it must stay in the profile.
    const sections = build([
      { text: "Riley Morgan", fontSize: 22 }, // name — largest font
      { text: "riley.morgan@example.com | (312) 555-0188", fontSize: 10 },
      { text: "Product manager with a decade of shipping consumer apps.", fontSize: 10 },
      { text: "EXPERIENCE", fontSize: 13 },
      { text: "Group PM, Initech  03/2018 - Present", fontSize: 10 },
    ]);

    const profile = sections[0];
    expect(profile.name).toBe("profile");
    expect(profile.lines.some((l) => l.text.includes("Riley Morgan"))).toBe(
      true,
    );
    // The name never spawned an 'other' section before the first real header.
    const beforeExperience = sections.slice(
      0,
      sections.findIndex((s) => s.name === "experience"),
    );
    expect(beforeExperience.every((s) => s.name === "profile")).toBe(true);
  });

  it("keeps a title/tagline stacked under the name in the profile (no premature boundary)", () => {
    // Many résumés stack a font-distinct title or tagline directly under the
    // name, above the contact line. None of those lines may open a boundary —
    // the location on the contact line must survive in the profile.
    const sections = build([
      { text: "Jordan Avery", fontSize: 24 }, // name
      { text: "Staff Engineer", fontSize: 14 }, // tagline, font-distinct
      { text: "jordan.avery@example.com · (312) 555-0111 · Austin, TX", fontSize: 10 },
      { text: "Backend and platform engineer building distributed systems.", fontSize: 10 },
      { text: "EXPERIENCE", fontSize: 13 },
      { text: "Staff Engineer, Northwind  04/2021 - Present", fontSize: 10 },
    ]);

    const profile = sections[0];
    expect(profile.name).toBe("profile");
    // Both the name and the tagline are retained in the profile.
    expect(profile.lines.some((l) => l.text === "Jordan Avery")).toBe(true);
    expect(profile.lines.some((l) => l.text === "Staff Engineer")).toBe(true);
    // The contact line (with the location) is in the profile, not ejected.
    expect(profile.lines.some((l) => l.text.includes("Austin, TX"))).toBe(true);
    // No 'other' boundary opened before the real EXPERIENCE header.
    expect(names(sections).slice(0, sections.indexOf(
      sections.find((s) => s.name === "experience")!,
    ))).not.toContain("other");
  });

  it("does NOT promote a slightly-larger bold job title (sub-1.2x ratio)", () => {
    // A job title rendered bold but only marginally larger than body (≈1.1x)
    // must not open a boundary — that is the role-stranding FP class. Body is
    // 10pt (the dominant size); the title at 11pt is ratio 1.1 < 1.2.
    const sections = build([
      { text: "Pat Quinn", fontSize: 20 },
      { text: "pat.quinn@example.com | (312) 555-0144", fontSize: 10 },
      { text: "EXPERIENCE", fontSize: 13 },
      { text: "Senior Engineer", fontSize: 11 }, // bold title, only 1.1x body
      { text: "Acme Corp  01/2020 - Present", fontSize: 10 },
      { text: "• Shipped the billing rewrite handling 2M daily events.", fontSize: 10 },
      { text: "• Cut deploy time from 40 minutes to 6.", fontSize: 10 },
    ]);

    // Only one experience section; the bold title did NOT open an 'other'
    // boundary that would strand the bullets below it.
    expect(names(sections).filter((n) => n === "other")).toHaveLength(0);
    const exp = sectionContaining(sections, "Senior Engineer");
    expect(exp!.name).toBe("experience");
    // The bullets stayed with the role (no bleed into a new section).
    expect(exp!.lines.some((l) => l.text.includes("billing rewrite"))).toBe(
      true,
    );
  });

  it("does NOT promote a body-size all-caps acronym/skill token", () => {
    // Body-size all-caps content (skill tokens, acronyms) must never open a
    // boundary — the all-caps signal was dropped for exactly this FP class.
    const sections = build([
      { text: "Casey Reed", fontSize: 20 },
      { text: "casey.reed@example.com | (312) 555-0166", fontSize: 10 },
      { text: "SKILLS", fontSize: 13 },
      { text: "HTML", fontSize: 10 }, // all-caps, body size
      { text: "CSS", fontSize: 10 },
      { text: "CI/CD", fontSize: 10 },
    ]);

    // The keyword "SKILLS" opened a skills section; the acronyms below it did
    // not each open their own 'other' boundary.
    expect(names(sections).filter((n) => n === "other")).toHaveLength(0);
    const skills = sectionContaining(sections, "HTML");
    expect(skills!.name).toBe("skills");
  });

  it("does NOT promote a long line or one ending in sentence punctuation", () => {
    // Guardrails: > 4 words / > 40 chars, or a terminal . ! ? — these mark
    // prose, never a header, even at a large font.
    const sections = build([
      { text: "Alex Stone", fontSize: 20 },
      { text: "alex.stone@example.com | (312) 555-0177", fontSize: 10 },
      { text: "EXPERIENCE", fontSize: 13 },
      { text: "Led the platform team across five regions.", fontSize: 16 }, // big but prose (terminal .)
      { text: "Built a forecasting pipeline used company wide here now", fontSize: 16 }, // big but 9 words
      { text: "• Improved accuracy by 18 points year over year.", fontSize: 10 },
    ]);

    // No spurious boundaries: the large prose lines stayed inside experience.
    expect(names(sections).filter((n) => n === "other")).toHaveLength(0);
    const exp = sectionContaining(sections, "Led the platform team");
    expect(exp!.name).toBe("experience");
  });

  it("regression: a keyword-only resume splits identically (visual path inert)", () => {
    // With no font variation at all (every line body-size), the visual path
    // can never fire — output must match the pre-#112 keyword-only behavior.
    const sections = build([
      { text: "Morgan Lee", fontSize: 11 },
      { text: "morgan.lee@example.com | (312) 555-0199", fontSize: 11 },
      { text: "EXPERIENCE", fontSize: 11 },
      { text: "Engineer, Acme  01/2021 - Present", fontSize: 11 },
      { text: "EDUCATION", fontSize: 11 },
      { text: "B.S. Computer Science, State University, 2020", fontSize: 11 },
    ]);

    expect(names(sections)).toEqual([
      "profile",
      "experience",
      "education",
    ]);
  });

  describe("column-gated sidebar-header recovery (#117)", () => {
    // A two-column flatten glues a sidebar value ("20%") onto the "Projects"
    // header, producing a body-size, text-identical-to-prose line. The ONLY
    // signal that separates "20% Projects" (a real header in the secondary
    // column) from main-column prose like "20% Experience" is column
    // membership: line.x >= the page's column split-x. The maxFontSize is kept
    // at body size in every case so these pin the COLUMN gate, not the L3 font
    // path.
    const TWO_COLUMN: Map<number, number> = new Map([[1, 384]]);

    it("(a) recovers `projects` for a sidebar line in the secondary column", () => {
      const sections = build(
        [
          { text: "Drew Hayes", fontSize: 20 }, // name
          { text: "drew.hayes@example.com | (312) 555-0133", fontSize: 10 }, // contact
          { text: "EXPERIENCE", fontSize: 13 }, // real keyword section — past the name block
          { text: "Lead Engineer, Acme  02/2019 - Present", fontSize: 10 },
          // Body-size (NOT font-distinct), secondary column (x=405 >= 384).
          { text: "20% Projects", fontSize: 10, x: 405 },
          { text: "Launched 10 new web fonts with external non-profit partners.", fontSize: 10, x: 405 },
        ],
        TWO_COLUMN,
      );

      // The sidebar-prefixed line opened a `projects` section, not `other`.
      const projects = sectionContaining(sections, "Launched 10 new web fonts");
      expect(projects).toBeDefined();
      expect(projects!.name).toBe("projects");
      expect(names(sections)).toContain("projects");
      // No `other` sink was opened for the recovered header.
      expect(names(sections).filter((n) => n === "other")).toHaveLength(0);
    });

    it("(b) does NOT recover the same line in the MAIN column (x < split)", () => {
      const sections = build(
        [
          { text: "Drew Hayes", fontSize: 20 },
          { text: "drew.hayes@example.com | (312) 555-0133", fontSize: 10 },
          { text: "EXPERIENCE", fontSize: 13 },
          { text: "Lead Engineer, Acme  02/2019 - Present", fontSize: 10 },
          // Same text, body-size, MAIN column (x=50 < 384) — must NOT recover.
          { text: "20% Projects", fontSize: 10, x: 50 },
          { text: "Launched 10 new web fonts with external non-profit partners.", fontSize: 10, x: 50 },
        ],
        TWO_COLUMN,
      );

      // No `projects` section: the main-column line is treated as prose and
      // stays appended to the open experience section.
      expect(names(sections)).not.toContain("projects");
    });

    it("(c) does NOT recover in a single-column doc (no column boundaries)", () => {
      const sections = build([
        { text: "Drew Hayes", fontSize: 20 },
        { text: "drew.hayes@example.com | (312) 555-0133", fontSize: 10 },
        { text: "EXPERIENCE", fontSize: 13 },
        { text: "Lead Engineer, Acme  02/2019 - Present", fontSize: 10 },
        // Same body-size line, but no columnBoundaries passed — gate absent.
        { text: "20% Projects", fontSize: 10 },
        { text: "Launched 10 new web fonts with external non-profit partners.", fontSize: 10 },
      ]);

      expect(names(sections)).not.toContain("projects");
    });
  });
});

describe("splitIntoSections — single-column label-rail recovery FP gate (#355)", () => {
  // The inline leading-token recognizer (`matchLeadingTokenHeader`) recovers a
  // rail header whose keyword LEADS a merged content row ("Experience  Staff
  // Engineer, Platform  Aug 2024 - Present"). Its FP defense — a whole-item alias
  // prefix — is defeated when a bold inline label ("Experience:" / "Education")
  // is its OWN styled run followed by a value run on the same line: the alias IS
  // item[0], so it matches. `remainderLooksLikeEntry` is the guard that must
  // reject those coincidental keyword-led PROSE lines. These pin both directions.
  //
  // Rows are modelled as MULTI-ITEM lines: cells sharing a `lineIndex` group into
  // one `PdfLine` (ordered by x), so item[0] is the styled label run and the rest
  // is the value remainder — the exact shape pdfjs produces for a rail row.

  const RAIL_X = 54; // left rail margin
  const CELL_GAP = 20; // inter-cell gap (pt) — < COLUMN_GAP_THRESHOLD (50) so a
  // multi-cell row groups into ONE PdfLine (mkItem width = len * fontSize * 0.5).

  /** Lay a run of cells left-to-right on one line (shared `lineIndex`), spacing
   *  each by CELL_GAP from the prior cell's right edge — the drawRow analogue,
   *  so the row groups into a single multi-item `PdfLine`. */
  function railRow(
    lineIndex: number,
    cells: string[],
    fontSize = 10,
  ): Array<{ text: string; fontSize: number; x: number; lineIndex: number }> {
    let x = RAIL_X;
    return cells.map((text) => {
      const spec = { text, fontSize, x, lineIndex };
      x += text.length * fontSize * 0.5 + CELL_GAP;
      return spec;
    });
  }

  const PROFILE = [
    { text: "Jane Smith", fontSize: 16, x: RAIL_X, lineIndex: 0 },
    {
      text: "jane.smith@example.com | (312) 555-0123 | San Francisco, CA",
      fontSize: 10,
      x: RAIL_X,
      lineIndex: 1,
    },
  ];

  it("does NOT open experience for `Experience:` ‖ prose summary with a bare year span", () => {
    const sections = build([
      ...PROFILE,
      // Trailing colon marks an inline "label: value" summary lead, not a rail
      // cell; the remainder is prose ("8 years …") with a bare year span.
      ...railRow(2, ["Experience:", "8 years (2015 - 2023) in distributed systems"]),
    ]);
    expect(names(sections)).not.toContain("experience");
  });

  it("does NOT open experience for `Experience` ‖ a lowercase-connective prose lead", () => {
    const sections = build([
      ...PROFILE,
      // Remainder leads with a lowercase connective ("spanning …") — prose, even
      // though it carries a "2015 - 2023" span.
      ...railRow(2, ["Experience", "spanning 2015 - 2023 across fintech"]),
    ]);
    expect(names(sections)).not.toContain("experience");
  });

  it("does NOT open education for `Education` ‖ a lowercase-lead sentence mentioning an institution", () => {
    const sections = build([
      ...PROFILE,
      // Lowercase lead + terminal period + `Institute` buried mid-sentence.
      ...railRow(2, ["Education", "focused, trained at the Broad Institute."]),
    ]);
    expect(names(sections)).not.toContain("education");
  });

  it("does NOT open experience for `Activities` ‖ a capitalized prose line with a BARE year span", () => {
    const sections = build([
      ...PROFILE,
      // Capitalized lead, no terminal period — but the date is a bare `2018 -
      // 2022` span, not a month/season/slash/Present-anchored role tail. (A month
      // regex would also mis-fire on "Marathon" — this pins the year-adjacency.)
      ...railRow(2, ["Activities", "Marathon running club, 2018 - 2022"]),
    ]);
    expect(names(sections)).not.toContain("experience");
  });

  it("DOES open experience for the intended inline rail header (title lead + month-anchored date tail)", () => {
    const sections = build([
      ...PROFILE,
      ...railRow(2, ["Experience", "Staff Engineer, Platform", "Aug 2024 - Present"]),
    ]);
    const exp = sectionContaining(sections, "Staff Engineer");
    expect(exp).toBeDefined();
    expect(exp!.name).toBe("experience");
  });

  it("DOES open education for the intended inline rail header (degree + institution lead)", () => {
    const sections = build([
      ...PROFILE,
      ...railRow(2, ["Education", "B.S. Computer Science, State University", "2013 - 2017"]),
    ]);
    const edu = sectionContaining(sections, "B.S. Computer Science");
    expect(edu).toBeDefined();
    expect(edu!.name).toBe("education");
  });

  it("DOES open skills for the intended STACKED rail label atop a value grid (`Technical` / `Skills`)", () => {
    const sections = build([
      ...PROFILE,
      // Lead cells "Technical" over "Skills" join to the `technical skills` alias;
      // each row carries ≥2 short grid value cells.
      ...railRow(2, ["Technical", "Java", "Python", "SQL", "Kafka"]),
      ...railRow(3, ["Skills", "Spring", "Spark", "React", "AWS"]),
    ]);
    expect(names(sections)).toContain("skills");
  });

  it("does NOT open skills for two PROSE lines whose leads coincidentally join to `Technical Skills` (finding #2)", () => {
    const sections = build([
      ...PROFILE,
      // Leads join to the alias, but each remainder is a single prose clause, not
      // a grid of value cells — the grid-value guard must reject it.
      ...railRow(2, ["Technical", "debt reduction was a major initiative"]),
      ...railRow(3, ["Skills", "matrix mapped every role to a competency"]),
    ]);
    expect(names(sections)).not.toContain("skills");
  });
});

describe("splitIntoSections — coursework header termination (#163)", () => {
  // A "Relevant Coursework" header (now an `education` keyword alias, #163
  // sub-problem 1) must OPEN an education section and thereby TERMINATE the
  // prior section, so the coursework block stops bleeding into the last
  // experience entry's description (and stops leaking into the bullet pool).
  it("opens an `education` section at 'Relevant Coursework' and does NOT append it to the prior entry", () => {
    const sections = build([
      { text: "Jane Smith", fontSize: 18 }, // name
      { text: "jane.smith@example.com | (312) 555-0123", fontSize: 11 }, // contact
      { text: "Activities", fontSize: 12 }, // experience alias (font-distinct)
      { text: "Discussion Group Facilitator  Aug 2025 - Present", fontSize: 11 },
      { text: "• Planned meeting agendas and material for 20+ meetings", fontSize: 11 },
      { text: "• Led and moderated discussions for all participants", fontSize: 11 },
      { text: "Relevant Coursework", fontSize: 12 }, // unrecognized-by-text header → education alias
      { text: "• Financial Accounting", fontSize: 11 },
      { text: "• Microeconomics", fontSize: 11 },
    ]);

    // (1) A coursework section opened and is mapped to the `education` type.
    // The "Relevant Coursework" header line itself is consumed as the boundary
    // (it opens the section, so it isn't stored in any section's `lines`), so we
    // assert on the coursework *items* that landed inside the opened section.
    const coursework = sectionContaining(sections, "Financial Accounting");
    expect(coursework).toBeDefined();
    expect(coursework!.name).toBe("education");

    // A second `education` section opened at the coursework header — distinct
    // from any degree section above it — confirming the header opened a boundary
    // rather than being appended to the prior (experience) section.
    expect(names(sections).filter((n) => n === "education").length).toBe(1);

    // (2) The prior experience entry's lines do NOT carry the coursework header
    // or items — the section terminated cleanly, no bleed into the description.
    const experience = sectionContaining(
      sections,
      "Discussion Group Facilitator",
    );
    expect(experience!.name).toBe("experience");
    expect(
      experience!.lines.some((l) => l.text.includes("Relevant Coursework")),
    ).toBe(false);
    expect(
      experience!.lines.some((l) => l.text.includes("Financial Accounting")),
    ).toBe(false);
    expect(
      experience!.lines.some((l) => l.text.includes("Microeconomics")),
    ).toBe(false);

    // The boundary opened as `education` via the keyword path — never the
    // `other` sink (which would drop coursework out of education completeness).
    expect(names(sections)).not.toContain("other");
  });

  it("font-metadata-independent ALL-CAPS fallback terminates the prior section for an unknown header", () => {
    // A renderer that flattens font metadata (every line body-size) still must
    // terminate a section at an unrecognized ALL-CAPS header via the text-pattern
    // path (#163 sub-problem 2) — generalizing the boundary fix beyond coursework.
    const sections = build([
      { text: "Jane Smith", fontSize: 11 }, // name (no font lift — flattened)
      { text: "jane.smith@example.com | (312) 555-0123", fontSize: 11 },
      { text: "EXPERIENCE", fontSize: 11 },
      { text: "Engineer, Acme  01/2021 - Present", fontSize: 11 },
      { text: "• Shipped the billing rewrite handling 2M daily events", fontSize: 11 },
      { text: "VOLUNTEER WORK", fontSize: 11 }, // unknown ALL-CAPS header, body-size
      { text: "• Mentored five first-generation students weekly", fontSize: 11 },
    ]);

    // The unknown ALL-CAPS header opened a boundary (the `other` sink — not a
    // known keyword), so its content did not bleed into the experience entry.
    const volunteer = sectionContaining(sections, "Mentored five");
    expect(volunteer).toBeDefined();
    expect(volunteer!.name).toBe("other");
    const experience = sectionContaining(sections, "Engineer, Acme");
    expect(
      experience!.lines.some((l) => l.text.includes("Mentored five")),
    ).toBe(false);
  });

  it("does NOT promote a body-size Title-Case job title via the text-pattern path", () => {
    // The text-pattern fallback is ALL-CAPS only: a body-size Title-Case line
    // ("Sr Software Engineer") is a job title / company / institution, never a
    // section header — promoting it would strand the role beneath it.
    const sections = build([
      { text: "Jane Smith", fontSize: 11 },
      { text: "jane.smith@example.com | (312) 555-0123", fontSize: 11 },
      { text: "EXPERIENCE", fontSize: 11 },
      { text: "Sr Software Engineer", fontSize: 11 }, // Title Case, body size
      { text: "Acme Corp  01/2020 - Present", fontSize: 11 },
      { text: "• Built the deploy pipeline cutting release time by 40%", fontSize: 11 },
    ]);

    expect(names(sections).filter((n) => n === "other")).toHaveLength(0);
    const exp = sectionContaining(sections, "Sr Software Engineer");
    expect(exp!.name).toBe("experience");
    expect(exp!.lines.some((l) => l.text.includes("Built the deploy"))).toBe(
      true,
    );
  });
});

describe("splitIntoSections — single-word vertical-gap header path (#216)", () => {
  // Line-level coverage for the font-independent gap cue that re-admits a
  // single-word, ALL-CAPS, unknown-vocabulary header (`INTERNSHIPS`) the
  // multi-word text-pattern gate (#163) and the font-ratio gate (#112) both
  // drop on font-flattening renderers. `mkItems` spaces consecutive lines 14pt
  // apart (the body line-height the gap cue measures against); SKIPPING a
  // `lineIndex` opens a wider gap above a line (e.g. a jump of 2 ⇒ 28pt gap,
  // ratio 2.0 > the 1.4 threshold), modelling the paragraph break above a real
  // section header. Every line here is body font-size (11pt) so ONLY the gap
  // signal — never the font path — can fire.

  it("opens a boundary at a single-word ALL-CAPS header with a prominent gap above", () => {
    const sections = build([
      { text: "Jane Smith", fontSize: 11, lineIndex: 0 },
      { text: "jane.smith@example.com | (312) 555-0123", fontSize: 11, lineIndex: 1 },
      { text: "EXPERIENCE", fontSize: 11, lineIndex: 2 },
      { text: "Engineer, Acme  01/2021 - Present", fontSize: 11, lineIndex: 3 },
      { text: "• Shipped the billing rewrite handling 2M events", fontSize: 11, lineIndex: 4 },
      // 28pt gap above (lineIndex jumps 4 → 6) — the paragraph break before a
      // real header. Single word, ALL CAPS, unknown vocabulary.
      { text: "INTERNSHIPS", fontSize: 11, lineIndex: 6 },
      { text: "Acme Corp Jun 2025 - Aug 2025", fontSize: 11, lineIndex: 7 },
      { text: "• Implemented a metrics dashboard for an internal service", fontSize: 11, lineIndex: 8 },
    ]);

    // The unknown single-word header opened a boundary (the `other` sink — no
    // keyword/anchor name), so its block stopped being absorbed into experience.
    const internships = sectionContaining(sections, "Acme Corp Jun 2025");
    expect(internships).toBeDefined();
    expect(internships!.name).toBe("other");
    const experience = sectionContaining(sections, "Engineer, Acme");
    expect(experience!.name).toBe("experience");
    expect(
      experience!.lines.some((l) => l.text.includes("Acme Corp Jun 2025")),
    ).toBe(false);
  });

  it("does NOT promote a single-word ALL-CAPS token with an ORDINARY gap (inline acronym — #112 FP)", () => {
    // A body-size single-token acronym inside a packed skills list carries only
    // the ordinary within-paragraph gap (14pt, ratio 1.0) — the gap cue must NOT
    // fire, keeping the #112 single-token FP class closed.
    const sections = build([
      { text: "Jane Smith", fontSize: 11, lineIndex: 0 },
      { text: "jane.smith@example.com | (312) 555-0123", fontSize: 11, lineIndex: 1 },
      { text: "EXPERIENCE", fontSize: 11, lineIndex: 2 },
      { text: "Engineer, Acme  01/2021 - Present", fontSize: 11, lineIndex: 3 },
      { text: "• Built the deploy pipeline cutting release time", fontSize: 11, lineIndex: 4 },
      // Single-word ALL-CAPS, but ordinary 14pt gap (lineIndex 5) — an inline
      // acronym, not a header.
      { text: "HTML", fontSize: 11, lineIndex: 5 },
      { text: "CSS", fontSize: 11, lineIndex: 6 },
    ]);

    expect(names(sections).filter((n) => n === "other")).toHaveLength(0);
  });

  it("does NOT promote a single-word ALL-CAPS token immediately AFTER a header (inflated post-header gap)", () => {
    // The first content token directly under a real header inherits a gap-above
    // measured against the header, which can clear the ratio — but a header
    // never directly follows another header, so the adjacency guard suppresses
    // it. Models a column-reordered skills grid's lead token (`HTML` under
    // `SKILLS`) with a wide gap.
    const sections = build([
      { text: "Jane Smith", fontSize: 11, lineIndex: 0 },
      { text: "jane.smith@example.com | (312) 555-0123", fontSize: 11, lineIndex: 1 },
      { text: "SKILLS", fontSize: 11, lineIndex: 3 }, // keyword header, wide gap above
      // Wide 28pt gap above this first skill token (lineIndex 3 → 5), but it
      // directly follows the SKILLS boundary — the guard must keep it in skills.
      { text: "HTML", fontSize: 11, lineIndex: 5 },
      { text: "CSS", fontSize: 11, lineIndex: 6 },
    ]);

    expect(names(sections).filter((n) => n === "other")).toHaveLength(0);
    const skills = sectionContaining(sections, "HTML");
    expect(skills!.name).toBe("skills");
  });

  it("does NOT promote a single-word Title-Case line even with a prominent gap", () => {
    // The gap cue is ALL-CAPS only (shares `textPatternCleanWords`): a Title-Case
    // single word ("Internships") is a label/heading shape this path deliberately
    // leaves to vocabulary, since lone Title-Case tokens are dominated by content
    // (company / role fragments). Only the casing differs from the firing case.
    const sections = build([
      { text: "Jane Smith", fontSize: 11, lineIndex: 0 },
      { text: "jane.smith@example.com | (312) 555-0123", fontSize: 11, lineIndex: 1 },
      { text: "EXPERIENCE", fontSize: 11, lineIndex: 2 },
      { text: "Engineer, Acme  01/2021 - Present", fontSize: 11, lineIndex: 3 },
      { text: "• Shipped the billing rewrite handling 2M events", fontSize: 11, lineIndex: 4 },
      { text: "Internships", fontSize: 11, lineIndex: 6 }, // Title case, wide gap
      { text: "Acme Corp Jun 2025 - Aug 2025", fontSize: 11, lineIndex: 7 },
    ]);

    expect(names(sections).filter((n) => n === "other")).toHaveLength(0);
  });
});

/**
 * Section-count regression on a sample of real corpus fixtures (#112 AC).
 *
 * The visual-promotion path can only HURT these via false positives that
 * fragment a section into the `other` sink (stranding roles/education) or eject
 * the location line out of the profile. These assert the post-#112 outcome on
 * the highest-risk regex-path fixtures: the name/title-block disambiguation
 * fixtures and the two-column sidebar fixtures where a flattened sidebar label
 * is most likely to be mis-promoted. The corpus snapshot pins the full result;
 * this block states the *segmentation* intent explicitly and in one place.
 */
describe("splitIntoSections — corpus section-count regression (#112)", () => {
  const cases: Array<{
    file: string;
    experience: number;
    education: number;
    hasLocation: boolean;
  }> = [
    {
      // Name/title disambiguation: "Functional Resume Sample" + "Jane Smith"
      // are both font-distinct at the top; neither may open a boundary, and the
      // "123 … IL 62701" location line must stay in the profile.
      file: "latex/header-as-name-functional-resume.pdf",
      experience: 2,
      education: 1,
      hasLocation: true,
    },
    {
      // Name + font-distinct tagline ("Software Engineering Leader") stacked
      // above the contact line; the "Austin, TX" location must survive.
      file: "unknown/chromium-two-column-sidebar.pdf",
      experience: 5,
      education: 1,
      hasLocation: true,
    },
    {
      // Two-column sidebar with all-caps labels ("STRENGTHS") that must NOT
      // promote and strand the experience column.
      file: "unknown/chromium-asymmetric-sidebar.pdf",
      experience: 3,
      education: 1,
      hasLocation: true,
    },
    {
      // Non-standard headers — "ON CAMPUS INVOLVEMENT" and "VOLUNTEER
      // EXPERIENCE" route to experience (Part A, issue #19). "INTERNSHIPS" is a
      // single-word, ALL-CAPS, unknown-vocabulary header this font-flattening
      // renderer emits at body font (ratio ≈1.09) — below the 1.15 font gate
      // and short of the multi-word text-pattern path. Pre-#216 it was silently
      // absorbed into the VOLUNTEER experience block (so its Acme entry still
      // counted toward experience, giving experience=3). The #216 vertical-gap
      // cue now OPENS a boundary at INTERNSHIPS; with no keyword/anchor name it
      // opens the `other` sink (naming an unnamed boundary is a separate
      // follow-on), so the Acme intern entry moves out of experience →
      // experience drops to 2. The boundary is recovered (no more cross-section
      // absorption); the score trade-off (its 2 bullets leave the experience
      // pool) is the deferred-naming consequence the issue scopes out.
      file: "google-docs/google-docs-skia-proxy-nonstandard-headers.pdf",
      experience: 2,
      education: 1,
      hasLocation: false,
    },
  ];

  for (const c of cases) {
    it(`${c.file}: experience=${c.experience}, education=${c.education}`, async () => {
      const bytes = await fsp.readFile(join(FIXTURE_ROOT, c.file));
      const cascade = await runCascade(new Uint8Array(bytes));
      expect(cascade.parsed.experience?.length ?? 0).toBe(c.experience);
      expect(cascade.parsed.education?.length ?? 0).toBe(c.education);
      expect(!!cascade.parsed.location).toBe(c.hasLocation);
    }, 15_000);
  }
});

describe("splitIntoSections — institution name ending in a section anchor (#258)", () => {
  // #258 residual hole 2: a wholly ALL-CAPS institution whose trailing word is a
  // section anchor ("ACME PROFESSIONAL EDUCATION") carries no institution-type
  // word and no Title-case modifier, so it is shape-indistinguishable from a real
  // header line-locally (the `allCaps` escape needed by real "PROFESSIONAL
  // EXPERIENCE" headers lets Guard 8 NOT fire). When it appears UNDER an
  // already-open `education` section, the second anchor-fallback open is the
  // context tell: the line is an institution entry, not a header. It must be
  // retained as content, not consumed as a boundary (which drops the name).
  it("retains an institution line under an open education section instead of eating it as a 2nd header", () => {
    const sections = build([
      { text: "Dana Lopez", fontSize: 18 }, // name
      { text: "dana.lopez@example.com | (312) 555-0123", fontSize: 11 }, // contact
      { text: "EDUCATION", fontSize: 13 }, // real header (L1 exact alias)
      { text: "ACME PROFESSIONAL EDUCATION", fontSize: 11 }, // institution entry (wholly ALL-CAPS — Guard 8 cannot fire)
      { text: "M.S. Data Science  2018 - 2020", fontSize: 11 }, // degree + date
    ]);

    // The institution line is retained as content inside the education section,
    // not consumed as a boundary label (which would drop the institution name).
    const inst = sectionContaining(sections, "ACME PROFESSIONAL EDUCATION");
    expect(inst).toBeDefined();
    expect(inst!.name).toBe("education");

    // Exactly one education section — the institution line did NOT open a second.
    expect(names(sections).filter((n) => n === "education").length).toBe(1);
  });

  it("still opens a genuine L2 header for a DIFFERENT section than the one currently open", () => {
    // The suppression is gated on the CURRENTLY-open section, not "ever opened":
    // a real "Relevant Experience" (L2) header appearing while EDUCATION is the
    // open section must open its own experience section — its content must NOT
    // bleed into education. (Regression guard for the cross-section bleed a naive
    // "ever-opened" gate would cause.)
    const sections = build([
      { text: "Dana Lopez", fontSize: 18 }, // name
      { text: "dana.lopez@example.com | (312) 555-0123", fontSize: 11 }, // contact
      { text: "PROFESSIONAL EXPERIENCE", fontSize: 13 }, // L1 — opens experience
      { text: "Engineer, Globex  2019 - 2021", fontSize: 11 },
      { text: "EDUCATION", fontSize: 13 }, // L1 — opens education (now current)
      { text: "B.S. Computer Science, MIT  2019", fontSize: 11 },
      { text: "Relevant Experience", fontSize: 11 }, // L2 experience ≠ current
      { text: "Mentor, Local Shelter  2022 - Present", fontSize: 11 },
    ]);

    // The Mentor role landed in an experience section, not in education.
    const mentor = sectionContaining(sections, "Mentor, Local Shelter");
    expect(mentor).toBeDefined();
    expect(mentor!.name).toBe("experience");

    // Education holds only the degree line — no experience bleed.
    const edu = sectionContaining(sections, "B.S. Computer Science");
    expect(edu!.name).toBe("education");
    expect(edu!.lines.some((l) => l.text.includes("Mentor"))).toBe(false);
    expect(edu!.lines.some((l) => l.text.includes("Relevant Experience"))).toBe(
      false,
    );
  });

  it("keeps a single-column EDUCATION with two anchor-ending institutions as ONE section (#311 relaxation is experience-only)", () => {
    // #311 relaxed the #258 suppression so a SECOND same-canonical anchor-
    // fallback header (no longer the immediate first content line) opens a new
    // group — legitimate for multi-category EXPERIENCE, but for EDUCATION it
    // reopens the #258 bug: the 2nd entry's institution name ("... EDUCATION")
    // wrongly opens a 2nd education section and its content is lost. The
    // relaxation must be gated to `experience`; every other section keeps the
    // strict suppression regardless of adjacency.
    const sections = build([
      { text: "Dana Lopez", fontSize: 18 }, // name
      { text: "dana.lopez@example.com | (312) 555-0123", fontSize: 11 }, // contact
      { text: "EDUCATION", fontSize: 13 }, // real header (L1 exact alias)
      { text: "ACME PROFESSIONAL EDUCATION", fontSize: 11 }, // institution 1 (first content line)
      { text: "M.S. Data Science  2018 - 2020", fontSize: 11 }, // degree + date (intervening content)
      { text: "GLOBEX PROFESSIONAL EDUCATION", fontSize: 11 }, // institution 2 (NOT the first content line — the #311 trap)
      { text: "B.A. Teaching  2012 - 2016", fontSize: 11 }, // degree + date
    ]);

    // Both institution lines are retained as content, not consumed as headers.
    expect(sectionContaining(sections, "ACME PROFESSIONAL EDUCATION")).toBeDefined();
    expect(sectionContaining(sections, "GLOBEX PROFESSIONAL EDUCATION")).toBeDefined();

    // Exactly ONE education section — the 2nd institution did NOT open a 2nd.
    expect(names(sections).filter((n) => n === "education").length).toBe(1);
  });
});

describe("PdfSection.rawHeading — verbatim source heading capture (#285)", () => {
  it("captures the original heading text for a synonym mapped to a canonical section", () => {
    // "Work History" is an alias for the canonical "experience" section —
    // scoring stays keyed on "experience", but the section retains the user's
    // own wording for display.
    const sections = build([
      { text: "Dana Lopez", fontSize: 18 },
      { text: "dana.lopez@example.com | (312) 555-0123", fontSize: 11 },
      { text: "Work History", fontSize: 13 },
      { text: "Engineer, Globex  2019 - 2021", fontSize: 11 },
    ]);
    const experience = sections.find((s) => s.name === "experience");
    expect(experience?.rawHeading).toBe("Work History");
  });

  it("captures the original heading text for a skills synonym", () => {
    const sections = build([
      { text: "Dana Lopez", fontSize: 18 },
      { text: "dana.lopez@example.com | (312) 555-0123", fontSize: 11 },
      { text: "Technical Skills", fontSize: 13 },
      { text: "TypeScript, SQL, React", fontSize: 11 },
    ]);
    const skills = sections.find((s) => s.name === "skills");
    expect(skills?.rawHeading).toBe("Technical Skills");
  });

  it("leaves rawHeading undefined for the profile section", () => {
    const sections = build([
      { text: "Dana Lopez", fontSize: 18 },
      { text: "dana.lopez@example.com | (312) 555-0123", fontSize: 11 },
    ]);
    const profile = sections.find((s) => s.name === "profile");
    expect(profile?.rawHeading).toBeUndefined();
  });

  it("threads rawHeading into SectionedResume.sectionHeadings for the display layer", () => {
    const sections = build([
      { text: "Dana Lopez", fontSize: 18 },
      { text: "dana.lopez@example.com | (312) 555-0123", fontSize: 11 },
      { text: "Work History", fontSize: 13 },
      { text: "Engineer, Globex  2019 - 2021", fontSize: 11 },
    ]);
    const resume = toSectionedResume(sections, "regex");
    expect(resume.sectionHeadings?.get("experience")).toBe("Work History");
    expect(resume.sectionHeadings?.size).toBe(1);
  });
});

describe("collapseLetterSpacing — de-track tracked-out runs (#330)", () => {
  it("collapses a letter-spaced word to one token", () => {
    expect(collapseLetterSpacing("J O R D A N")).toBe("JORDAN");
    expect(collapseLetterSpacing("r e s u m e")).toBe("resume");
  });

  it("leaves runs shorter than the min (< 4 letters) alone", () => {
    // Initials, roman numerals, short spaced acronyms stay untouched.
    expect(collapseLetterSpacing("J R R")).toBe("J R R");
    expect(collapseLetterSpacing("I V X")).toBe("I V X");
    expect(collapseLetterSpacing("A B C")).toBe("A B C");
  });

  it("collapses each word but preserves a trailing multi-char token", () => {
    // The run anchors on a non-letter, so "Reyes" isn't swallowed.
    expect(collapseLetterSpacing("J O R D A N Reyes")).toBe("JORDAN Reyes");
  });

  it("de-tracks accented (non-ASCII) letters", () => {
    expect(collapseLetterSpacing("A N D R É S")).toBe("ANDRÉS");
    expect(collapseLetterSpacing("J O S É")).toBe("JOSÉ");
  });

  it("preserves a >=2-space word gap as a boundary within one item", () => {
    // A wider inter-word gap ends the single-space run, so the two words
    // survive even when the whole heading is one item. collapseLetterSpacing
    // itself only strips intra-run spaces; the surrounding gap is left as-is
    // (mergeItemText's trailing \s+ collapse normalizes it to one space).
    expect(collapseLetterSpacing("J O R D A N  R E Y E S")).toBe(
      "JORDAN  REYES",
    );
  });

  it("does not touch normal prose or digits", () => {
    expect(collapseLetterSpacing("Globex Financial | New York, NY")).toBe(
      "Globex Financial | New York, NY",
    );
    expect(collapseLetterSpacing("1 2 3 4 5")).toBe("1 2 3 4 5");
  });
});

describe("mergeItemText — letter-spaced heading recovery (#330)", () => {
  const line = (str: string, x: number, width: number): PdfTextItem => ({
    page: 1,
    str,
    x,
    y: 72,
    width,
    height: 24,
    fontSize: 24,
    fontName: "font-24",
    hasEOL: true,
  });

  it("recovers a two-word name from per-glyph items, keeping the word break", () => {
    // pdfjs emits each tracked-out word as one space-joined item and the real
    // word boundary as a separate " " item. Per-item de-tracking must keep the
    // boundary so the two words survive.
    const items = [
      line("J O R D A N", 100, 90),
      line(" ", 195, 8),
      line("R E Y E S", 205, 75),
    ];
    expect(mergeItemText(items)).toBe("JORDAN REYES");
  });

  it("leaves an un-tracked line unchanged", () => {
    const items = [
      line("Jordan Reyes", 100, 90),
      line("Engineer", 205, 60),
    ];
    expect(mergeItemText(items)).toBe("Jordan Reyes Engineer");
  });
});
