// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Fixture generator for the `section-routing` defect class fixed by #820 — a
 * single-column résumé that draws each section rule as a run of underscores on
 * the SAME baseline as the header word, its own separate text item:
 *
 *   {"str":"Education", "x":72,      "y":122.359, ...}
 *   {"str":"_____…____","x":139.631, "y":122.359, ...}
 *
 * Line assembly correctly merges same-baseline items, so the header reaches
 * the router as one line (`Education__________…`). Pre-#820,
 * `matchSectionHeaderDetailed` stripped a trailing `[:·•]+` run and a LEADING
 * decorative glyph run (#414), but nothing stripped a TRAILING decorative rule
 * — so the exact-alias tier compared `education__________…` against
 * `education` and never matched. Every header in the document fails the same
 * way, no section ever opens, and the whole résumé lands in `profile`:
 * `experienceCount: 0`, `educationCount: 0`, `skillsCount: 0`, despite Tier 0
 * extraction and line assembly both being correct.
 *
 * The defect lives in the ITEM GEOMETRY, not the text — a fixture that baked
 * `Education____` as a single item would reproduce the matcher failure but not
 * the line-assembly step that produces it, so each rule is drawn as its own
 * `drawText` call at the header's `y`, mirroring the real export.
 *
 * Everything is drawn as a SINGLE column so `detectColumnBoundaries` finds no
 * gutter (`triggers` == `[]`) and the defect is not confounded with a layout
 * one.
 *
 * SYNTHETIC PERSONA ONLY (repo is public; see tests/fixtures/pdfs/README.md):
 *   name  Marcus Delacroix
 *   email marcus.delacroix@example.com
 *   phone (312) 555-0171   ← real area code + 555 exchange + 0100-0199 subscriber
 *
 * Usage:  node scripts/fixtures/gen-underscore-rule-headers.mjs
 * Emits:  tests/fixtures/pdfs/google-docs/google-docs-skia-proxy-underscore-rule-headers.pdf
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "../..");
const OUT_DIR = join(REPO_ROOT, "tests/fixtures/pdfs/google-docs");
const OUT_FILE = join(
  OUT_DIR,
  "google-docs-skia-proxy-underscore-rule-headers.pdf",
);

const BODY = 10;
const NAME = 16;
const H2 = 13;
const MARGIN_X = 72;
const INDENT_X = 90;
const LINE_H = 16;
const RULE = "_".repeat(70);
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

/** Draw a header and its decorative rule as TWO separate text items sharing
 *  the header's baseline — the exact item geometry the source résumé draws,
 *  and the shape `groupIntoLines` merges into one line. */
function drawHeaderWithRule(text) {
  draw(text, { size: H2, useFont: bold });
  const width = bold.widthOfTextAtSize(text, H2);
  page.drawText(RULE, {
    x: MARGIN_X + width + 6,
    y: cursorY,
    size: H2 - 1,
    font,
    color: BLACK,
  });
  nextRow(H2 + 6);
}

// ── Profile ─────────────────────────────────────────────────────────────────
draw("MARCUS DELACROIX", { size: NAME, useFont: bold });
nextRow(NAME + 4);
draw("marcus.delacroix@example.com  |  (312) 555-0171  |  Denver, CO");
nextRow(LINE_H + 10);

// ── Experience ──────────────────────────────────────────────────────────────
drawHeaderWithRule("Experience");
draw("Senior Platform Engineer", { useFont: bold });
nextRow();
draw("Northbridge Analytics  |  Denver, CO");
nextRow();
draw("Apr 2021 - Present");
nextRow();
draw("• Rebuilt the deploy pipeline, cutting release time from 40 to 8 minutes", {
  x: INDENT_X,
});
nextRow();
draw("• Led the migration of 12 services onto the shared platform", {
  x: INDENT_X,
});
nextRow(LINE_H + 4);
draw("Platform Engineer", { useFont: bold });
nextRow();
draw("Ferrowatt Systems  |  Boulder, CO");
nextRow();
draw("Jul 2017 - Mar 2021");
nextRow();
draw("• Owned the on-call rotation for the ingest cluster", { x: INDENT_X });
nextRow(LINE_H + 10);

// ── Education ───────────────────────────────────────────────────────────────
drawHeaderWithRule("Education");
draw("B.S. in Computer Engineering", { useFont: bold });
nextRow();
draw("Ridgemont State University  |  Aug 2013 - May 2017");

mkdirSync(OUT_DIR, { recursive: true });
const bytes = await doc.save();
writeFileSync(OUT_FILE, bytes);
console.log(`wrote ${OUT_FILE} (${bytes.length} bytes)`);
