// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Unit tests for the shared `parseEntryBlocks` primitive.
 *
 * These pin the section-agnostic machinery (anchor detection, entry windowing,
 * date parsing, header assembly, bullet-body collection) that
 * `extractExperience` — and, later, the projects / achievements / education
 * extractors — consume. Synthetic personas only, per the fixtures PII policy.
 */

import { describe, it, expect } from "vitest";
import { groupIntoLines, splitIntoSections, findSection } from "./sections.ts";
import { parseEntryBlocks, mergeWrappedContinuations } from "./entry-blocks.ts";
import { mkItems } from "./__test-utils__/mkItem.ts";
import type { PdfSection, PdfLine } from "./sections.ts";

/** Build an experience section from line specs (the date_range anchor case). */
function experienceSection(
  specs: Array<{ text: string; fontSize?: number }>,
): PdfSection | undefined {
  const sections = splitIntoSections(groupIntoLines(mkItems(specs)));
  return findSection(sections, "experience");
}

/** Build a section from explicit (text, x) lines — for x-sensitive cases like
 *  wrapped-bullet continuations indented past the bullet marker. */
function xSection(
  name: PdfSection["name"],
  rows: Array<{ text: string; x: number }>,
): PdfSection {
  const lines: PdfLine[] = rows.map(({ text, x }) => ({
    page: 1,
    y: 0,
    x,
    items: [],
    text,
    maxFontSize: 11,
    allCaps: false,
    gapAbove: 0,
  }));
  return { name, lines };
}

