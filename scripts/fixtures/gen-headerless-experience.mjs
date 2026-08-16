// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Fixture generator for the HEADERLESS EXPERIENCE defect (#492) — a
 * single-column résumé whose work history carries no section header at all: no
 * `EXPERIENCE` / `WORK EXPERIENCE` / `EMPLOYMENT` line, the roles just begin
 * cold under an unrelated block.
 *
 * The shape reproduced here is the one the issue reports, and it is the WORST
 * case rather than the easiest one: the résumé opens a real (keyword-matched)
 * `HIGHLIGHTS` block — which the section config maps to the boundary-only
 * `other` sink — writes two lines of prose under it, and then drops straight
 * into three dated roles with nothing introducing them. Pre-fix the section map
 * reads `profile / other / education` and every role line lands in `other`, so
 * `experience` parses ZERO entries and 100% of the work history is dropped.
 *
 * Two properties are load-bearing and must survive an edit here:
 *
 *   1. The two `HIGHLIGHTS` prose lines sit ABOVE the cluster inside the same
 *      `other` bucket. A recovery that simply relabels the whole `other`
 *      section `experience` would swallow them; the fix must open at the FIRST
 *      role line, leaving the prose behind.
 *   2. Role 1 carries its scope sentence GLUED onto the same drawn line, after
 *      the date range ("… (Mar 2021 - Present) Leads the automation guild …").
 *      That is the mid-line date the issue calls out: the anchor line must
 *      split into a clean title/company/date header plus a body sentence.
 *
 * `EDUCATION` below the cluster is the negative control: its own dated entry
 * must stay in `education` and must not be pulled into the recovered section.
 *
 * Everything is drawn as a SINGLE column so `detectColumnBoundaries` finds no
 * gutter (`triggers` == `[]`).
 *
 * SYNTHETIC PERSONA ONLY (repo is public; see tests/fixtures/pdfs/README.md):
 *   name  Jordan Avery
 *   email jordan.avery@example.com
 *   phone (503) 555-0148   ← real area code + 555 exchange + 0100-0199 subscriber
 *
 * Usage:  node scripts/fixtures/gen-headerless-experience.mjs
 * Emits:  tests/fixtures/pdfs/unknown/headerless-experience.pdf
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "../..");
const OUT_DIR = join(REPO_ROOT, "tests/fixtures/pdfs/unknown");
const OUT_FILE = join(OUT_DIR, "headerless-experience.pdf");

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
draw("JORDAN AVERY", { size: NAME, useFont: bold });
nextRow(NAME + 4);
draw("jordan.avery@example.com  |  (503) 555-0148  |  Portland, OR");
nextRow(LINE_H + 10);

// ── HIGHLIGHTS — a real keyword header mapped to the `other` sink ────────────
// Its two prose lines are what a whole-section relabel would wrongly absorb.
draw("HIGHLIGHTS", { size: H2, useFont: bold });
nextRow(H2 + 6);
draw("Eight years of test engineering across consumer web and mobile platforms.");
nextRow();
draw("Built and ran automation programs at three companies.");
nextRow(LINE_H + 10);

// ── Work history — NO HEADER OF ANY KIND ────────────────────────────────────
// Role 1 — the scope sentence is glued onto the header line AFTER the date
// range, so the anchor line has to split into header + body.
draw(
  "Senior QA Engineer, Northwind Systems, Portland, OR (Mar 2021 - Present) Leads the automation guild.",
);
nextRow();
draw("• Cut the nightly regression suite from six hours to forty minutes");
nextRow();
draw("• Rolled out contract testing across twelve backend services");
nextRow(LINE_H + 6);

// Role 2 — the plain shape: title, company, location, parenthesised dates.
draw("QA Engineer, Contoso Labs, Seattle, WA (Jun 2018 - Feb 2021)");
nextRow();
draw("• Wrote the first end-to-end suite covering the checkout flow");
nextRow();
draw("• Triaged three hundred defects a quarter at a two-day median");
nextRow(LINE_H + 6);

// Role 3 — the cluster's third member; two would already satisfy the rule, so
// this one also proves the recovery does not stop after the pair it matched on.
draw("Automation Analyst, Fabrikam Retail, Boise, ID (Aug 2016 - May 2018)");
nextRow();
draw("• Built the device lab that removed sixty percent of manual passes");
nextRow(LINE_H + 10);

// ── EDUCATION — the negative control ────────────────────────────────────────
// The date sits on its own row, the way the rest of the corpus writes an
// education entry — a parenthesised same-line date is a separate, unrelated
// parse defect (it survives into `institution`) and this fixture has no
// business carrying it.
draw("EDUCATION", { size: H2, useFont: bold });
nextRow(H2 + 6);
draw("B.S. in Computer Science, Ridgemont State University");
nextRow();
draw("Aug 2012 - May 2016");

mkdirSync(OUT_DIR, { recursive: true });
const bytes = await doc.save();
writeFileSync(OUT_FILE, bytes);
console.log(`wrote ${OUT_FILE} (${bytes.length} bytes)`);
