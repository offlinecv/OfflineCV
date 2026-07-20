// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Fixture generator for issue #467 — a single-column student résumé whose
 * section headers carry `<QUALIFIER> EXPERIENCE` forms
 * ("RELEVANT EXPERIENCE", "INVOLVEMENT EXPERIENCE") and a `RELEVANT COURSEWORK`
 * header that pre-#467 pooled its body into the education region, letting the
 * education chunker fabricate a phantom degree entry off a comma-fragment
 * ", Certificate, Music Business".
 *
 * The qualified `EXPERIENCE` headers are already routed by the anchor-fallback
 * tier (last token in `experience.anchors`), so #467's primary contribution
 * for this shape is the education entry-boundary guard (shared with #462),
 * ensuring no phantom entry is fabricated from a coursework body sentence
 * that happens to carry the `Certificate` word.
 *
 * SYNTHETIC PERSONA ONLY (repo is public; see tests/fixtures/pdfs/README.md):
 *   name  Morgan Lee
 *   email morgan.lee@example.com
 *   phone (312) 555-0182
 *
 * Usage:  node scripts/fixtures/gen-qualified-experience-coursework.mjs
 * Emits:  tests/fixtures/pdfs/unknown/qualified-experience-relevant-coursework.pdf
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "../..");
const OUT_DIR = join(REPO_ROOT, "tests/fixtures/pdfs/unknown");
const OUT_FILE = join(OUT_DIR, "qualified-experience-relevant-coursework.pdf");

const BODY = 10;
const NAME = 16;
const H2 = 12;
const MARGIN_X = 54;
const DATE_X = 430;
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
function drawDatedRow(left, dates, { x = MARGIN_X, useFont = font } = {}) {
  draw(left, { x, useFont });
  draw(dates, { x: DATE_X });
  nextRow();
}

// ── Profile ─────────────────────────────────────────────────────────────────
draw("MORGAN LEE", { size: NAME, useFont: bold });
nextRow(NAME + 4);
draw("morgan.lee@example.com  |  (312) 555-0182  |  Springfield, IL");
nextRow(LINE_H + 8);

// ── EDUCATION ───────────────────────────────────────────────────────────────
draw("Education", { size: H2, useFont: bold });
nextRow(H2 + 6);
draw("Ridgemont University");
nextRow();
draw("Bachelor of Music, Music Composition");
nextRow();
draw("| Certificate, Music Business");
nextRow();
draw("Expected Graduation: May 2027");
nextRow(LINE_H + 4);

// ── RELEVANT COURSEWORK (was pre-#462/#467 mis-routed to education) ────────
draw("Relevant Coursework", { size: H2, useFont: bold });
nextRow(H2 + 6);
draw("Electroacoustic Composition, Instrumentation, Tonal Counterpoint");
nextRow(LINE_H + 4);

// ── RELEVANT EXPERIENCE (already routed via anchor-fallback) ───────────────
draw("Relevant Experience", { size: H2, useFont: bold });
nextRow(H2 + 6);
draw("Fabrikam Opera");
nextRow();
drawDatedRow("Production Intern", "Jun 2024 - Present");
draw("• Supported departmental assignments across three productions");
nextRow(LINE_H + 4);

// ── INVOLVEMENT EXPERIENCE (also anchor-fallback routed) ───────────────────
draw("Involvement Experience", { size: H2, useFont: bold });
nextRow(H2 + 6);
draw("Contoso Composers Circle");
nextRow();
drawDatedRow("Founding Member", "Aug 2022 - Present");
draw("• Created work ranging from symphonic to electronic music");
nextRow();
draw("Northwind Youth Music Program");
nextRow();
drawDatedRow("Music Educator", "Jan 2023 - May 2023");
draw("• Aided musicians in local public schools");

mkdirSync(OUT_DIR, { recursive: true });
const bytes = await doc.save();
writeFileSync(OUT_FILE, bytes);
console.log(`wrote ${OUT_FILE} (${bytes.length} bytes)`);
