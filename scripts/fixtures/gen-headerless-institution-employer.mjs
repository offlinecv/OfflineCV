// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Fixture generator for #843 item 5 — a single-column, headerless work history
 * (the same #492 shape `gen-headerless-experience.mjs` reproduces) whose
 * employers are themselves institution-named — "Stanford University", "Khan
 * Academy" — the shape `looksLikeHeaderlessRoleHeader`'s guard 5 used to reject
 * outright, because `INSTITUTION_HINTS` tested the whole head rather than just
 * its lead segment: "Research Engineer, Stanford University (…)" read as a
 * degree line the same way "B.S. in Computer Science, Ridgemont State
 * University (…)" does, and the whole cluster recovered ZERO roles.
 *
 * Three roles, deliberately mixed:
 *
 *   1. "Research Engineer, Stanford University" — institution AFTER the title.
 *   2. "Content Lead, Khan Academy" — same shape, second institution word
 *      (`Academy`) so the fix isn't pinned to `University` alone.
 *   3. "Platform Engineer, Northwind Systems" — an ORDINARY employer, included
 *      so the fix is measured against a mixed cluster rather than one where
 *      every member needed the same guard.
 *
 * Pre-fix, roles 1 and 2 are rejected by guard 5 and only role 3 passes —
 * below `HEADERLESS_ROLE_CLUSTER_MIN` (2), so the cluster does not open at
 * all and this fixture's `experience` count is 0. Post-fix all three pass and
 * the section opens at role 1.
 *
 * `EDUCATION` below the cluster is the negative control, same as the #492
 * sibling: its own degree-led, institution-named entry sits under a REAL
 * header and must stay in `education`, never pulled into the recovered
 * section.
 *
 * Everything is drawn as a SINGLE column so `detectColumnBoundaries` finds no
 * gutter (`triggers` == `[]`) — the recovery this fixture exercises is scoped
 * to `singleColumn` only.
 *
 * SYNTHETIC PERSONA ONLY (repo is public; see tests/fixtures/pdfs/README.md):
 *   name  Morgan Ellis
 *   email morgan.ellis@example.com
 *   phone (415) 555-0171   ← real area code + 555 exchange + 0100-0199 subscriber
 *
 * Usage:  node scripts/fixtures/gen-headerless-institution-employer.mjs
 * Emits:  tests/fixtures/pdfs/unknown/headerless-institution-employer.pdf
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "../..");
const OUT_DIR = join(REPO_ROOT, "tests/fixtures/pdfs/unknown");
const OUT_FILE = join(OUT_DIR, "headerless-institution-employer.pdf");

const BODY = 9.5;
const NAME = 16;
const H2 = 12;
const MARGIN_X = 48;
const PAGE_W = 612;
const LINE_H = 15;
const BLACK = rgb(0, 0, 0);

const doc = await PDFDocument.create();
const page = doc.addPage([PAGE_W, 792]);
const font = await doc.embedFont(StandardFonts.Helvetica);
const bold = await doc.embedFont(StandardFonts.HelveticaBold);

let cursorY = 748;

function draw(text, { x = MARGIN_X, size = BODY, useFont = font } = {}) {
  // Guard the one thing a hand-authored fixture silently gets wrong: a line
  // that overruns the page still "renders", but no real résumé looks like that
  // and the extracted geometry stops being representative.
  const width = useFont.widthOfTextAtSize(text, size);
  if (x + width > PAGE_W - MARGIN_X) {
    throw new Error(
      `line overruns the text column by ${Math.ceil(x + width - (PAGE_W - MARGIN_X))}pt: ${text}`,
    );
  }
  page.drawText(text, { x, y: cursorY, size, font: useFont, color: BLACK });
}
function nextRow(pts = LINE_H) {
  cursorY -= pts;
}

// ── Profile ─────────────────────────────────────────────────────────────────
draw("MORGAN ELLIS", { size: NAME, useFont: bold });
nextRow(NAME + 4);
draw("morgan.ellis@example.com  |  (415) 555-0171  |  San Jose, CA");
nextRow(LINE_H + 10);

// ── Work history — NO HEADER OF ANY KIND ────────────────────────────────────
// Role 1 — institution-named employer, institution AFTER the title.
draw("Research Engineer, Stanford University, Palo Alto, CA (Sep 2018 - Jun 2021)");
nextRow();
draw("• Built the ML feature pipeline serving every internal research team");
nextRow();
draw("• Shipped the GPU scheduler that cut training queue wait times in half");
nextRow(LINE_H + 6);

// Role 2 — second institution-type word (Academy), same shape.
draw("Content Lead, Khan Academy, Mountain View, CA (Jul 2021 - Present)");
nextRow();
draw("• Launched the algebra course rebuild used by two million learners");
nextRow();
draw("• Mentored a team of four content engineers");
nextRow(LINE_H + 6);

// Role 3 — an ordinary employer, so the cluster is mixed rather than uniform.
draw("Platform Engineer, Northwind Systems, Seattle, WA (Jan 2016 - Aug 2018)");
nextRow();
draw("• Migrated the billing service off the legacy monolith");
nextRow(LINE_H + 10);

// ── EDUCATION — the negative control ────────────────────────────────────────
// The date sits on its own row, the way the rest of the corpus writes an
// education entry — a parenthesised same-line date is a separate, unrelated
// parse defect and this fixture has no business carrying it.
draw("EDUCATION", { size: H2, useFont: bold });
nextRow(H2 + 6);
draw("B.S. in Computer Science, Ridgemont State University");
nextRow();
draw("Aug 2012 - May 2016");

mkdirSync(OUT_DIR, { recursive: true });
const bytes = await doc.save();
writeFileSync(OUT_FILE, bytes);
console.log(`wrote ${OUT_FILE} (${bytes.length} bytes)`);
