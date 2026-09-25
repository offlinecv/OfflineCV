// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Fixture generator for #1021 — a single-column résumé whose role headers
 * span TWO lines, each with a right-aligned cell:
 *
 *   Company                                   City, ST
 *   Title                                     Date range
 *     • bullets …
 *
 * the shape a common arts/music résumé template emits. Pre-fix the parser kept
 * title + company but dropped the right-aligned location for every role.
 * DRAW ORDER MATTERS. Each row's RIGHT cell is drawn before its left cell.
 * Drawn left-then-right, pdfjs bridges the gap with one synthetic whitespace
 * item whose width spans it (the #891 tab-justified shape), and line assembly
 * keeps the row whole — a different, already-handled path. Drawn right-first,
 * the two cells stay separate items with a real gap between them, which is
 * what the source template's Word/Quartz export produces: line assembly cuts
 * the company row at the column gap and the location lands on its own line.
 *
 * Role 1 carries a REAL date range; roles 2–3 carry the template's
 * placeholder ranges ("Month Year - Present", "Month Year - Month Year"), so
 * the fixture pins both the location fix and the placeholder-date decision.
 *
 * SYNTHETIC PERSONA ONLY (repo is public; see tests/fixtures/pdfs/README.md):
 *   name  Rowan Ellery
 *   email rowan.ellery@example.com
 *   phone (404) 555-0142   ← real area code + 555 exchange + 0100-0199 subscriber
 *
 * Usage:  node scripts/fixtures/gen-two-line-role-header-right-location.mjs
 * Emits:  tests/fixtures/pdfs/unknown/two-line-role-header-right-location.pdf
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "../..");
const OUT_DIR = join(REPO_ROOT, "tests/fixtures/pdfs/unknown");
const OUT_FILE = join(OUT_DIR, "two-line-role-header-right-location.pdf");

const PAGE_W = 612;
const BODY = 10;
const NAME = 16;
const H2 = 12;
const MARGIN_X = 54;
const BULLET_X = 72;
const LINE_H = 15;
const BLACK = rgb(0, 0, 0);

const doc = await PDFDocument.create();
const page = doc.addPage([PAGE_W, 792]);
const font = await doc.embedFont(StandardFonts.Helvetica);
const bold = await doc.embedFont(StandardFonts.HelveticaBold);
const italic = await doc.embedFont(StandardFonts.HelveticaOblique);

let cursorY = 748;

function draw(text, { x = MARGIN_X, size = BODY, useFont = font } = {}) {
  page.drawText(text, { x, y: cursorY, size, font: useFont, color: BLACK });
}
function drawRight(text, { size = BODY, useFont = font } = {}) {
  const w = useFont.widthOfTextAtSize(text, size);
  draw(text, { x: PAGE_W - MARGIN_X - w, size, useFont });
}
function nextRow(pts = LINE_H) {
  cursorY -= pts;
}
function role(company, location, title, dates, bullets) {
  // Right cell drawn FIRST, then the left cell: see the docblock — this keeps
  // the two cells as separate pdfjs items with a real gap between them.
  drawRight(location);
  draw(company, { useFont: bold });
  nextRow();
  drawRight(dates);
  draw(title, { useFont: italic });
  nextRow();
  for (const b of bullets) {
    draw(`•  ${b}`, { x: BULLET_X });
    nextRow();
  }
  nextRow(6);
}

// ── Profile ─────────────────────────────────────────────────────────────────
draw("ROWAN ELLERY", { size: NAME, useFont: bold });
nextRow(NAME + 4);
draw("rowan.ellery@example.com  |  (404) 555-0142  |  Decatur, GA");
nextRow(LINE_H + 8);

// ── RELEVANT EXPERIENCE ─────────────────────────────────────────────────────
draw("RELEVANT EXPERIENCE", { size: H2, useFont: bold });
nextRow(H2 + 6);

// Role 1 — a REAL date range: location AND dates must both survive.
role("Riverbend Opera Company", "Atlanta, GA", "Production Intern", "Jun 2023 - Present", [
  "Supported set changeovers for four mainstage productions",
  "Maintained the rehearsal schedule for a 40-person company",
]);

// Role 2 — the template's placeholder range with a "Present" end.
role("Maple Street Music Camp", "Athens, GA", "Camp Counselor", "Month Year - Present", [
  "Led daily ensemble rehearsals for campers aged 10 to 14",
  "Coordinated the end-of-session showcase concert",
]);

// ── ADDITIONAL EXPERIENCE ───────────────────────────────────────────────────
draw("ADDITIONAL EXPERIENCE", { size: H2, useFont: bold });
nextRow(H2 + 6);

// Role 3 — the template's placeholder range with a placeholder end.
role("Lakeside Instrument Outlet", "Macon, GA", "Retail Sales Associate", "Month Year - Month Year", [
  "Advised customers on instrument rentals and repairs",
  "Reconciled daily register totals and weekly inventory counts",
]);

// ── EDUCATION ───────────────────────────────────────────────────────────────
draw("EDUCATION", { size: H2, useFont: bold });
nextRow(H2 + 6);
drawRight("May 2024");
draw("Bachelor of Music in Composition", { useFont: bold });
nextRow();
draw("Piedmont State University");

mkdirSync(OUT_DIR, { recursive: true });
const bytes = await doc.save();
writeFileSync(OUT_FILE, bytes);
console.log(`wrote ${OUT_FILE} (${bytes.length} bytes)`);
