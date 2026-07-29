// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Fixture generator for the `experience-parser-miss` defect class — a
 * single-column résumé with a conventionally-headed EXPERIENCE section whose
 * roles are written date-heading-first, everything under the heading bulleted:
 *
 *   Mar 2021 - Present
 *   • Staff Engineer, Globex Systems LLC
 *   • Led the payments platform migration …
 *
 * The whole work history is DROPPED — `experience` parses to `[]` — while the
 * two dated roles are plainly drawn. Why: the date line is the only `date_range`
 * anchor (`isAnchorLine` rejects a bullet line outright, a deliberate guard
 * against `PRESENT_RE` matching a word inside bullet prose), `headerLookback: 2`
 * finds only bullets above it, and everything below is collected as body — so
 * each block maps to neither `title` nor `company` and `extractExperience`'s
 * date-only-phantom filter (#145) drops it. Two blocks in, zero entries out.
 *
 * `localizeExperience`'s oracle scans the routed region for `DATE_RANGE_RE`
 * lines with no bullet guard, counts the two date headings, and reports
 * `PARSER-MISS (0 entries; region has 2 date-range lines)`. That is the class,
 * and this is the corpus's FIRST reproducer of it: all 54 baked fixtures carry
 * zero evidence for `experience-parser-miss`.
 *
 * NOT #492. #492 is the HEADERLESS experience section, and its own body records
 * that `experience-parser-miss` provably cannot fire there — with no routed
 * region there are no region lines, so the date oracle reads zero and the probe
 * says "ok". #492 asks for a BROADER oracle (or a new `experience-no-section`
 * class); this fixture covers the class the taxonomy defines today.
 *
 * The owning issue is #662 — filed for this shape specifically, and cited by
 * this fixture's `.truth.json` and its `corpus-edit-roundtrip` baseline. Those
 * two briefly cited #492 instead, contradicting this docblock; `check:baselines`
 * judges the issue NUMBER and cannot read a caveat, so it certified the wrong
 * attribution. Keep all three in lockstep.
 *
 * Everything is drawn as a SINGLE column so `detectColumnBoundaries` finds no
 * gutter (`triggers` == `[]`) and the defect is not confounded with a layout one.
 *
 * SYNTHETIC PERSONA ONLY (repo is public; see tests/fixtures/pdfs/README.md):
 *   name  Marcus Halloway
 *   email marcus.halloway@example.com
 *   phone (415) 555-0173   ← real area code + 555 exchange + 0100-0199 subscriber
 *
 * Usage:  node scripts/fixtures/gen-date-heading-bulleted-roles.mjs
 * Emits:  tests/fixtures/pdfs/unknown/date-heading-bulleted-roles.pdf
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "../..");
const OUT_DIR = join(REPO_ROOT, "tests/fixtures/pdfs/unknown");
const OUT_FILE = join(OUT_DIR, "date-heading-bulleted-roles.pdf");

const BODY = 10;
const NAME = 16;
const H2 = 13;
const MARGIN_X = 54;
const INDENT_X = 72;
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
draw("MARCUS HALLOWAY", { size: NAME, useFont: bold });
nextRow(NAME + 4);
draw("marcus.halloway@example.com  |  (415) 555-0173  |  Oakland, CA");
nextRow(LINE_H + 10);

// ── EXPERIENCE ──────────────────────────────────────────────────────────────
// The header routes normally — this fixture is about what happens INSIDE a
// correctly-routed region, not about section detection.
draw("Experience", { size: H2, useFont: bold });
nextRow(H2 + 6);

// Role 1 — the date range is the heading; the role itself is the first bullet.
draw("Mar 2021 - Present", { useFont: bold });
nextRow();
draw("• Staff Engineer, Globex Systems LLC", { x: INDENT_X });
nextRow();
draw("• Led the payments platform migration across 14 regional services", {
  x: INDENT_X,
});
nextRow();
draw("• Cut median deploy time from 42 minutes to 9 minutes", { x: INDENT_X });
nextRow(LINE_H + 4);

// Role 2 — same shape, a closed date range.
draw("Jun 2017 - Feb 2021", { useFont: bold });
nextRow();
draw("• Senior Engineer, Initech Analytics", { x: INDENT_X });
nextRow();
draw("• Rebuilt the ingest pipeline handling 3M events per day", {
  x: INDENT_X,
});
nextRow();
draw("• Mentored four engineers through the platform on-call rotation", {
  x: INDENT_X,
});
nextRow(LINE_H + 10);

// ── EDUCATION ───────────────────────────────────────────────────────────────
draw("Education", { size: H2, useFont: bold });
nextRow(H2 + 6);
draw("B.S. in Computer Science");
nextRow();
draw("Ridgemont State University  |  Aug 2013 - May 2017");
nextRow(LINE_H + 10);

// ── SKILLS ──────────────────────────────────────────────────────────────────
draw("Skills", { size: H2, useFont: bold });
nextRow(H2 + 6);
draw("Distributed Systems, Kubernetes, Terraform, PostgreSQL");

mkdirSync(OUT_DIR, { recursive: true });
const bytes = await doc.save();
writeFileSync(OUT_FILE, bytes);
console.log(`wrote ${OUT_FILE} (${bytes.length} bytes)`);