describe("parseEntryBlocks — date_range anchor", () => {
  it("returns [] for an absent or empty section", () => {
    expect(
      parseEntryBlocks(undefined, { anchor: "date_range", collectBody: true }),
    ).toEqual([]);
    expect(
      parseEntryBlocks(
        { name: "experience", lines: [] },
        { anchor: "date_range", collectBody: true },
      ),
    ).toEqual([]);
  });

  it("returns [] when no line carries a date range", () => {
    const section = experienceSection([
      { text: "EXPERIENCE", fontSize: 13 },
      { text: "Acme Corp" },
      { text: "Senior Engineer" },
    ]);
    expect(
      parseEntryBlocks(section, { anchor: "date_range", collectBody: true }),
    ).toEqual([]);
  });

  it("splits one entry: header above + dated anchor + bullet body", () => {
    const section = experienceSection([
      { text: "EXPERIENCE", fontSize: 13 },
      { text: "Senior Engineer" },
      { text: "Acme Corp  01/2020 - 03/2023" },
      { text: "• Cut p99 latency 40% via a new service mesh." },
      { text: "• Mentored 6 engineers." },
    ]);
    const blocks = parseEntryBlocks(section, {
      anchor: "date_range",
      collectBody: true,
      headerLookback: 2,
    });
    expect(blocks).toHaveLength(1);
    const [b] = blocks;
    // Header lines: the lookback line above + the anchor line minus its dates.
    expect(b.headerLines).toContain("Senior Engineer");
    expect(b.headerLines.some((h) => h.includes("Acme Corp"))).toBe(true);
    expect(b.headerLines.some((h) => /\d{4}/.test(h))).toBe(false); // dates stripped
    expect(b.dates.start_date).toBeTruthy();
    expect(b.dates.end_date).toBeTruthy();
    expect(b.bulletCount).toBe(2);
    expect(b.body).toContain("service mesh");
    expect(b.body).toContain("Mentored 6 engineers");
  });

  it("splits multiple entries at each dated anchor", () => {
    const section = experienceSection([
      { text: "EXPERIENCE", fontSize: 13 },
      { text: "Acme Corp  01/2020 - 03/2023" },
      { text: "• Shipped the billing rewrite." },
      { text: "Globex Inc  06/2016 - 12/2019" },
      { text: "• Built the ingestion pipeline." },
    ]);
    const blocks = parseEntryBlocks(section, {
      anchor: "date_range",
      collectBody: true,
      headerLookback: 2,
    });
    expect(blocks).toHaveLength(2);
    expect(blocks[0].headerLines.some((h) => h.includes("Acme Corp"))).toBe(true);
    expect(blocks[0].body).toContain("billing rewrite");
    expect(blocks[1].headerLines.some((h) => h.includes("Globex Inc"))).toBe(true);
    expect(blocks[1].body).toContain("ingestion pipeline");
  });

  it("handles an open-ended 'Present' end date", () => {
    const section = experienceSection([
      { text: "EXPERIENCE", fontSize: 13 },
      { text: "Staff Engineer, Initech  04/2021 - Present" },
      { text: "• Lead the platform team." },
    ]);
    const [b] = parseEntryBlocks(section, {
      anchor: "date_range",
      collectBody: true,
      headerLookback: 2,
    });
    expect(b.dates.start_date).toBeTruthy();
    expect(b.dates.is_current).toBe(true);
    expect(b.dates.end_date).toBeUndefined();
  });

  it("collects no body when collectBody is false", () => {
    const section = experienceSection([
      { text: "EXPERIENCE", fontSize: 13 },
      { text: "Acme Corp  01/2020 - 03/2023" },
      { text: "• A bullet that should be ignored." },
    ]);
    const [b] = parseEntryBlocks(section, {
      anchor: "date_range",
      collectBody: false,
      headerLookback: 2,
    });
    expect(b.body).toBeUndefined();
    expect(b.bulletCount).toBe(0);
  });

  it("does not pull the previous entry's bullets into the next header (lookback bound)", () => {
    const section = experienceSection([
      { text: "EXPERIENCE", fontSize: 13 },
      { text: "Acme Corp  01/2020 - 03/2023" },
      { text: "• First role bullet one." },
      { text: "• First role bullet two." },
      { text: "Globex Inc  06/2016 - 12/2019" },
      { text: "• Second role bullet." },
    ]);
    const blocks = parseEntryBlocks(section, {
      anchor: "date_range",
      collectBody: true,
      headerLookback: 2,
    });
    expect(blocks).toHaveLength(2);
    // The second entry's header must not contain a bullet from the first entry.
    expect(blocks[1].headerLines.some((h) => h.includes("First role"))).toBe(
      false,
    );
    expect(blocks[1].headerLines.some((h) => h.includes("Globex Inc"))).toBe(
      true,
    );
  });

  it("drops a wrapped bullet tail from the next entry's header (#boundary)", () => {
    // The bullet wraps onto a marker-less line indented past the bullet marker
    // (x 90 > marker x 64); headers sit at the left margin (x 50). The wrapped
    // tail must not leak into the next entry's company / designation.
    const section = xSection("experience", [
      { text: "Northwind Labs  Jul 2025 - Present", x: 50 },
      { text: "• Documented architecture and managed changes with peer", x: 64 },
      { text: "review.", x: 90 }, // wrapped continuation of the bullet above
      { text: "Riverton County Schools  Oct 2025 - Present", x: 50 },
      { text: "Substitute Teacher", x: 50 },
      { text: "• Supported classroom instruction.", x: 64 },
    ]);
    const blocks = parseEntryBlocks(section, {
      anchor: "date_range",
      collectBody: true,
      headerLookback: 2,
    });
    expect(blocks).toHaveLength(2);
    // The fragment must not leak into the second entry's header.
    expect(blocks[1].headerLines.some((h) => /review/.test(h))).toBe(false);
    expect(
      blocks[1].headerLines.some((h) => h.includes("Riverton County Schools")),
    ).toBe(true);
  });

  it("honors headerLookback=0 — no lines above the anchor join the header", () => {
    const section = experienceSection([
      { text: "EXPERIENCE", fontSize: 13 },
      { text: "Senior Engineer" },
      { text: "Acme Corp  01/2020 - 03/2023" },
      { text: "• A bullet." },
    ]);
    const [b] = parseEntryBlocks(section, {
      anchor: "date_range",
      collectBody: true,
      headerLookback: 0,
    });
    // "Senior Engineer" is above the anchor; with lookback 0 it is excluded.
    expect(b.headerLines).not.toContain("Senior Engineer");
    expect(b.headerLines.some((h) => h.includes("Acme Corp"))).toBe(true);
  });
});

