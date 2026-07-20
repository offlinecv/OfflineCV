// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Fixture generator for issue #462 — a single-column résumé whose tail carries
 * a compound `X & Y` section header (`CERTIFICATIONS & ACTIVITIES`) that was
 * pre-#462 rejected by the exact-alias router, causing the trailing block to
 * bleed into `education` and the education parser to fabricate a phantom
 * degree entry off a body-prose "Graduated B.E. with Distinction" sentence.
 *
 * SYNTHETIC PERSONA ONLY (repo is public; see tests/fixtures/pdfs/README.md):
 *   name  Riley Kaur
 *   email riley.kaur@example.com
 *   phone (312) 555-0164
 *
 * Usage:  node scripts/fixtures/gen-compound-header-block-bleed.mjs
 * Emits:  tests/fixtures/pdfs/unknown/compound-certifications-activities-tail.pdf
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "../..");
const OUT_DIR = join(REPO_ROOT, "tests/fixtures/pdfs/unknown");
const OUT_FILE = join(OUT_DIR, "compound-certifications-activities-tail.pdf");

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
draw("RILEY KAUR", { size: NAME, useFont: bold });
nextRow(NAME + 4);
draw("riley.kaur@example.com  |  (312) 555-0164  |  Austin, TX");
nextRow(LINE_H + 8);

// ── EXPERIENCE ──────────────────────────────────────────────────────────────
draw("Experience", { size: H2, useFont: bold });
nextRow(H2 + 6);
drawDatedRow("Software Engineer, Ridgemont Consulting", "Aug 2022 - Present");
draw("• Owned the customer analytics service, 3M events/day");
nextRow();
draw("• Migrated an internal auth flow, saving 400 engineering hours per year");
nextRow(LINE_H + 8);

// ── EDUCATION ───────────────────────────────────────────────────────────────
draw("Education", { size: H2, useFont: bold });
nextRow(H2 + 6);
drawDatedRow(
  "M.Sc. in Computer Science — Wingtip University",
  "Jul 2024 - Dec 2025",
);
drawDatedRow(
  "B.E. in Computer Science — Ridgemont College · GPA 8.0 / 10",
  "Aug 2017 - Jun 2021",
);
nextRow(4);

// ── CERTIFICATIONS & ACTIVITIES (compound header — pre-#462 unrouted) ──────
draw("Certifications & Activities", { size: H2, useFont: bold });
nextRow(H2 + 6);
draw("Certifications: AWS Certified Cloud Practitioner");
nextRow();
// The DEGREE_RE-hitting body sentence pre-#462 fabricated a phantom degree.
draw("Achievements: Graduated B.E. with Distinction; mentored 3 interns");
nextRow();
draw("Leadership: Led CSR initiatives; competed in inter-college hackathons");

mkdirSync(OUT_DIR, { recursive: true });
const bytes = await doc.save();
writeFileSync(OUT_FILE, bytes);
console.log(`wrote ${OUT_FILE} (${bytes.length} bytes)`);
