// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Fixture generator for issue #848 — the TWO-COLUMN counterpart to
 * `gen-headerless-experience.mjs` (#492): a work history with no recognized
 * `EXPERIENCE` heading, this time on a sidebar/body layout instead of a single
 * column.
 *
 * `recoverHeaderlessExperience` (`sections.ts`, ~:1041) is scoped to
 * `singleColumn` ONLY — see the docblock above it — and returns the sections
 * untouched on any two-column page. That scoping is deliberate (#574's whole
 * diff exists because an unguarded shape rule across a flattened two-column
 * body is a false-positive class), so this fixture is not expected to parse
 * the work history: it pins the DROP, on the layout the recovery excludes by
 * design. The corresponding `knownWrong.experience.*` entries in the sidecar
 * truth file cite this issue rather than asserting a parse that does not
 * happen. The follow-on `experience-no-section` defect class that would make
 * `/probe-experience` SEE this drop (instead of reporting `ok`) is deferred to
 * the next `DerivedSignals` schema bump — see #848's Decisions.
 *
 * Geometry mirrors `gen-sidebar-left-anchor-company.mjs` (#574): a narrow
 * sidebar rail on the left carries contact + skills, a wide body column on the
 * right carries the résumé proper, with a clean gutter between them so
 * `detectColumnBoundaries` fires `two_column` cleanly — which needs, among
 * other things, at least 30 text items on the page (`TWO_COLUMN_MIN_ITEMS_PER_PAGE`
 * in `pdf-layout.ts`), hence the fuller skills list and per-field role rows
 * below rather than one glued header line per role. The body drops straight
 * into three dated roles with NOTHING introducing them — no header line at
 * all — and closes with a genuine `EDUCATION` section as the negative
 * control, the same shape `gen-headerless-experience.mjs` uses for its
 * single-column sibling.
 *
 * SYNTHETIC PERSONA ONLY (repo is public; see tests/fixtures/pdfs/README.md):
 *   name  Casey Morgan
 *   email casey.morgan@example.com
 *   phone (312) 555-0157   ← real area code + 555 exchange + 0100-0199 subscriber
 *
 * Usage:  node scripts/fixtures/gen-two-column-headerless-experience.mjs
 * Emits:  tests/fixtures/pdfs/unknown/two-column-headerless-experience.pdf
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "../..");
const OUT_DIR = join(REPO_ROOT, "tests/fixtures/pdfs/unknown");
const OUT_FILE = join(OUT_DIR, "two-column-headerless-experience.pdf");

const BODY = 9; // body font size (pt)
const HEAD = BODY; // section headers carry no font-size lift, matching the sibling
const NAME = 16; // name font size (pt)
const RAIL_X = 40; // sidebar rail left edge
const BODY_X = 224; // body column left edge — a ≈60pt gutter past the rail's ink
const DATE_GAP = 24; // title→date gap (< 50pt, so the row stays ONE PdfLine)
const LINE_H = 14;
const BLACK = rgb(0, 0, 0);

const doc = await PDFDocument.create();
const page = doc.addPage([612, 792]);
const font = await doc.embedFont(StandardFonts.Helvetica);
const bold = await doc.embedFont(StandardFonts.HelveticaBold);

function draw(text, x, y, { size = BODY, useFont = font } = {}) {
  page.drawText(text, { x, y, size, font: useFont, color: BLACK });
}

// ── Left rail: name above a narrow contact / skills column ──────────────────
let railY = 736;
const rail = (text, opts) => {
  draw(text, RAIL_X, railY, opts);
  railY -= LINE_H;
};

rail("CASEY MORGAN", { size: NAME, useFont: bold });
railY -= 8;
rail("casey.morgan@example.com");
rail("(312) 555-0157");
rail("Chicago, IL");
railY -= 8;
rail("SKILLS", { useFont: bold });
for (const tool of [
  "Python",
  "React",
  "AWS",
  "PostgreSQL",
  "Docker",
  "Kubernetes",
  "Zendesk",
]) {
  rail(tool);
}
railY -= 8;
// "LANGUAGES" maps to the boundary-only `other` sink (sections.config.json),
// so it — not `skills` — is the section still open when the body's headerless
// roles arrive in reading order. Without it the roles bleed into `skills`
// instead of `other`, which would ALSO wreck the truth file's skills field
// and muddy this fixture's one intended defect.
rail("LANGUAGES", { useFont: bold });
rail("English (Native)");
rail("Spanish (Conversational)");

// ── Right body: work history with NO header of any kind ─────────────────────
let bodyY = 736;
const body = (text, opts) => {
  draw(text, BODY_X, bodyY, opts);
  bodyY -= LINE_H;
};
/** A role's "title … dates" row: two items on one baseline, gap < 50pt so line
 *  grouping keeps them a single PdfLine — mirrors the sibling generator. */
const roleRow = (title, dates) => {
  draw(title, BODY_X, bodyY, { useFont: bold });
  draw(dates, BODY_X + bold.widthOfTextAtSize(title, BODY) + DATE_GAP, bodyY);
  bodyY -= LINE_H;
};

// Role 1 — opens the body directly; no heading of any kind precedes it.
roleRow("Senior Support Engineer", "Feb 2021 - Present");
body("Meridian Health");
body("Chicago, IL");
body("• Cut average ticket resolution time from two days to four hours");
body("• Built the on-call runbook every new hire now trains from");
bodyY -= 6;

// Role 2
roleRow("Support Engineer", "Jul 2018 - Jan 2021");
body("Talltree Software");
body("Madison, WI");
body("• Owned the escalation queue for the billing platform");
body("• Wrote the triage guide that halved duplicate tickets");
bodyY -= 6;

// Role 3
roleRow("Help Desk Analyst", "Aug 2016 - Jun 2018");
body("Brookford Retail");
body("Milwaukee, WI");
body("• Resolved point-of-sale outages across forty store locations");
bodyY -= 10;

// ── EDUCATION — the negative control ────────────────────────────────────────
body("EDUCATION", { size: HEAD, useFont: bold });
roleRow("B.A. in Information Systems", "Aug 2012 - May 2016");
body("Lakeshore State University");

mkdirSync(OUT_DIR, { recursive: true });
const bytes = await doc.save();
writeFileSync(OUT_FILE, bytes);
console.log(`wrote ${OUT_FILE} (${bytes.length} bytes)`);
