// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Fixture generator for #843 item 5 — `looksLikeHeaderlessRoleHeader`'s
 * un-anchored `INSTITUTION_HINTS` guard rejecting real, institution-named
 * EMPLOYERS out of the headerless-experience recovery (#492).
 *
 * Same shape as `gen-headerless-experience.mjs` (a single-column résumé whose
 * work history carries no `EXPERIENCE` header at all), except two of the
 * three cluster roles work at institutions whose names carry an
 * `INSTITUTION_HINTS` token — `University`, `Academy` — the exact class guard
 * 5 mistook for an unheadered EDUCATION entry before the fix anchored the
 * check to the head's lead segment (the part before the first comma). Before
 * the fix, both institution-named roles fail `looksLikeHeaderlessRoleHeader`,
 * only Role 3 (an ordinary employer) passes, the cluster never reaches
 * `HEADERLESS_ROLE_CLUSTER_MIN` (2) on its own institution-named members, and
 * `recoverHeaderlessExperience` opens no section at all: `experienceCount: 0`.
 * After the fix all three roles pass, because the institution token sits
 * AFTER the comma (in the employer segment) rather than in the head's lead
 * (the title segment).
 *
 * `EDUCATION` below the cluster is the negative control, in both its
 * degree-led and institution-led shapes — an unheadered EDUCATION entry must
 * still not be misread as an experience role. It stays under its own real
 * `EDUCATION` header here, exercising `looksLikeHeaderlessRoleHeader`'s guard
 * only through the cluster above; the headerless negative-control shapes
 * (degree-led and institution-led with no header at all) are covered by unit
 * tests in `sections.test.ts` instead of a second fixture.
 *
 * Everything is drawn as a SINGLE column so `detectColumnBoundaries` finds no
 * gutter (`triggers` == `[]`).
 *
 * SYNTHETIC PERSONA ONLY (repo is public; see tests/fixtures/pdfs/README.md):
 *   name  Riley Chen
 *   email riley.chen@example.com
 *   phone (312) 555-0171   ← real area code + 555 exchange + 0100-0199 subscriber
 *
 * Usage:  node scripts/fixtures/gen-headerless-experience-institution-employer.mjs
 * Emits:  tests/fixtures/pdfs/unknown/headerless-experience-institution-employer.pdf
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "../..");
const OUT_DIR = join(REPO_ROOT, "tests/fixtures/pdfs/unknown");
const OUT_FILE = join(OUT_DIR, "headerless-experience-institution-employer.pdf");

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
draw("RILEY CHEN", { size: NAME, useFont: bold });
nextRow(NAME + 4);
draw("riley.chen@example.com  |  (312) 555-0171  |  Chicago, IL");
nextRow(LINE_H + 10);

// ── HIGHLIGHTS — a real keyword header mapped to the `other` sink ────────────
draw("HIGHLIGHTS", { size: H2, useFont: bold });
nextRow(H2 + 6);
draw("Nine years spanning applied research and public education technology.");
nextRow();
draw("Shipped learning and research tooling used by millions of students.");
nextRow(LINE_H + 10);

// ── Work history — NO HEADER OF ANY KIND ────────────────────────────────────
// Role 1 — institution-named employer #1. INSTITUTION_HINTS ("University")
// sits AFTER the first comma, in the employer segment, not the head's lead.
draw("Research Engineer, Stanford University, Palo Alto, CA (Sep 2018 - Jun 2021)");
nextRow();
draw("• Led a five-person applied ML team across two research verticals");
nextRow();
draw("• Published findings adopted into three production recommender systems");
nextRow(LINE_H + 6);

// Role 2 — institution-named employer #2 ("Academy").
draw("Content Lead, Khan Academy, Mountain View, CA (Jul 2021 - Present)");
nextRow();
draw("• Directed the redesign of the K-12 math curriculum library");
nextRow();
draw("• Grew weekly active learners on the platform by sixty percent");
nextRow(LINE_H + 6);

// Role 3 — an ordinary employer, proving the cluster recovers even the member
// that never needed the anchor fix.
draw("Software Engineer, Northwind Systems, Seattle, WA (Feb 2016 - Aug 2018)");
nextRow();
draw("• Built the account-provisioning service backing every new tenant");
nextRow(LINE_H + 10);

// ── EDUCATION — the negative control ────────────────────────────────────────
draw("EDUCATION", { size: H2, useFont: bold });
nextRow(H2 + 6);
draw("B.S. in Computer Science, Ridgemont State University");
nextRow();
draw("Aug 2012 - May 2016");

mkdirSync(OUT_DIR, { recursive: true });
const bytes = await doc.save();
writeFileSync(OUT_FILE, bytes);
console.log(`wrote ${OUT_FILE} (${bytes.length} bytes)`);
