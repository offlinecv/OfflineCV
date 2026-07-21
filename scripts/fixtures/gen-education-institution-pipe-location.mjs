// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Fixture generator for the education-institution trailing-separator defect — a
 * résumé whose EDUCATION entries put the institution and its city on one line
 * joined by a pipe: `Institution | City, ST`.
 *
 * `stripInstitutionLocation` (`extract/education.ts`) peels the `City, ST` tail
 * off the institution but leaves the dangling ` |` behind, so the parsed
 * `institution` came back as `<name> |`. On the Download-PDF round-trip that
 * trailing ` |` is dropped on re-parse, so `institution` changes across the
 * cycle (the round-trip invariant this fixture locks). A real institution never
 * ends in a bare separator, so stripping it is always safe.
 *
 * Single column so `detectColumnBoundaries` finds no gutter (`triggers` == `[]`).
 *
 * SYNTHETIC PERSONA ONLY (repo is public; see tests/fixtures/pdfs/README.md):
 *   name  Elena Voss
 *   email elena.voss@example.com
 *   phone (503) 555-0164   ← real area code + 555 exchange + 0100-0199 subscriber
 *
 * Usage:  node scripts/fixtures/gen-education-institution-pipe-location.mjs
 * Emits:  tests/fixtures/pdfs/unknown/education-institution-pipe-location.pdf
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "../..");
const OUT_DIR = join(REPO_ROOT, "tests/fixtures/pdfs/unknown");
const OUT_FILE = join(OUT_DIR, "education-institution-pipe-location.pdf");

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
draw("ELENA VOSS", { size: NAME, useFont: bold });
nextRow(NAME + 4);
draw("elena.voss@example.com  |  (503) 555-0164  |  Portland, OR");
nextRow(LINE_H + 8);

// ── EXPERIENCE ──────────────────────────────────────────────────────────────
draw("Experience", { size: H2, useFont: bold });
nextRow(H2 + 6);
draw("Software Engineer, Globex Corporation", { useFont: bold });
nextRow();
draw("Jul 2021 - Present");
nextRow();
draw("• Built the billing platform serving 2M monthly transactions");
nextRow(LINE_H + 8);

// ── EDUCATION ───────────────────────────────────────────────────────────────
// Two entries; each institution line joins the school and its city with a pipe
// ("Institution | City, ST") — the shape that left a dangling " |".
draw("Education", { size: H2, useFont: bold });
nextRow(H2 + 6);

// Institution header packs the school, a parenthetical, an inline pipe-delimited
// date range, and a trailing pipe on ONE line — the shape that glued
// "| <dates> |" into the parsed institution.
draw("Master of Science in Computer Science", { useFont: bold });
nextRow();
draw("Ridgemont State University (STEM) | 2019-2021 |");
nextRow(LINE_H + 2);

draw("Bachelor of Science in Computer Science", { useFont: bold });
nextRow();
draw("Lakeside Institute of Technology (Honors) | 2015-2019 |");

mkdirSync(OUT_DIR, { recursive: true });
const bytes = await doc.save();
writeFileSync(OUT_FILE, bytes);
console.log(`wrote ${OUT_FILE} (${bytes.length} bytes)`);
