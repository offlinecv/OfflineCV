// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Fixture generator for the `roundtrip-contact-value-changed` defect class — a
 * single-column résumé whose owner's NAME carries a Latin Extended-A character
 * (`Anna Wiśniewska`; `ś` is U+015B) that the Download-PDF export cannot draw,
 * so the name comes back corrupted on the round-trip:
 *
 *   parse1 full_name  "ANNA WIŚNIEWSKA"
 *   parse3 full_name  "ANNA WI?NIEWSKA"
 *
 * That is the user-facing shape of the defect: download your own résumé and your
 * surname has a `?` in it.
 *
 * The mechanism is the #295 `toWinAnsi()` render sanitizer, whose lossy
 * degradation #326 recorded as an accepted by-design tradeoff (degrade a glyph,
 * never crash the export). `toWinAnsi()` runs on the STANDARD-FONT path — i.e.
 * whenever the Liberation Sans embed does not happen: always under Node (the font is a
 * bundler `?url` asset there is no server to fetch), and in the browser whenever
 * that fetch fails. The two `experience` baselines #326 records
 * (`google-docs-skia-proxy-classic`, `weasyprint-cairo-classic`) are the same
 * root on a different field, and the corpus goldens are already baked on this
 * path — `corpus.test.ts`'s docblock says so explicitly. This fixture is the
 * CONTACT-field member of that family, and the corpus's first evidence for the
 * class: all 54 baked fixtures round-trip contact byte-clean today.
 *
 * Everything else on the contact line is deliberately plain ASCII — a compliant
 * `@example.com` address, a policy phone, and `Chicago, IL` (a location the
 * extractor recognizes). That isolates the name as the ONLY field that moves, so
 * the fixture localizes the boundary rather than merely saying "contact broke".
 * A first attempt put the extended-Latin character in the location instead and
 * had to be abandoned: `Kraków, Małopolskie` is not recognized as a location at
 * all (the parse emits `contact-location-parser-miss`), so there was no value
 * left to round-trip — a separate, real defect, filed nowhere yet.
 *
 * The SOURCE pdf must embed a font that actually has the glyph (pdf-lib's
 * `StandardFonts` throw on it), so this generator embeds the repo's own
 * Liberation Sans via fontkit — the same TTF `render-ats-pdf.ts` embeds.
 *
 * Everything is drawn as a SINGLE column so `detectColumnBoundaries` finds no
 * gutter (`triggers` == `[]`).
 *
 * SYNTHETIC PERSONA ONLY (repo is public; see tests/fixtures/pdfs/README.md):
 *   name  Anna Wiśniewska
 *   email anna.wisniewska@example.com
 *   phone (312) 555-0164   ← real area code + 555 exchange + 0100-0199 subscriber
 *
 * Usage:  node scripts/fixtures/gen-extended-latin-name.mjs
 * Emits:  tests/fixtures/pdfs/unknown/extended-latin-name-roundtrip.pdf
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "../..");
const OUT_DIR = join(REPO_ROOT, "tests/fixtures/pdfs/unknown");
const OUT_FILE = join(OUT_DIR, "extended-latin-name-roundtrip.pdf");
const FONT_DIR = join(REPO_ROOT, "src/assets/fonts");

const BODY = 10;
const NAME = 16;
const H2 = 13;
const MARGIN_X = 54;
const INDENT_X = 72;
const LINE_H = 16;
const BLACK = rgb(0, 0, 0);

const doc = await PDFDocument.create();
doc.registerFontkit(fontkit);
const page = doc.addPage([612, 792]);
// `subset: true` keeps the committed fixture small — the full Liberation Sans
// pair is well over 100 kB, and this résumé touches under a hundred glyphs.
const font = await doc.embedFont(
  readFileSync(join(FONT_DIR, "LiberationSans-Regular.ttf")),
  { subset: true },
);
const bold = await doc.embedFont(
  readFileSync(join(FONT_DIR, "LiberationSans-Bold.ttf")),
  { subset: true },
);

let cursorY = 748;

function draw(text, { x = MARGIN_X, size = BODY, useFont = font } = {}) {
  page.drawText(text, { x, y: cursorY, size, font: useFont, color: BLACK });
}
function nextRow(pts = LINE_H) {
  cursorY -= pts;
}

// ── Profile ─────────────────────────────────────────────────────────────────
draw("ANNA WI\u015aNIEWSKA", { size: NAME, useFont: bold });
nextRow(NAME + 4);
// Plain ASCII throughout, so the NAME above is the only field that can move.
draw("anna.wisniewska@example.com  |  (312) 555-0164  |  Chicago, IL");
nextRow(LINE_H + 10);

// ── EXPERIENCE ──────────────────────────────────────────────────────────────
draw("Experience", { size: H2, useFont: bold });
nextRow(H2 + 6);
draw("Staff Engineer", { useFont: bold });
nextRow();
draw("Globex Systems LLC  |  Chicago, IL");
nextRow();
draw("Mar 2021 - Present");
nextRow();
draw("• Led the payments platform migration across 14 regional services", {
  x: INDENT_X,
});
nextRow();
draw("• Cut median deploy time from 42 minutes to 9 minutes", { x: INDENT_X });
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
