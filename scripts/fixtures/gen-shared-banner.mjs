// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Fixture generator for issue #382 — a single-column résumé where one employer
 * is named ONCE as a BANNER above a contiguous run of roles, and each role's own
 * header is a bare `Title, Team` line (the post-comma segment an internal
 * team/sub-org, NOT the employer):
 *
 *   Acme Corporation
 *     Staff Engineer, Platform Infrastructure     Aug 2024 - Present
 *     Senior Engineer, Payments Core              Jul 2022 - Aug 2024
 *     Engineer, Identity Services                 Aug 2020 - Jul 2022
 *
 * Pre-#382 the parser mislabeled the post-comma team as the company and never
 * attributed the shared employer to roles 2..N. Everything is drawn as a SINGLE
 * column (body ink crosses the page centre) so `detectColumnBoundaries` finds no
 * gutter — `triggers` must be `[]`.
 *
 * SYNTHETIC PERSONA ONLY (repo is public; see tests/fixtures/pdfs/README.md):
 *   name  Dana Rivera
 *   email dana.rivera@example.com
 *   phone (512) 555-0142   ← real area code + 555 exchange + 0100-0199 subscriber
 *
 * Usage:  node scripts/fixtures/gen-shared-banner.mjs
 * Emits:  tests/fixtures/pdfs/unknown/shared-employer-banner-roles.pdf
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "../..");
const OUT_DIR = join(REPO_ROOT, "tests/fixtures/pdfs/unknown");
const OUT_FILE = join(OUT_DIR, "shared-employer-banner-roles.pdf");

const BODY = 10; // body font size (pt)
const NAME = 16; // name font size (pt)
const H2 = 12; // section header font size (pt)
const MARGIN_X = 54; // left margin
const ROLE_INDENT = 14; // roles sit indented under the employer banner
const DATE_X = 430; // right-hand date column
const LINE_H = 16; // baseline-to-baseline for body rows
const BLACK = rgb(0, 0, 0);

const doc = await PDFDocument.create();
const page = doc.addPage([612, 792]); // US Letter
const font = await doc.embedFont(StandardFonts.Helvetica);
const bold = await doc.embedFont(StandardFonts.HelveticaBold);

let cursorY = 748; // top-origin cursor, decremented per row (pt from bottom)

/** Draw one text run at (x, cursorY) without advancing the cursor. */
function draw(text, { x = MARGIN_X, size = BODY, useFont = font } = {}) {
  page.drawText(text, { x, y: cursorY, size, font: useFont, color: BLACK });
}

/** Advance to the next row. */
function nextRow(pts = LINE_H) {
  cursorY -= pts;
}

/** A dated header row: left cell (title/company) at `x`, dates right-aligned in
 *  the date column, on ONE baseline so they group into one PdfLine. */
function drawDatedRow(left, dates, { x = MARGIN_X, useFont = font } = {}) {
  draw(left, { x, useFont });
  draw(dates, { x: DATE_X });
  nextRow();
}

// ── Name + contact (profile block) ──────────────────────────────────────────
draw("DANA RIVERA", { size: NAME, useFont: bold });
nextRow(NAME + 4);
draw("dana.rivera@example.com  |  (512) 555-0142  |  Austin, TX");
nextRow(LINE_H + 8);

// ── EXPERIENCE ──────────────────────────────────────────────────────────────
draw("Experience", { size: H2, useFont: bold });
nextRow(H2 + 6);

// Employer BANNER — one dateless line above the run of roles.
draw("Acme Corporation", { useFont: bold });
nextRow();

// Role 1 — "Title, Team" indented under the banner.
drawDatedRow("Staff Engineer, Platform Infrastructure", "Aug 2024 - Present", {
  x: MARGIN_X + ROLE_INDENT,
});
draw("• Led reliability engineering across the platform org", {
  x: MARGIN_X + ROLE_INDENT + 12,
});
nextRow();
draw("• Cut p99 latency 35 percent with a new caching tier", {
  x: MARGIN_X + ROLE_INDENT + 12,
});
nextRow(LINE_H + 4);

// Role 2 — "Title, Team", same banner.
drawDatedRow("Senior Engineer, Payments Core", "Jul 2022 - Aug 2024", {
  x: MARGIN_X + ROLE_INDENT,
});
draw("• Built the payment settlement rails handling 4M transactions daily", {
  x: MARGIN_X + ROLE_INDENT + 12,
});
nextRow();
draw("• Migrated the ledger to an event-sourced design", {
  x: MARGIN_X + ROLE_INDENT + 12,
});
nextRow(LINE_H + 4);

// Role 3 — "Title, Team", same banner.
drawDatedRow("Engineer, Identity Services", "Aug 2020 - Jul 2022", {
  x: MARGIN_X + ROLE_INDENT,
});
draw("• Shipped the single sign-on flow used by 2M accounts", {
  x: MARGIN_X + ROLE_INDENT + 12,
});
nextRow();
draw("• Reduced auth error rate from 2.1 percent to 0.3 percent", {
  x: MARGIN_X + ROLE_INDENT + 12,
});
nextRow(LINE_H + 8);

// ── EDUCATION ───────────────────────────────────────────────────────────────
draw("Education", { size: H2, useFont: bold });
nextRow(H2 + 6);
drawDatedRow("B.S. Computer Science, State University", "2012 - 2016");

mkdirSync(OUT_DIR, { recursive: true });
const bytes = await doc.save();
writeFileSync(OUT_FILE, bytes);
console.log(`wrote ${OUT_FILE} (${bytes.length} bytes)`);
