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
import { groupIntoLines, splitIntoSections, type PdfSection } from "./sections.ts";
import { runCascade } from "./cascade.ts";
import { mkItems } from "./__test-utils__/mkItem.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = join(HERE, "../../..", "tests/fixtures/pdfs");

function build(
  specs: Array<{ text: string; fontSize?: number; x?: number }>,
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
      // Invented all-caps labels ("INTERNSHIPS", "ON CAMPUS INVOLVEMENT") at
      // body size — handled by the keyword/anchor path, not over-split.
      file: "google-docs/google-docs-skia-proxy-nonstandard-headers.pdf",
      experience: 2,
      education: 2,
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
