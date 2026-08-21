// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * How the export chooses its geometry: the proportional type scale, the fit
 * ladder that picks a body size per résumé, and the contact line's own fit.
 *
 * Separate from the pagination contracts in `export-layout-contract.test.ts`,
 * which pin a size precisely so the fit pass cannot move it. This file is the
 * other half — it asserts that the pass moves it, and by how much.
 */

import { describe, expect, it } from "vitest";
import {
  REFERENCE_BODY_PT,
  makeTypeScale,
  renderAtsResumePdf,
} from "./render-ats-pdf.ts";
import type { AtsEntry, AtsResumeModel } from "./ats-resume-model.ts";

/** Body text sizes read off the drawn page, most-used first. */
async function drawnSizes(bytes: Uint8Array): Promise<number[]> {
  const pdfjs = await import("pdfjs-dist");
  const doc = await pdfjs.getDocument({
    data: bytes.slice(),
    useWorkerFetch: false,
    isEvalSupported: false,
    useSystemFonts: false,
  }).promise;
  const tally = new Map<number, number>();
  for (let p = 1; p <= doc.numPages; p++) {
    const content = await doc.getPage(p).then((pg) => pg.getTextContent());
    for (const it of content.items) {
      if (!("str" in it)) continue;
      const t = it as { str: string; transform: number[] };
      if (!t.str.trim()) continue;
      const size = Math.round(Math.hypot(t.transform[0], t.transform[1]) * 100) / 100;
      tally.set(size, (tally.get(size) ?? 0) + 1);
    }
  }
  return [...tally.entries()].sort((a, b) => b[1] - a[1]).map(([s]) => s);
}

/** Lines drawn on page 1 with their left edge and size, in top-down order. */
async function pageOneRows(
  bytes: Uint8Array,
): Promise<Array<{ x: number; size: number; text: string }>> {
  const pdfjs = await import("pdfjs-dist");
  const doc = await pdfjs.getDocument({
    data: bytes.slice(),
    useWorkerFetch: false,
    isEvalSupported: false,
    useSystemFonts: false,
  }).promise;
  const content = await doc.getPage(1).then((pg) => pg.getTextContent());
  const rows = new Map<number, { x: number; size: number; text: string }>();
  for (const it of content.items) {
    if (!("str" in it)) continue;
    const t = it as { str: string; transform: number[] };
    const y = Math.round(t.transform[5] * 2) / 2;
    const prev = rows.get(y);
    rows.set(y, {
      x: prev ? Math.min(prev.x, t.transform[4]) : t.transform[4],
      size: Math.round(Math.hypot(t.transform[0], t.transform[1]) * 100) / 100,
      text: (prev?.text ?? "") + t.str,
    });
  }
  return [...rows.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([, v]) => v)
    .filter((v) => v.text.trim());
}

/** Lines drawn on page 1, in top-down order. */
async function pageOneLines(bytes: Uint8Array): Promise<string[]> {
  const pdfjs = await import("pdfjs-dist");
  const doc = await pdfjs.getDocument({
    data: bytes.slice(),
    useWorkerFetch: false,
    isEvalSupported: false,
    useSystemFonts: false,
  }).promise;
  const content = await doc.getPage(1).then((pg) => pg.getTextContent());
  const rows = new Map<number, string>();
  for (const it of content.items) {
    if (!("str" in it)) continue;
    const t = it as { str: string; transform: number[] };
    const y = Math.round(t.transform[5] * 2) / 2;
    rows.set(y, (rows.get(y) ?? "") + t.str);
  }
  return [...rows.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([, text]) => text)
    .filter((t) => t.trim());
}

function entry(i: number, bulletWords: number): AtsEntry {
  return {
    headerLine: `Senior Staff Engineer ${i} · Northwind Systems`,
    subLine: `Bellevue, WA  Jan. 20${10 + i} – Dec. 20${11 + i}`,
    bullets: Array.from({ length: 3 }, (_, b) =>
      Array.from({ length: bulletWords }, (_, w) => `word${i}x${b}x${w}`).join(" "),
    ),
  } as AtsEntry;
}

function model(entries: number, bulletWords: number): AtsResumeModel {
  return {
    contact: { name: "Jordan Bennett", links: [] },
    sections: [
      {
        heading: "Experience",
        entries: Array.from({ length: entries }, (_, i) => entry(i, bulletWords)),
      },
    ],
  } as AtsResumeModel;
}

