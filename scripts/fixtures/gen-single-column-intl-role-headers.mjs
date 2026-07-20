// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Fixture generator for issue #461 — a single-column résumé whose role headers
 * are `Title — Multi-Word Company, Country`, exactly the shape where
 * `stripLocationSuffix`'s Pass D pre-#461 stole the last word of the company
 * ("Northwind Bank, India" → company "Deutsche" + location "Bank, India").
 *
 * Everything is drawn as a SINGLE column so `detectColumnBoundaries` finds no
 * gutter (`triggers` == `[]`).
 *
 * SYNTHETIC PERSONA ONLY (repo is public; see tests/fixtures/pdfs/README.md):
 *   name  Priya Iyer
 *   email priya.iyer@example.com
 *   phone (312) 555-0139   ← real area code + 555 exchange + 0100-0199 subscriber
 *
 * Usage:  node scripts/fixtures/gen-single-column-intl-role-headers.mjs
 * Emits:  tests/fixtures/pdfs/unknown/single-column-intl-role-headers.pdf
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "../..");
const OUT_DIR = join(REPO_ROOT, "tests/fixtures/pdfs/unknown");
const OUT_FILE = join(OUT_DIR, "single-column-intl-role-headers.pdf");

const BODY = 10;
const NAME = 16;
const H2 = 12;
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
draw("priya.iyer@example.com  |  (312) 555-0139  |  Bengaluru, India");
nextRow(LINE_H + 8);

// ── EXPERIENCE ──────────────────────────────────────────────────────────────
draw("Experience", { size: H2, useFont: bold });
nextRow(H2 + 6);

// Role 1 — "Title — Two-Word Bank Name, Country" (the classic #461 shape).
draw("Full-Stack Software Developer — Northwind Bank, India");
nextRow();
draw("Aug 2023 - Present");
nextRow();
draw("• Owned the private-wealth trading dashboard used by 200+ advisors");
nextRow();
draw("• Reduced cross-region API latency 40 percent via a Kafka rewrite");
nextRow(LINE_H + 4);

// Role 2 — corporate suffix ("Solutions") that pre-#461 was peeled as location.
draw("Java Developer Intern — Contoso Solutions, India");
nextRow();
draw("Jun 2022 - Aug 2022");
nextRow();
draw("• Migrated a legacy Struts service to Spring Boot");
nextRow();
draw("• Rewrote the daily reconciliation report to run in 12 minutes");
nextRow(LINE_H + 4);

// Role 3 — Legal-suffix "Ltd." that pre-#461 Pass D peeled off.
draw("Software Engineering Intern — Fabrikam Consulting Ltd., India");
nextRow();
draw("May 2021 - Aug 2021");
nextRow();
draw("• Prototyped an internal LLM chatbot for HR self-service");
nextRow();
draw("• Wrote onboarding docs adopted across three teams");
nextRow(LINE_H + 8);

// ── EDUCATION ───────────────────────────────────────────────────────────────
draw("Education", { size: H2, useFont: bold });
nextRow(H2 + 6);
draw("B.E. in Computer Science — Ridgemont Institute of Technology, India");
nextRow();
draw("Aug 2018 - May 2022");

mkdirSync(OUT_DIR, { recursive: true });
const bytes = await doc.save();
writeFileSync(OUT_FILE, bytes);
console.log(`wrote ${OUT_FILE} (${bytes.length} bytes)`);