describe("parseEntryBlocks — first_line anchor (projects / date-optional sections)", () => {
  // Built directly as a PdfSection so the section header machinery (which only
  // knows experience/education/etc.) doesn't interfere. The `first_line`
  // anchor is the enabler for the projects child issue (#95): a project name
  // leads each block and a date may be absent.
  function section(lines: Array<{ text: string }>): PdfSection {
    return {
      name: "projects",
      lines: lines.map((l, i) => ({
        page: 1,
        y: 72 + i * 14,
        x: 72,
        items: [],
        text: l.text,
        maxFontSize: 11,
        allCaps: false,
    gapAbove: 0,
      })),
    };
  }

  it("opens one entry per header run, not one per header line", () => {
    // A short, label-shaped subtitle (no period, no verb-lead, < 60 chars)
    // joins the header run under the first_line anchor; a bulleted body opens
    // per-project, not per-line.
    const blocks = parseEntryBlocks(
      section([
        { text: "Resume Linter" },
        { text: "React, TypeScript, Vite" },
        { text: "• Built the heuristic cascade." },
        { text: "Trip Planner" },
        { text: "• Added the itinerary view." },
      ]),
      { anchor: "first_line", collectBody: true },
    );
    expect(blocks).toHaveLength(2);
    expect(blocks[0].headerLines).toContain("Resume Linter");
    // The tech-stack subtitle (a label-shaped CSV, not a body paragraph)
    // joins the header run — one entry, not two.
    expect(blocks[0].headerLines).toContain("React, TypeScript, Vite");
    expect(blocks[0].body).toContain("heuristic cascade");
    expect(blocks[1].headerLines).toContain("Trip Planner");
    expect(blocks[1].body).toContain("itinerary view");
  });

  it("#464: a period-terminated prose line closes the header run and routes to body", () => {
    // A body-paragraph shape (ends in `.`, or long, or verb-led without a
    // CSV comma) is a description sentence, not a subtitle — it goes to
    // `body`, not `headerLines`. Without this, single-sentence prose bodies
    // get absorbed into headerLines and never surface as `description`.
    const blocks = parseEntryBlocks(
      section([
        { text: "Resume Linter" },
        { text: "A browser-side PDF parser audit." },
        { text: "• Built the heuristic cascade." },
      ]),
      { anchor: "first_line", collectBody: true },
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0].headerLines).toContain("Resume Linter");
    expect(blocks[0].headerLines).not.toContain(
      "A browser-side PDF parser audit.",
    );
    expect(blocks[0].body).toContain("A browser-side PDF parser audit.");
    expect(blocks[0].body).toContain("heuristic cascade");
  });

  it("#464: no `•` bullets, two prose-body projects — each becomes its own entry with its description surfaced", () => {
    const blocks = parseEntryBlocks(
      section([
        { text: "Ridgemont Resume Studio" },
        { text: "React, TypeScript, Tailwind" },
        {
          text: "Built a client-side resume review platform with real-time feedback.",
        },
        { text: "Optimized rendering with responsive interfaces." },
        { text: "Ledger Ingest Toolkit" },
        { text: "Java, Spring Boot, Kafka" },
        { text: "Designed a distributed-systems teaching harness." },
        { text: "Documented Redis-backed caching patterns." },
      ]),
      { anchor: "first_line", collectBody: true },
    );
    expect(blocks).toHaveLength(2);
    expect(blocks[0].headerLines).toContain("Ridgemont Resume Studio");
    expect(blocks[0].headerLines).toContain("React, TypeScript, Tailwind");
    expect(blocks[0].body).toContain("resume review platform");
    expect(blocks[0].body).toContain("responsive interfaces");
    expect(blocks[1].headerLines).toContain("Ledger Ingest Toolkit");
    expect(blocks[1].headerLines).toContain("Java, Spring Boot, Kafka");
    expect(blocks[1].body).toContain("distributed-systems teaching harness");
    expect(blocks[1].body).toContain("Redis-backed caching patterns");
  });

  it("parses an optional date off a project header when present", () => {
    const blocks = parseEntryBlocks(
      section([
        { text: "Resume Linter  2024 - 2025" },
        { text: "• Built the heuristic cascade." },
      ]),
      { anchor: "first_line", collectBody: true },
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0].dates.start_date).toBeTruthy();
    expect(blocks[0].headerLines.some((h) => /\d{4}/.test(h))).toBe(false);
  });

  // #283 false-positive guard: a legit project/role header that CONTAINS the
  // word "Resume"/"CV" AND a pipe/mid-dot separator (a common "Name | Stack" or
  // "Title · Company" shape) must NOT be mistaken for a "Name · Résumé N"
  // footer and silently stripped — that dropped the whole entry. The positional
  // guard now requires the separator ADJACENT to the résumé/CV keyword, which
  // this header does not have ("Resume" is not next to the "|").
  it("keeps a legit 'Resume Parser | Stack  <dates>' header — not footer furniture (#283)", () => {
    const blocks = parseEntryBlocks(
      section([
        { text: "Resume Parser | Python, React  Jan 2024 - Present" },
        { text: "• Built a browser-side PDF extraction cascade." },
      ]),
      { anchor: "first_line", collectBody: true },
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0].headerLines.some((h) => h.includes("Resume Parser"))).toBe(
      true,
    );
    expect(blocks[0].body).toContain("extraction cascade");
  });

  // #286 review: the positional tell must be ADJACENT to the résumé/CV keyword.
  // A real bullet that merely mentions our own domain ("resume") AND happens to
  // carry an "N of M" ratio must NOT be stripped as furniture — the bare
  // "N of M" / "page N" alternatives were dropped so this bullet survives.
  it("keeps a real bullet mentioning 'resume' + an 'N of M' ratio (#286 review)", () => {
    const blocks = parseEntryBlocks(
      section([
        { text: "Resume Linter" },
        { text: "• Rebuilt the resume parser, improving 3 of 5 core metrics." },
      ]),
      { anchor: "first_line", collectBody: true },
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0].body).toContain("3 of 5 core metrics");
  });

  it("still strips a real 'Name · Résumé N' footer that lands mid-section (#283)", () => {
    const blocks = parseEntryBlocks(
      section([
        { text: "June 3, 2026  Jane Smith · Résumé 1" }, // footer — stripped
        { text: "Trip Planner" },
        { text: "• Added the itinerary view." },
      ]),
      { anchor: "first_line", collectBody: true },
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0].headerLines).toContain("Trip Planner");
    for (const b of blocks) {
      expect(b.headerLines.join(" ")).not.toContain("Résumé");
      expect(b.headerLines.join(" ")).not.toContain("Jane Smith");
    }
  });

  // x-aware builder: a long bullet wraps onto a marker-less second line that
  // aligns with the bullet *text* (indented past the header margin).
  function sectionX(lines: Array<{ text: string; x: number }>): PdfSection {
    return {
      name: "projects",
      lines: lines.map((l, i) => ({
        page: 1,
        y: 72 + i * 14,
        x: l.x,
        items: [],
        text: l.text,
        maxFontSize: 11,
        allCaps: false,
    gapAbove: 0,
      })),
    };
  }

  it("splits a flat bullet list (awards) into one entry per top-level bullet (#131)", () => {
    // An achievements/awards section where every item is itself a bullet — there
    // is no non-bullet header line for the first_line anchor to latch onto. Each
    // bullet must become its own entry, with a marker-less year line below it
    // (a wrapped tail at x=54 > the bullet margin x=48) folding into that entry.
    const blocks = parseEntryBlocks(
      sectionX([
        { text: "• Globex Engineering Excellence,", x: 48 },
        { text: "2021", x: 54 },
        { text: "• Acme Innovation Prize, 2023", x: 48 },
      ]),
      { anchor: "first_line", collectBody: true },
    );
    expect(blocks).toHaveLength(2);
    expect(blocks[0].headerLines).toEqual(["Globex Engineering Excellence"]);
    expect(blocks[0].dates.start_date).toBe("2021");
    expect(blocks[1].headerLines).toEqual(["Acme Innovation Prize"]);
    expect(blocks[1].dates.start_date).toBe("2023");
  });

  it("keeps a deeper sub-bullet as the entry body, not a new entry (#131)", () => {
    // A top-level award bullet (x=48) with a deeper-indented detail bullet
    // (x=72) under it: the sub-bullet is the body of that one award, not a
    // second entry.
    const blocks = parseEntryBlocks(
      sectionX([
        { text: "• Employee of the Year, 2024", x: 48 },
        { text: "• Recognized for cross-team leadership.", x: 72 },
        { text: "• Best Demo Award, 2023", x: 48 },
      ]),
      { anchor: "first_line", collectBody: true },
    );
    expect(blocks).toHaveLength(2);
    expect(blocks[0].headerLines).toEqual(["Employee of the Year"]);
    expect(blocks[0].body).toContain("cross-team leadership");
    expect(blocks[0].bulletCount).toBe(1);
    expect(blocks[1].headerLines).toEqual(["Best Demo Award"]);
  });

  it("keeps a sub-bullet's wrapped tail in the body, not the title (#131)", () => {
    // A deeper sub-bullet (x=72) whose text wraps onto a marker-less line (x=80):
    // that tail must join its sub-bullet in the body, not fold into the award
    // title. (A marker-less line is only a title continuation before the first
    // sub-bullet — the year case in the test above.)
    const blocks = parseEntryBlocks(
      sectionX([
        { text: "• Employee of the Year, 2024", x: 48 },
        { text: "• Recognized for sustained cross-team", x: 72 },
        { text: "leadership and mentorship", x: 80 }, // wrapped tail of sub-bullet
        { text: "• Best Demo Award, 2023", x: 48 },
      ]),
      { anchor: "first_line", collectBody: true },
    );
    expect(blocks).toHaveLength(2);
    expect(blocks[0].headerLines).toEqual(["Employee of the Year"]);
    expect(blocks[0].bulletCount).toBe(1);
    expect(blocks[0].body).toContain("cross-team leadership and mentorship");
    expect(blocks[0].body).not.toContain("\n"); // single logical bullet, tail joined
  });

  it("treats an indented wrapped-bullet line as a continuation, not a new entry", () => {
    // Headers sit at the section margin (x=50); the bullet text (and thus a
    // wrapped continuation of it) is indented to x=73. The two wrap lines must
    // not open phantom entries, and the real header that follows a wrap must
    // still be recovered (it would be lost by a naive "prev is a bullet" rule).
    const blocks = parseEntryBlocks(
      sectionX([
        { text: "Revenue Forecasting Project", x: 50 },
        { text: "● Used five forecasting methods, and", x: 64 },
        { text: "TAF on deseasonalized revenue data", x: 73 }, // wrap
        { text: "● Identified the most suitable method among all", x: 64 },
        { text: "methods", x: 73 }, // wrap
        { text: "Global Entry Strategy Project", x: 50 }, // real header after wrap
        { text: "● Evaluated market potential", x: 64 },
      ]),
      { anchor: "first_line", collectBody: true },
    );
    expect(blocks.map((b) => b.headerLines[0])).toEqual([
      "Revenue Forecasting Project",
      "Global Entry Strategy Project",
    ]);
  });
});