describe("proportional type scale", () => {
  it("reproduces the reference geometry exactly at the reference size", () => {
    // The whole scale is expressed at ONE size and multiplied, so this is the
    // check that the multiplication is identity where it must be — the layout
    // this engine drew before the fit pass existed.
    const t = makeTypeScale(REFERENCE_BODY_PT);
    expect(t.body).toBe(8.5);
    expect(t.name).toBe(18);
    expect(t.contact).toBe(9);
    expect(t.section).toBe(10);
    expect(t.header).toBe(9.5);
    expect(t.gapBeforeSection).toBe(7);
    expect(t.ruleHeight).toBe(2);
  });

  it("scales every size and gap by the same factor", () => {
    // Body-only scaling was measured and rejected: the gaps, rule and name block
    // are fixed overhead worth ~19% of the usable page, so leaving them at full
    // size costs about a third of the achievable shrink.
    const ref = makeTypeScale(REFERENCE_BODY_PT);
    const half = makeTypeScale(REFERENCE_BODY_PT / 2);
    for (const key of Object.keys(ref) as Array<keyof typeof ref>) {
      if (key === "bodyPt") continue;
      expect(half[key], `${key} did not halve`).toBeCloseTo(ref[key] / 2, 10);
    }
  });
});

/** The rungs `fitToPage` walks, descending — mirrored here so the ladder's
 *  contract can be asserted without exporting the array itself. */
const LADDER = [10, 9.5, 9, 8.5, 8] as const;

describe("fit ladder", () => {
  it("draws a short résumé at the top rung rather than a fixed small size", async () => {
    // The point of the ladder is NOT only to rescue a spilling résumé. A single
    // fixed size has to be small enough for the dense case, which leaves every
    // short résumé set several points below what a typographer would choose.
    const result = await renderAtsResumePdf(model(2, 8));
    expect(result.pages).toBe(1);
    expect(result.bodyPt).toBe(10);
    expect(await drawnSizes(result.bytes)).toContain(10);
  });

  it("rescues a résumé that spills at the top rung but fits lower down", async () => {
    const big = model(6, 22);
    const atTop = await renderAtsResumePdf(big, { bodyPt: 10 });
    expect(atTop.pages, "fixture must spill at the top rung or this is vacuous").toBeGreaterThan(1);

    const fitted = await renderAtsResumePdf(big);
    expect(fitted.pages).toBe(1);
    expect(fitted.bodyPt).toBeLessThan(10);
    expect(fitted.bodyPt).toBeGreaterThanOrEqual(8);
  });

  it("picks the LARGEST rung that achieves the fewest pages", async () => {
    // The general contract, asserted against the ladder itself rather than a
    // hand-computed answer — so it holds for a résumé too long to reach one page
    // as well as one that fits. Saving a page is worth type size whether the
    // saving is 2→1 or 4→3; being smaller for its own sake never is, which is
    // what makes the top rung the fallback when shrinking buys nothing.
    const huge = model(24, 28);
    const perRung = await Promise.all(
      LADDER.map(async (pt) => ({
        pt,
        pages: (await renderAtsResumePdf(huge, { bodyPt: pt })).pages,
      })),
    );
    const fewest = Math.min(...perRung.map((r) => r.pages));
    const expected = perRung.find((r) => r.pages === fewest)!.pt; // LADDER is descending

    expect(fewest, "fixture must not fit on one page or this is vacuous").toBeGreaterThan(1);
    const fitted = await renderAtsResumePdf(huge);
    expect(fitted.pages).toBe(fewest);
    expect(fitted.bodyPt).toBe(expected);
  });

  it("honours a pinned size and skips the pass entirely", async () => {
    const pinned = await renderAtsResumePdf(model(2, 8), { bodyPt: 8.5 });
    expect(pinned.bodyPt).toBe(8.5);
    expect(await drawnSizes(pinned.bytes)).toContain(8.5);
  });
});

