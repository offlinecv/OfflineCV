// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Fixture generator for the INSTITUTION-LED education entry (#882) — the
 * conventional shape the widely-copied résumé templates use, and the shape the
 * Download-PDF exporter emits from #882 onward:
 *
 *     MIT                                                     May 2024
 *     B.S., Computer Science, cum laude, GPA: 3.72/4.00
 *
 * The fixture exists because flipping the display order is NOT free on the
 * parser side, and the risk is invisible to a unit test built from
 * `ResumeEducation` literals. The education SEGMENTER opens a new entry on a
 * line that reads as an entry LEAD, and its two reliable cues are `DEGREE_RE`
 * and `INSTITUTION_HINTS` (`University|College|Institute|School|Academy|
 * Polytechnic`). Neither `MIT` nor `Georgia Tech` carries a hint word, so under
 * institution-first ordering the boundary between two entries falls on a line
 * the segmenter cannot see — and two entries silently re-parse as ONE (or worse,
 * split with the second school attributed to the first degree). That is the
 * exact entry-LOSS failure #302 was written to prevent, arriving through a new
 * door.
 *
 * So the proof this fixture carries is a COUNT: two education entries in, two
 * education entries out, on a real PDF, through the real cascade — not a
 * hand-built model. Both schools are deliberately hint-less.
 *
 * It also carries the second half of #882: every education date draws in the
 * flush-right date column, including shapes `isLoneDateRange` never admitted —
 * a lone MONTH-YEAR (`May 2024`), which is the single most common graduation
 * shape and the one that used to render glued two spaces after the institution.
 *
 * Shapes, so any regression touches one of them:
 *   1. An in-progress entry (`Sep 2022 – Present`) whose open end must survive
 *      as `is_current`, not collapse to a bare start date.
 *   2. Hint-less institution lead + degree sub-line + flush-right MONTH-YEAR.
 *   3. A third adjacent hint-less entry whose degree sub-line carries honors and
 *      a GPA — three boundaries, none of them visible to INSTITUTION_HINTS.
 *
 * Single column so `detectColumnBoundaries` finds no gutter (`triggers` == `[]`).
 *
 * SYNTHETIC PERSONA ONLY (repo is public; see tests/fixtures/pdfs/README.md):
 *   name  Marlowe Ashby
 *   email marlowe.ashby@example.com
 *   phone (312) 555-0134   ← real area code + 555 exchange + 0100-0199 subscriber
 *
 * Usage:  node scripts/fixtures/gen-education-hintless-institution-lead.mjs
 * Emits:  tests/fixtures/pdfs/unknown/education-hintless-institution-lead.pdf
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "../..");
const OUT_DIR = join(REPO_ROOT, "tests/fixtures/pdfs/unknown");
const OUT_FILE = join(OUT_DIR, "education-hintless-institution-lead.pdf");

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
// Right-aligned to the right margin — the flush-right date column the exporter
// produces via `headerLineDate` / `subLineDate`.
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
draw("MARLOWE ASHBY", { size: NAME, useFont: bold });
nextRow(NAME + 4);
draw("marlowe.ashby@example.com  |  (312) 555-0134  |  Denver, CO");
nextRow(LINE_H + 8);

// ── EXPERIENCE ──────────────────────────────────────────────────────────────
// A minimal Experience section keeps the completeness score realistic without
// touching the surface the fixture is about. The role title and company are
// chosen to share no substring with the edit-leg gate's synthetic markers
// (`Vantreon Platform Engineer` / `Vantreon Systems`,
// `corpus-edit-roundtrip.test.ts`) — its "the replaced value is gone" half is a
// substring search, so a fixture title that is a substring of the replacement
// fails a round-trip that was correct.
draw("Experience", { size: H2, useFont: bold });
nextRow(H2 + 6);
draw("Reliability Lead", { useFont: bold });
drawRight("Jun 2024 – Present");
nextRow();
draw("Initech Robotics, Denver, CO");
nextRow();
draw("• Cut median API latency from 340ms to 90ms across 12 services.");
nextRow(LINE_H + 8);

// ── EDUCATION ───────────────────────────────────────────────────────────────
draw("Education", { size: H2, useFont: bold });
nextRow(H2 + 6);

// Shape 1 — hint-less institution LEAD carrying an IN-PROGRESS range: the open
// end must survive as `is_current` ("Present"), not collapse to a bare start.
draw("Caltech", { useFont: bold });
drawRight("Sep 2022 – Present");
nextRow();
draw("Ph.D., Applied Mathematics");
nextRow(LINE_H + 4);

// Shape 2 — hint-less institution lead with a flush-right MONTH-YEAR, the
// single most common graduation shape and the one `isLoneDateRange` never
// admitted (it rendered glued two spaces after the institution before #882).
draw("MIT", { useFont: bold });
drawRight("May 2022");
nextRow();
draw("M.S., Computer Science");
nextRow(LINE_H + 4);

// Shape 3 — a THIRD adjacent hint-less institution entry, degree sub-line
// carrying honors + GPA. Together these three are the count proof: none of
// "Caltech" / "MIT" / "Georgia Tech" matches INSTITUTION_HINTS, so every entry
// boundary here rests on the institution-lead cue alone.
draw("Georgia Tech", { useFont: bold });
drawRight("May 2020");
nextRow();
draw("B.S., Computer Science, cum laude, GPA: 3.72/4.00");

mkdirSync(OUT_DIR, { recursive: true });
const bytes = await doc.save();
writeFileSync(OUT_FILE, bytes);
console.log(`wrote ${OUT_FILE} (${bytes.length} bytes)`);