describe("mergeWrappedContinuations (#162)", () => {
  // x-aware line builder: text + left-x, document-ordered y. Mirrors the real
  // PdfLine geometry the merge keys on (the bullet marker margin vs. the wrapped
  // bullet-text indent).
  function lines(rows: Array<{ text: string; x: number }>): PdfLine[] {
    return rows.map((r, i) => ({
      page: 1,
      y: 72 + i * 14,
      x: r.x,
      items: [],
      text: r.text,
      maxFontSize: 11,
      allCaps: false,
    gapAbove: 0,
    }));
  }

  it("returns the array unchanged for an empty section", () => {
    expect(mergeWrappedContinuations([])).toEqual([]);
  });

  it("folds a marker-less continuation (indented past the marker) into its bullet", () => {
    // Marker at x=81; the wrapped tail at x=90 aligns with the bullet TEXT, so
    // it folds onto the bullet rather than surviving as a standalone (and thus
    // marker-less, droppable) line.
    const merged = mergeWrappedContinuations(
      lines([
        { text: "Project A", x: 70 },
        { text: "● Collected revenue using 10-K and 10-Q filings", x: 81 },
        { text: "across several reporting periods", x: 90 }, // wrap
        { text: "● Used five forecasting methods including MA3", x: 81 },
        { text: "on deseasonalized revenue data", x: 90 }, // wrap
      ]),
    );
    expect(merged.map((l) => l.text)).toEqual([
      "Project A",
      "● Collected revenue using 10-K and 10-Q filings across several reporting periods",
      "● Used five forecasting methods including MA3 on deseasonalized revenue data",
    ]);
    // Items from both physical lines are carried onto the merged line.
    expect(merged.map((l) => l.x)).toEqual([70, 81, 81]); // anchor x preserved
  });

  it("does NOT fold header / non-continuation lines at or left of the marker margin", () => {
    // Headers (x≤marker) and a fresh bullet are continuations of nothing — they
    // must each stay their own line so titles and new bullets are preserved.
    const merged = mergeWrappedContinuations(
      lines([
        { text: "Revenue Forecasting Project", x: 70 },
        { text: "● First bullet that does not wrap", x: 81 },
        { text: "Global Entry Strategy Project", x: 70 }, // real header, not a wrap
        { text: "● Second bullet", x: 81 },
      ]),
    );
    expect(merged.map((l) => l.text)).toEqual([
      "Revenue Forecasting Project",
      "● First bullet that does not wrap",
      "Global Entry Strategy Project",
      "● Second bullet",
    ]);
  });

  it("is a no-op for a markerless section (markerX = Infinity)", () => {
    // No bullet glyph anywhere → no marker margin → nothing folds, even though
    // the lines carry distinct x. Profile / education-degree blocks rely on this
    // so paragraph-spaced header lines are never collapsed into one another.
    const rows = [
      { text: "Jane Smith", x: 253 },
      { text: "San Jose, CA", x: 276 },
      { text: "(312) 555-0123 | jane.smith@example.com", x: 125 },
    ];
    const merged = mergeWrappedContinuations(lines(rows));
    expect(merged.map((l) => l.text)).toEqual(rows.map((r) => r.text));
  });
});

