// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

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
import { parseEntryBlocks } from "./entry-blocks.ts";
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
      })),
    };
  }

  it("opens one entry per header run, not one per header line", () => {
    const blocks = parseEntryBlocks(
      section([
        { text: "Resume Linter" },
        { text: "A browser-side PDF parser audit." },
        { text: "• Built the heuristic cascade." },
        { text: "Trip Planner" },
        { text: "• Added the itinerary view." },
      ]),
      { anchor: "first_line", collectBody: true },
    );
    expect(blocks).toHaveLength(2);
    expect(blocks[0].headerLines).toContain("Resume Linter");
    // The non-bullet line right after the first header joins that header run,
    // it does not open a second entry.
    expect(blocks[0].headerLines).toContain("A browser-side PDF parser audit.");
    expect(blocks[0].body).toContain("heuristic cascade");
    expect(blocks[1].headerLines).toContain("Trip Planner");
    expect(blocks[1].body).toContain("itinerary view");
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