describe("contact line", () => {
  it("holds one line at the top rung, shrinking itself rather than wrapping", async () => {
    // Regression guard, not a cosmetic one: the re-parse reads contact fields off
    // a single header line, so a wrapped contact line silently drops whichever
    // links land on the continuation. `latex/multi-degree-coursework.pdf` lost its
    // linkedin_url exactly this way the moment the fit pass could pick 10pt.
    //
    // The shrink is bounded (CONTACT_MIN_SIZE_RATIO), so a contact line longer
    // than this one still wraps — legibility wins over a guarantee that cannot
    // hold for arbitrary input. This fixture is the realistic worst case: full
    // email, phone, spelled-out location and two profile links.
    const withLongContact = {
      contact: {
        name: "Jordan Bennett",
        email: "jordan.bennett@example.com",
        phone: "(973) 555-0123",
        location: "Bellevue, Washington",
        links: ["example.com/in/jordan-bennett", "example.com/jbennett"],
      },
      sections: [{ heading: "Experience", entries: [entry(0, 8)] }],
    } as AtsResumeModel;

    const result = await renderAtsResumePdf(withLongContact);
    const lines = await pageOneLines(result.bytes);

    // Non-vacuity: the contact line really is long enough to be at risk.
    const contactLine = lines.find((l) => l.includes("jordan.bennett@example.com"));
    expect(contactLine).toBeDefined();
    // Every link on the ONE contact line — nothing pushed to a continuation.
    for (const link of withLongContact.contact.links) {
      expect(contactLine, `"${link}" left the contact line`).toContain(link);
    }
  });

  it("never strands a field, at any contact length", async () => {
    // Swept rather than pinned to one fixture. The contact block has two ways to
    // avoid a stranded field — shrink to one row, or break at a field boundary —
    // and which one applies is decided by a size comparison that lands on a
    // floating-point boundary for some inputs and not others. A single fixture
    // therefore proves very little; the length that shipped the orphaned link
    // was one nobody would have guessed. Every length must satisfy the same
    // contract: at most two rows, each a whole number of fields, links together.
    const failures: string[] = [];
    let shrank = false;
    for (let pad = 0; pad <= 18; pad++) {
      const links = [
        `example.com/in/jordan-bennett${"x".repeat(pad)}`,
        "example.com/jbennett",
      ];
      const full = {
        contact: {
          name: "Jordan Bennett",
          email: "jordan.bennett@example.com",
          phone: "(973) 555-0123",
          location: "Bellevue, WA",
          workAuthorization: "U.S. Citizen",
          links,
        },
        sections: [{ heading: "Experience", entries: [entry(0, 8)] }],
      } as AtsResumeModel;

      const rows = await pageOneRows(
        (await renderAtsResumePdf(full, { bodyPt: 10 })).bytes,
      );
      const contactRows = rows.filter((r) => r.text.includes("example.com"));
      const at = `pad=${pad}`;
      if (contactRows.length > 2) {
        failures.push(`${at}: ${contactRows.length} contact rows`);
        continue;
      }
      if (contactRows[0].size < makeTypeScale(10).contact) shrank = true;
      // Whole fields only — a row that ends on a separator was cut mid-list by
      // the word wrapper, which is exactly the orphan this guards.
      for (const row of contactRows) {
        if (row.text.trim().endsWith("•")) failures.push(`${at}: row ends on a separator`);
      }
      // Links together, wherever they landed.
      const withLinks = contactRows.filter((r) => links.some((l) => r.text.includes(l)));
      if (withLinks.length !== 1) failures.push(`${at}: links split across rows`);
    }
    expect(failures).toEqual([]);
    expect(shrank, "no length exercised the shrink path — the sweep is vacuous").toBe(true);
  });

  it("does not split a line the shrink can still hold, at the exact boundary", async () => {
    // The last length in the sweep above that fits one row — where the fitted
    // size lands within a rounding error of the content width. Without the shave
    // `fitToOneLine` applies, re-multiplying that size overshoots by one ulp, the
    // wrapper refuses the row, and this line splits in two for no reason: a row
    // of vertical space spent on a line that fits. Pinned separately because the
    // sweep's contract (nothing stranded) is satisfied by the split too — the
    // cost of getting this wrong is density, not correctness.
    const boundary = {
      contact: {
        name: "Jordan Bennett",
        email: "jordan.bennett@example.com",
        phone: "(973) 555-0123",
        location: "Bellevue, WA",
        workAuthorization: "U.S. Citizen",
        links: ["example.com/in/jordan-bennettxxxxxxxx", "example.com/jbennett"],
      },
      sections: [{ heading: "Experience", entries: [entry(0, 8)] }],
    } as AtsResumeModel;

    const rows = await pageOneRows(
      (await renderAtsResumePdf(boundary, { bodyPt: 10 })).bytes,
    );
    const contactRows = rows.filter((r) => r.text.includes("example.com"));
    expect(contactRows).toHaveLength(1);
    // Non-vacuity: it only fits because it shrank, and it shrank nearly to the
    // floor — this really is the boundary, not a line with room to spare.
    const full = makeTypeScale(10).contact;
    expect(contactRows[0].size).toBeLessThan(full);
    expect(contactRows[0].size).toBeLessThan(full * 0.81);
  });

  it("breaks a contact line too long for the floor at a field boundary, links together", async () => {
    // Past the readability floor the break is unavoidable, so it is taken at a
    // field boundary rather than wherever the word wrapper lands — the links
    // move down TOGETHER instead of one slug being stranded under a full row
    // with its separator dangling above it.
    const links = [
      "example.com/in/jordan-bennett-staff-software-engineer",
      "example.com/jbennett",
      "jordan-bennett-portfolio.example.com",
    ];
    const huge = {
      contact: {
        name: "Jordan Bennett",
        email: "jordan.bennett.hiring.inbox@long-domain-name.example.com",
        phone: "(973) 555-0123",
        location: "Bellevue, Washington, United States of America",
        workAuthorization: "U.S. Citizen",
        links,
      },
      sections: [{ heading: "Experience", entries: [entry(0, 8)] }],
    } as AtsResumeModel;

    const rows = await pageOneRows((await renderAtsResumePdf(huge)).bytes);
    const contactRows = rows.filter(
      (r) => r.text.includes("example.com") || r.text.includes("555-0123"),
    );
    // Non-vacuity: this really is past the floor, so it really did have to break.
    expect(contactRows.length, "fixture must not fit one row or this is vacuous").toBe(2);
    // Every link on the SECOND row, none stranded — the point of the boundary.
    for (const link of links) {
      expect(contactRows[1].text, `"${link}" is not on the links row`).toContain(link);
    }
    expect(contactRows[0].text).toContain("jordan.bennett.hiring.inbox@long-domain-name.example.com");
    // One block, one size.
    expect(contactRows[0].size).toBe(contactRows[1].size);
  });

  it("leaves a contact line that already fits at full size", async () => {
    const short = {
      contact: { name: "Jordan Bennett", email: "j@example.com", links: [] },
      sections: [{ heading: "Experience", entries: [entry(0, 8)] }],
    } as AtsResumeModel;
    const result = await renderAtsResumePdf(short);
    // 10pt rung → contact rides the unscaled 9/8.5 ratio off the body size.
    expect(await drawnSizes(result.bytes)).toContain(
      Math.round(makeTypeScale(10).contact * 100) / 100,
    );
  });
});