describe("parseEntryBlocks — wrapped multi-line role header (#166)", () => {
  it("reassembles a 3-line wrapped header (org tail + date-year wrap) into one dated block", () => {
    // The Docent shape from
    // google-docs-skia-proxy-multiline-bullets-coursework.pdf: the org name and
    // the closing date year each wrap onto a second physical row — the org tail
    // ("Museum") to the left margin, the date tail ("2024") to the far right.
    const section = xSection("experience", [
      {
        text: "Docent, Library Collections Assistant | Community Heritage May 2023 - June",
        x: 70.5,
      },
      { text: "Museum", x: 70.5 }, // left-column org tail
      { text: "2024", x: 438 }, // right-column date tail
      { text: "● Represented and promoted the museum at community events.", x: 81 },
      { text: "● Conducted tours for museum guests.", x: 81 },
    ]);
    const blocks = parseEntryBlocks(section, {
      anchor: "date_range",
      collectBody: true,
      headerLookback: 2,
    });
    expect(blocks).toHaveLength(1);
    const [b] = blocks;
    // Date range reassembled across the wrap: "May 2023 - June" + "2024".
    expect(b.dates.start_date).toBe("May 2023");
    expect(b.dates.end_date).toBe("June 2024");
    // Org tail folded back: "Community Heritage" + "Museum".
    expect(b.headerLines.join(" ")).toContain("Community Heritage Museum");
    // Both bullets attribute to the role (no longer stranded in "Other").
    expect(b.bulletCount).toBe(2);
  });

  it("does not fold a complete single-line header (no regression on the common shape)", () => {
    // A "Company Dates / Title / bullets" stack already carries a full range on
    // the anchor line; the fold's complete-range gate must leave it untouched so
    // the title stays a separate header line rather than collapsing into the date.
    const section = xSection("experience", [
      { text: "Acme Corp  Jan 2020 - Dec 2021", x: 70 },
      { text: "Senior Engineer", x: 70 },
      { text: "● Shipped the billing service.", x: 81 },
    ]);
    const blocks = parseEntryBlocks(section, {
      anchor: "date_range",
      collectBody: true,
      headerLookback: 2,
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0].dates.start_date).toBe("Jan 2020");
    expect(blocks[0].dates.end_date).toBe("Dec 2021");
    expect(blocks[0].headerLines).toContain("Senior Engineer");
  });

  it("folds a COMPLETE-range one-line header whose org tail wrapped indented (#436)", () => {
    // The reconstructed "Download PDF" shape: the header carries the whole date
    // range on its first physical row, but its "· Company, Location" tail overran
    // the flush-right date column and word-wrapped onto the row below, INDENTED
    // past the bullet margin (the exporter's hanging indent). Left un-folded the
    // company re-parses truncated ("Danggeun Pay Inc. (KarrotPay)" → the tail is
    // stranded). `tryFoldCompleteDateHeader` re-inserts the tail before the date
    // region, reconstructing the one-line header so the full company survives.
    const section = xSection("experience", [
      { text: "Founding Engineer, Team Lead · Mar 2021 - Jun 2023", x: 70 },
      { text: "Danggeun Pay Inc. (KarrotPay), Seoul, S.Korea", x: 82 }, // indented tail
      { text: "● Built the payments platform.", x: 70 },
    ]);
    const blocks = parseEntryBlocks(section, {
      anchor: "date_range",
      collectBody: true,
      headerLookback: 2,
    });
    expect(blocks).toHaveLength(1);
    const [b] = blocks;
    // Full company preserved — no truncation to the parenthetical tail.
    expect(b.headerLines.join(" ")).toContain("Danggeun Pay Inc. (KarrotPay)");
    expect(b.dates.start_date).toBe("Mar 2021");
    expect(b.dates.end_date).toBe("Jun 2023");
    expect(b.bulletCount).toBe(1);
  });

  it("does not fold a complete-range header whose next line sits AT the margin (#342/#466)", () => {
    // Same complete-range header, but the company is on its OWN row at the SAME
    // left margin — a stacked second header line, not a wrapped tail. The indent
    // gate must leave it a distinct line so the anchor/title mapping still works.
    const section = xSection("experience", [
      { text: "Founding Engineer, Team Lead · Mar 2021 - Jun 2023", x: 70 },
      { text: "Danggeun Pay Inc. (KarrotPay)", x: 70 }, // same margin — not a wrap
      { text: "● Built the payments platform.", x: 70 },
    ]);
    const blocks = parseEntryBlocks(section, {
      anchor: "date_range",
      collectBody: true,
      headerLookback: 2,
    });
    expect(blocks).toHaveLength(1);
    // The company line stays a separate header line (not folded into the date row).
    expect(blocks[0].headerLines).toContain("Danggeun Pay Inc. (KarrotPay)");
  });

  it("reassembles a wrapped open-ended range (date sep on the header, 'Present' wrapped)", () => {
    // "… Jan 2022 -" with "Present" wrapped onto its own line. `Present` reads as
    // a complete range on its own, so the gather must treat it as a wrapped tail
    // (not a new anchor) for the fold to close.
    const section = xSection("experience", [
      { text: "Lead Organizer | Mutual Aid Network Jan 2022 -", x: 70 },
      { text: "Present", x: 438 }, // right-column date tail
      { text: "● Coordinated 30+ volunteers across the city.", x: 81 },
    ]);
    const blocks = parseEntryBlocks(section, {
      anchor: "date_range",
      collectBody: true,
      headerLookback: 2,
    });
    expect(blocks).toHaveLength(1);
    expect(blocks[0].dates.start_date).toBe("Jan 2022");
    expect(blocks[0].dates.is_current).toBe(true);
    expect(blocks[0].headerLines.join(" ")).toContain("Mutual Aid Network");
    expect(blocks[0].bulletCount).toBe(1);
  });

  it("does not fold across a role boundary — a wrapped header followed by a complete next role", () => {
    // Back-to-back roles: the first wraps its date year; the second is a complete
    // single-line anchor. The gather must STOP at the second role (a new
    // standalone anchor), yielding two distinct entries — not one swallowed pair.
    const section = xSection("experience", [
      { text: "Docent | Community Heritage May 2023 - June", x: 70 },
      { text: "2024", x: 438 }, // wraps the first role's date
      { text: "● Led museum tours.", x: 81 },
      { text: "After School Counselor | Youth Center Sep 2021 - April 2022", x: 70 },
      { text: "● Ran the homework program.", x: 81 },
    ]);
    const blocks = parseEntryBlocks(section, {
      anchor: "date_range",
      collectBody: true,
      headerLookback: 2,
    });
    expect(blocks).toHaveLength(2);
    expect(blocks[0].dates.end_date).toBe("June 2024");
    expect(blocks[0].bulletCount).toBe(1);
    expect(blocks[1].dates.start_date).toBe("Sep 2021");
    expect(blocks[1].headerLines.join(" ")).toContain("Youth Center");
    expect(blocks[1].bulletCount).toBe(1);
  });

  it("leaves the rows untouched when the continuations do not complete a range", () => {
    // A dangling date start whose follow-on lines never supply a closing date:
    // the match gate must reject the fold and pass every line through unchanged,
    // so no spurious single-role block forms.
    const section = xSection("experience", [
      { text: "Volunteer Coordinator since May 2023", x: 70 },
      { text: "Local Community Center", x: 70 },
      { text: "● Organized weekend food drives.", x: 81 },
    ]);
    const blocks = parseEntryBlocks(section, {
      anchor: "date_range",
      collectBody: true,
      headerLookback: 2,
    });
    // No complete range anywhere → no date_range anchor → no entries.
    expect(blocks).toEqual([]);
  });
});

