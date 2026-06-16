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
import type { PdfSection } from "./sections.ts";

/** Build an experience section from line specs (the date_range anchor case). */
function experienceSection(
  specs: Array<{ text: string; fontSize?: number }>,
): PdfSection | undefined {
  const sections = splitIntoSections(groupIntoLines(mkItems(specs)));
  return findSection(sections, "experience");
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
});
