// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Fixture generator for issue #355 — single-column label-rail résumé whose
 * section headers are UNRECOGNIZED by the pre-#355 parser because they are:
 *
 *   1. INLINE / leading-token headers — the section keyword is the LEADING token
 *      of a long merged content row that also carries the section's first entry
 *      (one physical line reads `Experience  Staff Engineer, Platform  Aug 2024
 *      - Present`; likewise `Education  B.S. …, State University  2013 - 2017`).
 *   2. A STACKED grid rail label — the Skills header split VERTICALLY across two
 *      rows, `Technical` (row 1 lead token) over `Skills` (row 2 lead token), as
 *      the left rail cell of a horizontal skills grid.
 *
 * Everything is drawn as a SINGLE column (body ink crosses the page centre) so
 * `detectColumnBoundaries` finds NO gutter — `triggers` must be `[]`. Each
 * logical cell is its own `drawText` call (its own pdfjs text item) so a rail
 * label aligns to an item boundary, while intra-row gaps stay < the 50pt
 * column-split threshold so each row survives as ONE `PdfLine`.
 *
 * SYNTHETIC PERSONA ONLY (repo is public; see tests/fixtures/pdfs/README.md):
 *   name  Jane Smith
 *   email jane.smith@example.com
 *   phone (312) 555-0123   ← real area code + 555 exchange + 0100–0199 subscriber
 *
 * Usage:  node scripts/fixtures/gen-label-rail.mjs
 * Emits:  tests/fixtures/pdfs/unknown/label-rail-inline-headers.pdf
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "../..");
const OUT_DIR = join(REPO_ROOT, "tests/fixtures/pdfs/unknown");
const OUT_FILE = join(OUT_DIR, "label-rail-inline-headers.pdf");

const BODY = 10; // body font size (pt)
const NAME = 16; // name font size (pt)
const MARGIN_X = 54; // left margin (the rail column)
const CELL_GAP = 24; // inter-cell gap (pt) — < 50 so a row stays one PdfLine
const LINE_H = 16; // baseline-to-baseline for body rows
const BLACK = rgb(0, 0, 0);

const doc = await PDFDocument.create();
const page = doc.addPage([612, 792]); // US Letter
const font = await doc.embedFont(StandardFonts.Helvetica);
const bold = await doc.embedFont(StandardFonts.HelveticaBold);

let cursorY = 748; // top-origin cursor, decremented per row (pt from bottom)

/** Draw a run of cells left-to-right at the current baseline, each its own
 *  text item, separated by `CELL_GAP` (< 50pt so line-grouping keeps them one
 *  PdfLine but as distinct items). `startX` defaults to the rail margin. */
function drawRow(cells, { size = BODY, useFont = font, startX = MARGIN_X } = {}) {
  let x = startX;
  for (const cell of cells) {
    page.drawText(cell, { x, y: cursorY, size, font: useFont, color: BLACK });
    x += useFont.widthOfTextAtSize(cell, size) + CELL_GAP;
  }
  cursorY -= LINE_H;
}

/** Vertical spacer. */
function gap(pts = LINE_H) {
  cursorY -= pts;
}

// ── Name + contact (profile block) ──────────────────────────────────────────
drawRow(["JANE SMITH"], { size: NAME, useFont: bold });
gap(4);
// One-item contact line: email + phone + location. hasContactShape() sees the
// email/phone and marks the end of the name block (seenContactInProfile), which
// un-suppresses the leading-token recognizer for the rows below.
drawRow(["jane.smith@example.com  |  (312) 555-0123  |  San Francisco, CA"]);
gap(10);

// ── Inline EXPERIENCE header (leading token) + role 1, then role 2 ──────────
// "Experience" is the leading item; the remainder ("Staff Engineer, Platform
// Aug 2024 - Present") is the role-1 header carrying the date range inline.
drawRow(["Experience", "Staff Engineer, Platform", "Aug 2024 - Present"], {
  startX: MARGIN_X,
});
drawRow(["• Led platform migration scaling to 10M requests per day"], {
  startX: MARGIN_X + 14,
});
drawRow(["• Reduced p99 latency 40 percent via a caching layer"], {
  startX: MARGIN_X + 14,
});
// Role 2 — a normal dated header row (title at the rail margin).
drawRow(["Senior Engineer, Backend", "Jun 2021 - Aug 2024"], { startX: MARGIN_X });
drawRow(["• Built an event pipeline processing 5M events per day"], {
  startX: MARGIN_X + 14,
});
drawRow(["• Mentored four junior engineers on system design"], {
  startX: MARGIN_X + 14,
});
gap(10);

// ── Stacked SKILLS rail label + horizontal grid ─────────────────────────────
// "Technical" over "Skills" as the left rail cell; grid values to the right on
// each row. Joined lead tokens ("Technical Skills") normalize to the skills
// alias. Grid gaps stay < 50pt so each row is one PdfLine.
drawRow(["Technical", "Java", "Python", "SQL", "Kafka"], { startX: MARGIN_X });
drawRow(["Skills", "Spring", "Spark", "React", "AWS"], { startX: MARGIN_X });
gap(10);

// ── Inline EDUCATION header (leading token) + degree entry ──────────────────
// "Education" is the leading item; the remainder carries the degree,
// institution, and attendance range inline.
drawRow(
  ["Education", "B.S. Computer Science, State University", "2013 - 2017"],
  { startX: MARGIN_X },
);

mkdirSync(OUT_DIR, { recursive: true });
const bytes = await doc.save();
writeFileSync(OUT_FILE, bytes);
console.log(`wrote ${OUT_FILE} (${bytes.length} bytes)`);