/** Build a section from explicit (text, x, y) rows — for two-column banded
 *  headers where left-column company/title and right-column location/date land
 *  on separate banded lines that share a visual row (same y). */
function xySection(
  rows: Array<{ text: string; x: number; y: number }>,
): PdfSection {
  const lines: PdfLine[] = rows.map(({ text, x, y }) => ({
    page: 1,
    y,
    x,
    items: [],
    text,
    maxFontSize: 11,
    allCaps: false,
    gapAbove: 0,
  }));
  return { name: "experience", lines };
}

describe("parseEntryBlocks — two-column banded header + placeholder dates (music_resume25)", () => {
  // Reproduces the structure that broke music_resume25.pdf: column banding
  // splits each header row by column, so the date anchor (right column) lands
  // last, separated from its left-column company/title by a banded location and
  // blank spacer lines — well past a lookback of 2. Plus the dates are unfilled
  // "Month Year" template placeholders. Synthetic persona per the PII policy.
  const section = xySection([
    { text: "Acme Opera", x: 36, y: 219 }, // company (left col, row 1)
    { text: "Production Intern", x: 36, y: 231 }, // title (left col, row 2)
    { text: "", x: 104, y: 219 }, // banded blank spacer
    { text: "", x: 115, y: 231 },
    { text: "Springfield, IL", x: 522, y: 219 }, // location (right col, row 1)
    { text: "Month Year - Present", x: 483, y: 231 }, // date anchor (right col, row 2)
    { text: "• Supported departmental ticketing during productions", x: 54, y: 245 },
    { text: "• Assisted with audio systems in the performance halls", x: 54, y: 258 },
    { text: "• Learned about current issues in the industry at seminars", x: 54, y: 272 },
    { text: "Beta Music Center", x: 36, y: 311 }, // next entry company
    { text: "Sales Associate", x: 36, y: 324 },
    { text: "", x: 172, y: 311 },
    { text: "", x: 133, y: 324 },
    { text: "Centerville, OH", x: 523, y: 311 },
    { text: "Month Year - Month Year", x: 463, y: 324 }, // placeholder-placeholder
    { text: "• Built relationships with customers to match products", x: 54, y: 337 },
  ]);
  const blocks = parseEntryBlocks(section, {
    anchor: "date_range",
    collectBody: true,
    headerLookback: 2,
  });

  it("splits both roles even though one has no real date at all", () => {
    expect(blocks).toHaveLength(2);
  });

  it("recovers company + title across the banded location/blank rows", () => {
    expect(blocks[0].headerLines).toEqual(["Acme Opera", "Production Intern"]);
    expect(blocks[1].headerLines).toEqual(["Beta Music Center", "Sales Associate"]);
  });

  it("drops the unfilled placeholder dates rather than recording them", () => {
    expect(blocks[0].dates).toEqual({});
    expect(blocks[1].dates).toEqual({});
  });

  it("does not let a bullet's 'current' word anchor a phantom role, and keeps every bullet with its role", () => {
    // "current issues" must not split the third bullet off as its own entry.
    expect(blocks[0].bulletCount).toBe(3);
    expect(blocks[0].body).toContain("current issues");
    // The next role's header must not leak into this role's description.
    expect(blocks[0].body).not.toContain("Beta Music Center");
    expect(blocks[1].bulletCount).toBe(1);
  });
});

