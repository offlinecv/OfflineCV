// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Fixture generator for the `skills-header-unrecognized` defect class (#575) —
 * a single-column résumé whose skills block is headed `Top Skills`, the label a
 * major professional network's PDF export emits.
 *
 * `skills` carries `anchorFallback: false` in `sections.config.json` (the guard
 * that keeps prose lines ending in "skills" out of the section), and matching is
 * exact-alias only. `top skills` is not an alias, so the strict router routes the
 * heading to the catch-all and the skills values land in `other` — `parsed.skills`
 * comes back EMPTY while the skills are plainly drawn under their own heading.
 *
 * This is the corpus's FIRST reproducer of `skills-header-unrecognized`. The
 * class is structurally identical to `skills-no-section` in the ReproArtifact
 * (0 skills, no routed region) — the only bit that separates them is
 * `derived.skillsHeaderCandidateRejected`, which needs the markdown header
 * oracle to see a skills-LIKE header the strict router refused. So the heading
 * must render as a real markdown header (bold, larger than body) and must
 * contain the `skills` anchor token without being an alias.
 *
 * Everything is drawn as a SINGLE column so `detectColumnBoundaries` finds no
 * gutter (`triggers` == `[]`) and the defect is not confounded with a layout one.
 *
 * SYNTHETIC PERSONA ONLY (repo is public; see tests/fixtures/pdfs/README.md):
 *   name  Priya Iyer
 *   email priya.iyer@example.com
 *   phone (312) 555-0157   ← real area code + 555 exchange + 0100-0199 subscriber
 *
 * Usage:  node scripts/fixtures/gen-top-skills-header.mjs
 * Emits:  tests/fixtures/pdfs/unknown/top-skills-header-unrecognized.pdf
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "../..");
const OUT_DIR = join(REPO_ROOT, "tests/fixtures/pdfs/unknown");
const OUT_FILE = join(OUT_DIR, "top-skills-header-unrecognized.pdf");

const BODY = 10;
const NAME = 16;
const H2 = 13;
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
draw("PRIYA IYER", { size: NAME, useFont: bold });
nextRow(NAME + 4);
draw("priya.iyer@example.com  |  (312) 555-0157  |  Seattle, WA");
nextRow(LINE_H + 10);

// ── Top Skills ──────────────────────────────────────────────────────────────
// The defect. `top skills` is not a `skills` alias and `anchorFallback` is off
// for the section, so this heading routes nowhere.
draw("Top Skills", { size: H2, useFont: bold });
nextRow(H2 + 6);
draw("Distributed Systems");
nextRow();
draw("Kubernetes");
nextRow();
draw("Terraform");
nextRow(LINE_H + 10);

// ── EXPERIENCE ──────────────────────────────────────────────────────────────
// A conventionally-headed experience section, so the fixture isolates the skills
// routing gap: everything else about this résumé parses normally.
draw("Experience", { size: H2, useFont: bold });
nextRow(H2 + 6);
draw("Staff Engineer", { useFont: bold });
nextRow();
draw("Globex Systems LLC  |  Seattle, WA");
nextRow();
draw("Mar 2021 - Present");
nextRow();
draw("• Led the payments platform migration across 14 regional services");
nextRow();
draw("• Cut median deploy time from 42 minutes to 9 minutes");
nextRow(LINE_H + 4);
draw("Senior Engineer", { useFont: bold });
nextRow();
draw("Initech Analytics  |  Portland, OR");
nextRow();
draw("Jun 2017 - Feb 2021");
nextRow();
draw("• Rebuilt the ingest pipeline handling 3M events per day");
nextRow(LINE_H + 10);

// ── EDUCATION ───────────────────────────────────────────────────────────────
draw("Education", { size: H2, useFont: bold });
nextRow(H2 + 6);
draw("B.S. in Computer Science");
nextRow();
draw("Ridgemont State University  |  Aug 2013 - May 2017");

mkdirSync(OUT_DIR, { recursive: true });
const bytes = await doc.save();
writeFileSync(OUT_FILE, bytes);
console.log(`wrote ${OUT_FILE} (${bytes.length} bytes)`);
