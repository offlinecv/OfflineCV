// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Fixture generator for issue #355 — the SEPARATED label-rail résumé that the
 * first #355 fix (923ad0a) still mis-parsed. Distinct from the sibling
 * `gen-label-rail.mjs` (whose rail label shares a row with its content): here
 * the section keywords sit in a NARROW LEFT RAIL (x ≈ 26) while ALL body content
 * — the skills grid, role headers, bullets — sits well to the right (x ≥ 110).
 *
 * The killer detail this reproduces (why `tryStackedRailLabel` failed): the
 * skills grid has IRREGULAR per-cell baselines, so pdfjs emits ~one text line
 * per cell and a stray single cell sits BETWEEN the two stacked label rows
 * ("Technical" over "Skills"). The old recognizer needed the two label rows to
 * be consecutive clean grid rows — both assumptions break here. The new
 * `splitByLabelRail` partitions by rail geometry + y-band instead.
 *
 * Also reproduced: role headers whose title (left) and date (far right) are one
 * visual row split by the 50pt column gap, and GLYPH-LESS indented bullets — the
 * exact shape that leaves `bullets=0` until the rail path reassembles each row.
 *
 * `detectColumnBoundaries` must find NO gutter (body ink crosses the page
 * centre) → single column, `triggers` == []. The rail is too narrow / low
 * coverage to register as a column.
 *
 * SYNTHETIC PERSONA ONLY (repo is public; see tests/fixtures/pdfs/README.md):
 *   name  Jordan Blake
 *   email jordan.blake@example.com
 *   phone (312) 555-0123   ← real area code + 555 exchange + 0100–0199 subscriber
 *
 * Usage:  node scripts/fixtures/gen-label-rail-grid.mjs
 * Emits:  tests/fixtures/pdfs/unknown/label-rail-grid-fragmented.pdf
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "../..");
const OUT_DIR = join(REPO_ROOT, "tests/fixtures/pdfs/unknown");
const OUT_FILE = join(OUT_DIR, "label-rail-grid-fragmented.pdf");

const BODY = 10; // body font size (pt)
const NAME = 16; // name font size (pt)
const RAIL_X = 26; // narrow rail column (name + section labels)
const BODY_X = 110; // body left margin (well right of the rail: gap ≈ 84pt)
const DATE_X = 470; // far-right date column
const BULLET_X = 124; // glyph-less bullets, indented past the body/header margin

const doc = await PDFDocument.create();
const page = doc.addPage([612, 792]); // US Letter
const H = 792;
const font = await doc.embedFont(StandardFonts.Helvetica);
const bold = await doc.embedFont(StandardFonts.HelveticaBold);

/** Draw one text run at a TOP-origin y (pt from the top edge). */
function put(text, topY, { x = BODY_X, size = BODY, useFont = font } = {}) {
  page.drawText(text, { x, y: H - topY, size, font: useFont, color: rgb(0, 0, 0) });
}

// ── Name + contact (profile block, in the rail) ─────────────────────────────
put("JORDAN BLAKE", 40, { x: RAIL_X, size: NAME, useFont: bold });
put("jordan.blake@example.com  |  (312) 555-0123  |  Austin, TX", 56, {
  x: RAIL_X,
});

// ── Stacked SKILLS rail label over a fragmented, irregular-baseline grid ─────
// "Technical" over "Skills" as the left rail cell; grid VALUE cells spread WIDE
// across the page (columns at x ≈ 150/270/370/470) with per-cell baseline
// jitter, so each cell fragments into its OWN PdfLine — and a stray single cell
// sits BETWEEN the two label rows. This is the exact shape that defeated the old
// consecutive-clean-grid-row recognizer (the label rows are no longer adjacent
// clean rows). Columns are far enough right of the rail label (gap > 50pt) that
// the label itself fragments off as its own line.
const T = 92; // Technical baseline (top-origin)
put("Technical", T, { x: RAIL_X, useFont: bold });
put("Java", T - 2, { x: 150 }); // sits a hair ABOVE the label baseline
put("Python", T - 1, { x: 270 });
put("SQL", T + 1, { x: 370 });
put("Kafka", T - 1, { x: 470 });
put("Spark", T + 6, { x: 200 }); // stray cell BETWEEN the two label rows
const S = T + 12; // Skills baseline
put("Skills", S, { x: RAIL_X, useFont: bold });
put("Spring Boot", S + 1, { x: 150 });
put("Scala", S - 1, { x: 270 });
put("React", S, { x: 370 });
put("AWS", S + 1, { x: 470 });

// ── Experience: rail label + two dated roles with glyph-less bullets ─────────
put("Experience", 150, { x: RAIL_X, useFont: bold });
// Role 1: title (left) + date (far right) on one visual row; company row below.
put("Staff Engineer, Platform", 150, { x: BODY_X });
put("Aug 2024 - Present", 150, { x: DATE_X });
put("Northwind Systems", 163, { x: BODY_X });
put("Remote", 163, { x: DATE_X });
put("Led the platform reliability program end-to-end, cutting Sev1 incidents by 60 percent", 178, { x: BULLET_X });
put("Scaled the request pipeline to 10 million requests per day across three regions", 191, { x: BULLET_X });
put("Mentored six engineers on distributed systems design and on-call practice", 204, { x: BULLET_X });
// Role 2.
put("Senior Engineer, Backend", 226, { x: BODY_X });
put("Jun 2021 - Aug 2024", 226, { x: DATE_X });
put("Globex Corporation", 239, { x: BODY_X });
put("Austin, TX", 239, { x: DATE_X });
put("Built an event-sourcing pipeline processing 5 million events per day", 254, { x: BULLET_X });
put("Reduced p99 latency 40 percent by introducing a tiered caching layer", 267, { x: BULLET_X });

// ── Education: inline rail label (keyword leads a merged row) ────────────────
put("Education", 300, { x: RAIL_X, useFont: bold });
put("B.S. Computer Science, State University", 300, { x: BODY_X });
put("2013 - 2017", 300, { x: DATE_X });
put("Minor in Mathematics", 313, { x: BODY_X });

mkdirSync(OUT_DIR, { recursive: true });
const bytes = await doc.save();
writeFileSync(OUT_FILE, bytes);
console.log(`wrote ${OUT_FILE} (${bytes.length} bytes)`);
