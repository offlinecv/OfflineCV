// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Fixture generator reproducing the LinkedIn-URL round-trip defect (#520) — a
 * single-column résumé whose profile line carries a bare (scheme-less,
 * www-less) LinkedIn vanity URL ending in a TRAILING SLASH,
 * `linkedin.com/in/<slug>/`, which is LinkedIn's own canonical profile form.
 *
 * The trailing slash is the whole point of this fixture, not incidental
 * styling: pre-fix, Tier-1's `normalizeUrl` KEPT it while the exporter's
 * `formatLinkDisplay` DROPPED it, so `linkedin_url` came back slash-less on
 * re-parse and changed across parse→export→re-parse. Drop the slash from the
 * drawn profile line below and this fixture silently stops guarding anything.
 * It is the only reproducer for that defect; the real candidate résumés that
 * surfaced it never enter the repo.
 *
 * Single column so `detectColumnBoundaries` finds no gutter (`triggers` == `[]`).
 *
 * SYNTHETIC PERSONA ONLY (repo is public; see tests/fixtures/pdfs/README.md):
 *   name  Marcus Halloway
 *   email marcus.halloway@example.com
 *   phone (415) 555-0173   ← real area code + 555 exchange + 0100-0199 subscriber
 *   linkedin.com/in/marcus-halloway/  ← trailing slash IS the defect under test
 *   github.com/mhalloway              (both bare — no scheme, no www.)
 *
 * Usage:  node scripts/fixtures/gen-bare-linkedin-url-roundtrip.mjs
 * Emits:  tests/fixtures/pdfs/unknown/bare-linkedin-url-roundtrip.pdf
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "../..");
const OUT_DIR = join(REPO_ROOT, "tests/fixtures/pdfs/unknown");
const OUT_FILE = join(OUT_DIR, "bare-linkedin-url-roundtrip.pdf");

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
draw("MARCUS HALLOWAY", { size: NAME, useFont: bold });
nextRow(NAME + 4);
draw("marcus.halloway@example.com  |  (415) 555-0173  |  San Francisco, CA");
nextRow();
draw("linkedin.com/in/marcus-halloway/  |  github.com/mhalloway");
nextRow(LINE_H + 8);

// ── EXPERIENCE ──────────────────────────────────────────────────────────────
draw("Experience", { size: H2, useFont: bold });
nextRow(H2 + 6);
draw("Software Engineer, Globex Corporation", { useFont: bold });
nextRow();
draw("Jul 2021 - Present");
nextRow();
draw("• Built the billing platform serving 2M monthly transactions");
nextRow();
draw("• Cut p99 checkout latency 35 percent via a caching rewrite");
nextRow(LINE_H + 8);

// ── EDUCATION ───────────────────────────────────────────────────────────────
draw("Education", { size: H2, useFont: bold });
nextRow(H2 + 6);
draw("B.S. in Computer Science, Ridgemont State University");
nextRow();
draw("Aug 2017 - May 2021");

mkdirSync(OUT_DIR, { recursive: true });
const bytes = await doc.save();
writeFileSync(OUT_FILE, bytes);
console.log(`wrote ${OUT_FILE} (${bytes.length} bytes)`);