describe("parseEntryBlocks — role-first glyph-less experience (#215)", () => {
  // The shape that orphaned bullets in #215: a role-first Google-Docs export
  // (Role title → Dates → Company–Location → bullets) whose bullets carry NO
  // leading glyph (plain paragraphs indented past the header margin). With no
  // marker, `bulletMarkerX` is Infinity and the marker-geometry body signal is
  // disabled, so the body never formed and every bullet leaked to "Other".
  // The fix derives the body indent from geometry instead (glyphlessBodyMarginX).
  // Header/date/company sit at the header margin (x=50); bullets indent to x=68.
  const section = xySection([
    { text: "Software Engineer", x: 50, y: 100 }, // role title (role-first: above date)
    { text: "Jan 2022 - Dec 2023", x: 50, y: 114 }, // date anchor at header margin
    { text: "Northwind Robotics, Springfield, IL", x: 50, y: 128 }, // company below date
    { text: "Scaled the ingestion pipeline to 4x throughput.", x: 68, y: 142 }, // glyph-less bullet
    { text: "Reduced p99 latency by 40% with a read cache.", x: 68, y: 156 }, // glyph-less bullet
    { text: "Product Manager", x: 50, y: 188 }, // next role
    { text: "Jun 2020 - Dec 2021", x: 50, y: 202 }, // next date anchor
    { text: "Initiated the roadmap planning program.", x: 68, y: 216 }, // next role's bullet
  ]);
  const blocks = parseEntryBlocks(section, {
    anchor: "date_range",
    collectBody: true,
    headerLookback: 2,
  });

  it("splits both role-first roles at their date anchors", () => {
    expect(blocks).toHaveLength(2);
  });

  it("keeps the role title and company in the header (not orphaned)", () => {
    expect(blocks[0].headerLines).toContain("Software Engineer");
    expect(blocks[0].headerLines.some((h) => h.includes("Northwind Robotics"))).toBe(
      true,
    );
    expect(blocks[0].headerLines.some((h) => /\d{4}/.test(h))).toBe(false); // dates stripped
  });

  it("attributes the glyph-less bullets to their role as distinct body units", () => {
    expect(blocks[0].bulletCount).toBe(2);
    expect(blocks[0].body).toContain("ingestion pipeline");
    expect(blocks[0].body).toContain("p99 latency");
    // The next role's header/bullet must not leak into this role's body.
    expect(blocks[0].body).not.toContain("Product Manager");
    expect(blocks[0].body).not.toContain("roadmap");
    expect(blocks[1].bulletCount).toBe(1);
  });

  it("does not let a blank spacer line between glyph-less bullets truncate the body", () => {
    // Regression: pdfjs / DOCX-to-PDF pipelines emit zero-width or space-only
    // items between bullets; `mergeItemText` trims them to "". A blank line at
    // the header margin must NOT end the body run (it satisfies neither bullet
    // nor glyph-less-body, so the indent-drop break would otherwise fire and
    // drop every bullet after it).
    const spaced = xySection([
      { text: "Software Engineer", x: 50, y: 100 },
      { text: "Jan 2022 - Dec 2023", x: 50, y: 114 },
      { text: "Northwind Robotics, Springfield, IL", x: 50, y: 128 },
      { text: "Scaled the ingestion pipeline to 4x throughput.", x: 68, y: 142 },
      { text: "", x: 50, y: 150 }, // blank spacer at header margin between bullets
      { text: "Reduced p99 latency by 40% with a read cache.", x: 68, y: 156 },
    ]);
    const [b] = parseEntryBlocks(spaced, {
      anchor: "date_range",
      collectBody: true,
      headerLookback: 2,
    });
    expect(b.bulletCount).toBe(2);
    expect(b.body).toContain("ingestion pipeline");
    expect(b.body).toContain("p99 latency");
  });
});
