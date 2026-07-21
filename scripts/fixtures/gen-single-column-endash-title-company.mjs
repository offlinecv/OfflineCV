// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Fixture generator for the en-dash Title↔Company separator defect — a
 * single-column résumé whose role headers are `Title – Company` joined by a
 * spaced EN-DASH (–, U+2013), the shape Word / Google-Docs single-column
 * exports emit. Pre-fix, `splitHeaderSegments` recognized the EM-DASH (—,
 * U+2014) as a Title/Company delimiter but NOT the en-dash, so the whole
 * header collapsed into the company slot and the title came back null.
 *
 * Everything is drawn as a SINGLE column so `detectColumnBoundaries` finds no
 * gutter (`triggers` == `[]`).
 *
 * SYNTHETIC PERSONA ONLY (repo is public; see tests/fixtures/pdfs/README.md):
 *   name  Dana Whitfield
 *   email dana.whitfield@example.com
 *   phone (312) 555-0142   ← real area code + 555 exchange + 0100-0199 subscriber
 *
 * Usage:  node scripts/fixtures/gen-single-column-endash-title-company.mjs
 * Emits:  tests/fixtures/pdfs/unknown/single-column-endash-title-company.pdf
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "../..");
const OUT_DIR = join(REPO_ROOT, "tests/fixtures/pdfs/unknown");
const OUT_FILE = join(OUT_DIR, "single-column-endash-title-company.pdf");

const BODY = 10;
const NAME = 16;
const H2 = 12;
const MARGIN_X = 54;
const LINE_H = 16;
const BLACK = rgb(0, 0, 0);

const doc = await PDFDocument.create();
const page = doc.addPage([612, 792]);
const font = await doc.embedFont(StandardFonts.Helvetica);
const bold = await doc.embedFont(StandardFonts.HelveticaBold);

let cursorY = 748;

function draw(text, { x = MARGIN_X, size = BODY, useFont = font } = {}) {
  page.drawText(text, { x, y: cursorY, size, font: useFont, color: BLACK });
}
function nextRow(pts = LINE_H) {
  cursorY -= pts;
}

// ── Profile ─────────────────────────────────────────────────────────────────
draw("DANA WHITFIELD", { size: NAME, useFont: bold });
nextRow(NAME + 4);
draw("dana.whitfield@example.com  |  (312) 555-0142  |  Austin, TX");
nextRow(LINE_H + 8);

// ── EXPERIENCE ──────────────────────────────────────────────────────────────
draw("Experience", { size: H2, useFont: bold });
nextRow(H2 + 6);

// Role 1 — "Title – Company" where the company carries a legal suffix ("LLC"),
// so `looksLikeCompany` matches the post-dash segment: exercises the
// company-suffix mapping path once the en-dash split fires.
draw("Software Engineer – Globex Systems LLC");
nextRow();
draw("Jul 2023 - Present");
nextRow();
draw("• Owned the billing platform serving 2M monthly transactions");
nextRow();
draw("• Cut p99 checkout latency 35 percent via a caching rewrite");
nextRow(LINE_H + 4);

// Role 2 — "Title – Company" with NO legal suffix on the employer, so mapping
// falls to the title-keyword tiebreak: the pre-dash segment is the title.
draw("Data Analyst – Initech Analytics");
nextRow();
draw("Jun 2021 - Jun 2023");
nextRow();
draw("• Built the executive KPI dashboard adopted org-wide");
nextRow();
draw("• Automated the weekly revenue report, saving 6 hours a week");
nextRow(LINE_H + 8);

// ── EDUCATION ───────────────────────────────────────────────────────────────
draw("Education", { size: H2, useFont: bold });
nextRow(H2 + 6);
draw("B.S. in Computer Science – Ridgemont State University");
nextRow();
draw("Aug 2017 - May 2021");

mkdirSync(OUT_DIR, { recursive: true });
const bytes = await doc.save();
writeFileSync(OUT_FILE, bytes);
console.log(`wrote ${OUT_FILE} (${bytes.length} bytes)`);
