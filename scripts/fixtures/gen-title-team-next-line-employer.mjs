// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Fixture generator for issue #466 — a single-column résumé whose role headers
 * carry a "Title, Team" comma suffix with the date on the SAME line, and the
 * real employer on the NEXT (below-anchor) line, delim-split into
 * "Employer | City, ST  Dept".
 *
 * Distinct from #372 (a Title, Team header ABOVE a delim-split anchor line
 * `Company | Location Dates`): here the anchor line IS the Title, Team header
 * and the employer sits below it. Pre-#466 the parser mirrored the title into
 * company (nonsense) and dropped the location entirely.
 *
 * SYNTHETIC PERSONA ONLY (repo is public; see tests/fixtures/pdfs/README.md):
 *   name  Casey Nolan
 *   email casey.nolan@example.com
 *   phone (312) 555-0157   ← real area code + 555 exchange + 0100-0199 subscriber
 *
 * Usage:  node scripts/fixtures/gen-title-team-next-line-employer.mjs
 * Emits:  tests/fixtures/pdfs/unknown/title-team-next-line-employer.pdf
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "../..");
const OUT_DIR = join(REPO_ROOT, "tests/fixtures/pdfs/unknown");
const OUT_FILE = join(OUT_DIR, "title-team-next-line-employer.pdf");

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
draw("CASEY NOLAN", { size: NAME, useFont: bold });
nextRow(NAME + 4);
draw("casey.nolan@example.com  |  (312) 555-0157  |  Chicago, IL");
nextRow(LINE_H + 8);

// ── EXPERIENCE ──────────────────────────────────────────────────────────────
draw("Experience", { size: H2, useFont: bold });
nextRow(H2 + 6);

// Role 1 — Title, Team on anchor line; employer + city on the line below.
// Suffix-less employer ("Wingtip Financial") so `looksLikeCompany` misses
// it and the fix's mapTitleFirst case-2 (below-anchor delim) has to fire.
drawDatedRow("Software Engineer II, Payments Platform", "Aug 2024 - Present");
draw("Wingtip Financial | Chicago, IL");
nextRow();
draw("• Owned the payment settlement rails handling 4M transactions daily");
nextRow();
draw("• Cut p99 latency 35 percent via a request-batching redesign");
nextRow(LINE_H + 4);

// Role 2 — Same shape, different role.
drawDatedRow("Software Engineer I, Ledger Ingest", "Jul 2022 - Aug 2024");
draw("Wingtip Financial | Chicago, IL");
nextRow();
draw("• Migrated the ledger to an event-sourced write path");
nextRow();
draw("• Reduced ingest lag from 3 minutes to under 10 seconds");
nextRow(LINE_H + 4);

// Role 3 — NO comma suffix on the header — pre-#466 this one already worked.
drawDatedRow("Software Engineering Intern", "Jun 2019 - Aug 2019");
draw("Tailspin Consulting | Chicago, IL");
nextRow();
draw("• Prototyped a Redis-backed feature-flag service");
nextRow(LINE_H + 8);

// ── EDUCATION ───────────────────────────────────────────────────────────────
draw("Education", { size: H2, useFont: bold });
nextRow(H2 + 6);
drawDatedRow("B.S. Computer Science, Ridgemont University", "2015 - 2019");

mkdirSync(OUT_DIR, { recursive: true });
const bytes = await doc.save();
writeFileSync(OUT_FILE, bytes);
console.log(`wrote ${OUT_FILE} (${bytes.length} bytes)`);
