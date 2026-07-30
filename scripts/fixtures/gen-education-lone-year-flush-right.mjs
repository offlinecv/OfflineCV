// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Fixture generator for the Education lone-graduation-year flush-right defect
 * (#618) — a résumé whose Education entries render a single completion year
 * (the common shape for certificates, bootcamps, and non-degree programs) with
 * the year drawn flush-right on the institution / program-title baseline,
 * exactly as Experience rows do and as an Education entry with a RANGE
 * (`2019 – 2023`) already did.
 *
 * Pre-fix, `isLoneDateRange` required two date anchors, so `ats-resume-model.ts`
 * fell through to the glued `[text, year].filter(Boolean).join("  ")` branch and
 * the year rendered jammed onto the institution/header line after a two-space
 * gap. `#618` extended `isLoneDateRange` with `{ allowSingle: true }` and
 * called it from the exporter's Education path (and the twin Experience path)
 * so a lone `(19|20)\d{2}` year gets the same flush-right slot a range does.
 *
 * The fixture has FOUR shapes, so any regression touches one of them:
 *   1. Degreed entry with a lone graduation year — the `subLineDate` case.
 *   2. Degree-less program (`isInlineDatedProgram`, #302) with a lone year —
 *      the `headerLineDate` case; the date must stay on the FIELD header so
 *      two degree-less entries re-parse as TWO, not one.
 *   3. A second degree-less program with a different lone year — the #302
 *      regression guard: entry count must be 2, not 1, on round-trip.
 *   4. A degreed entry with a RANGE (`2019 – 2023`) as an unchanged control:
 *      range behaviour must be byte-identical to `main`.
 *
 * Single column so `detectColumnBoundaries` finds no gutter (`triggers` == `[]`).
 *
 * SYNTHETIC PERSONA ONLY (repo is public; see tests/fixtures/pdfs/README.md):
 *   name  Rowan Beckett
 *   email rowan.beckett@example.com
 *   phone (415) 555-0142   ← real area code + 555 exchange + 0100-0199 subscriber
 *
 * Usage:  node scripts/fixtures/gen-education-lone-year-flush-right.mjs
 * Emits:  tests/fixtures/pdfs/unknown/education-lone-year-flush-right.pdf
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "../..");
const OUT_DIR = join(REPO_ROOT, "tests/fixtures/pdfs/unknown");
const OUT_FILE = join(OUT_DIR, "education-lone-year-flush-right.pdf");

const BODY = 10;
const NAME = 16;
const H2 = 12;
const MARGIN_X = 54;
const RIGHT_MARGIN = 54;
const PAGE_W = 612;
const LINE_H = 16;
const BLACK = rgb(0, 0, 0);

const doc = await PDFDocument.create();
const page = doc.addPage([PAGE_W, 792]);
const font = await doc.embedFont(StandardFonts.Helvetica);
const bold = await doc.embedFont(StandardFonts.HelveticaBold);

let cursorY = 748;

function draw(text, { x = MARGIN_X, size = BODY, useFont = font } = {}) {
  page.drawText(text, { x, y: cursorY, size, font: useFont, color: BLACK });
}
// Draw text right-aligned to the right margin — the flush-right date shape the
// exporter produces via `subLineDate` / `headerLineDate`.
function drawRight(text, { size = BODY, useFont = font } = {}) {
  const w = useFont.widthOfTextAtSize(text, size);
  page.drawText(text, {
    x: PAGE_W - RIGHT_MARGIN - w,
    y: cursorY,
    size,
    font: useFont,
    color: BLACK,
  });
}
function nextRow(pts = LINE_H) {
  cursorY -= pts;
}

// ── Profile ─────────────────────────────────────────────────────────────────
draw("ROWAN BECKETT", { size: NAME, useFont: bold });
nextRow(NAME + 4);
draw("rowan.beckett@example.com  |  (415) 555-0142  |  Austin, TX");
nextRow(LINE_H + 8);

// ── EXPERIENCE ──────────────────────────────────────────────────────────────
// A minimal Experience section keeps the completeness score realistic without
// touching the surface the fixture is about.
draw("Experience", { size: H2, useFont: bold });
nextRow(H2 + 6);
draw("Staff Engineer", { useFont: bold });
drawRight("Jan 2020 – Mar 2023");
nextRow();
draw("Globex Corporation");
nextRow();
draw("• Rebuilt the billing pipeline to cut latency by 40%.");
nextRow(LINE_H + 8);

// ── EDUCATION ───────────────────────────────────────────────────────────────
draw("Education", { size: H2, useFont: bold });
nextRow(H2 + 6);

// Shape 1 — DEGREED entry, LONE year on the institution sub-line (subLineDate).
draw("MS Data Science", { useFont: bold });
nextRow();
draw("Ridgemont State University");
drawRight("2023");
nextRow(LINE_H + 4);

// Shape 4 (control) — DEGREED entry, RANGE date (unchanged behaviour).
draw("BS Computer Science", { useFont: bold });
nextRow();
draw("Lakeside Institute of Technology");
drawRight("2015 – 2019");
nextRow(LINE_H + 4);

// Shape 2 — DEGREE-LESS program, LONE year on the FIELD HEADER (headerLineDate).
// The #302 inline-dated-program cue — the graduation date must stay on the
// header line so two degree-less entries re-parse as TWO, not one.
draw("Certificate Program in Applied Analytics", { useFont: bold });
drawRight("2022");
nextRow();
draw("Northwind Continuing Education");
nextRow(LINE_H + 4);

// Shape 3 — a SECOND degree-less program with a lone year.
// Adjacent to shape 2 so the #302 regression guard has teeth: 2 in ⇒ 2 out.
draw("Bootcamp in Full-Stack Web Development", { useFont: bold });
drawRight("2020");
nextRow();
draw("Meridian Coding Academy");

mkdirSync(OUT_DIR, { recursive: true });
const bytes = await doc.save();
writeFileSync(OUT_FILE, bytes);
console.log(`wrote ${OUT_FILE} (${bytes.length} bytes)`);