describe("bullet hanging indent", () => {
  it("starts a wrapped bullet's tail under the first line's TEXT, not past it", async () => {
    // The indent is the marker's own width, measured off the font, so the tail
    // aligns with the words it continues at every rung. It was a scale constant
    // (12pt at the reference size, ~14pt at the top rung) against a marker only
    // ~6pt wide, which drew every tail visibly further right than its own text.
    const long = {
      contact: { name: "Jordan Bennett", links: [] },
      sections: [
        {
          heading: "Experience",
          entries: [
            {
              headerLine: "Senior Staff Engineer · Northwind Systems",
              subLine: "Bellevue, WA  Jan. 2019 – Dec. 2023",
              bullets: [
                "Rebuilt the ingestion path so a batch that used to take most of a night " +
                  "finished inside the hour, which is long enough to wrap onto a second " +
                  "drawn line at any rung this ladder can pick.",
              ],
            },
          ],
        },
      ],
    } as unknown as AtsResumeModel;

    const rows = await pageOneRows((await renderAtsResumePdf(long)).bytes);
    const head = rows.findIndex((r) => r.text.startsWith("•"));
    // Non-vacuity: the bullet must actually have wrapped.
    expect(head, "no bullet row drawn").toBeGreaterThanOrEqual(0);
    expect(rows.length, "bullet did not wrap — the test is vacuous").toBeGreaterThan(head + 1);

    const marker = rows[head];
    const tail = rows[head + 1];
    // The tail's left edge is the marker row's left edge plus the marker width,
    // which is exactly where the marker row's own text starts.
    const markerWidth = tail.x - marker.x;
    expect(markerWidth).toBeGreaterThan(0);
    expect(markerWidth).toBeLessThan(marker.size); // "• " is well under one em
  });
});
