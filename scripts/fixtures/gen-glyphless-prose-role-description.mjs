// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Fixture generator for issue #1088 — an Experience section whose roles carry
 * NO bullet markers, just a single line of prose under each header. Pre-fix,
 * a glyph-less description line with no internal sentence break (so
 * `isProseLine` missed it) walked straight into the NEXT role's header run:
 * role 1's description became role 2's "title", and role 2's real title was
 * dropped from the parse entirely.
 *
 * SYNTHETIC PERSONA ONLY (repo is public; see tests/fixtures/pdfs/README.md):
 *   name  Jordan Rivera
 *   email jordan.rivera@example.com
 *   phone (312) 555-0123
 *
 * Usage:  node scripts/fixtures/gen-glyphless-prose-role-description.mjs
 * Emits:  tests/fixtures/pdfs/unknown/glyphless-prose-role-description.pdf
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "../..");
const OUT_DIR = join(REPO_ROOT, "tests/fixtures/pdfs/unknown");
const OUT_FILE = join(OUT_DIR, "glyphless-prose-role-description.pdf");

const BODY = 10;
const X = 50;
const LINE_H = 16;
const BLACK = rgb(0, 0, 0);

const doc = await PDFDocument.create();
const page = doc.addPage([612, 792]);
const font = await doc.embedFont(StandardFonts.Helvetica);
const bold = await doc.embedFont(StandardFonts.HelveticaBold);

let cursorY = 740;

function draw(text, { useFont = font } = {}) {
  page.drawText(text, { x: X, y: cursorY, size: BODY, font: useFont, color: BLACK });
  cursorY -= LINE_H;
}

draw("Jordan Rivera", { useFont: bold });
draw("jordan.rivera@example.com | (312) 555-0123 | Chicago, IL");
draw("EXPERIENCE", { useFont: bold });
draw("Senior Software Engineer", { useFont: bold });
draw("Acme Corp, Chicago, IL    Jan 2021 - Present");
draw("Worked on the billing service and helped the team with various backend tasks.");
draw("Software Engineer", { useFont: bold });
draw("Globex Inc, Chicago, IL    Jun 2018 - Dec 2020");
draw("Worked on APIs and did general maintenance on the platform.");
draw("EDUCATION", { useFont: bold });
draw("State University — B.S. Computer Science    2014 - 2018");
draw("SKILLS", { useFont: bold });
draw("Python, TypeScript, React, PostgreSQL, AWS");

mkdirSync(OUT_DIR, { recursive: true });
const bytes = await doc.save();
writeFileSync(OUT_FILE, bytes);
console.log(`wrote ${OUT_FILE} (${bytes.length} bytes)`);
