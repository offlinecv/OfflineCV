// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Fixture generator for issue #574 — a two-column résumé whose sidebar sits on
 * the LEFT, so the whole résumé BODY lands on the high-x side of the gutter.
 *
 * The pre-#574 gate read "secondary column" as `line.x >= columnSplitX`, an
 * x-ORDER proxy that only names the sidebar when the sidebar is on the RIGHT.
 * On this layout the polarity inverts and every body line — role headers,
 * company names, wrapped bullet fragments — reached `matchSectionAnchorToken`,
 * which by design carries NONE of `matchAnchorFallback`'s prose guards. One
 * anchor-ending line then opened a spurious section that swallowed the rest of
 * the document.
 *
 * The trigger line is role 2's employer, `NGP Professional Education`:
 *
 *   - the GUARDED text-only matcher already rejects it (regex.ts Guard 8, the
 *     #258 fix — an ALL-CAPS org initialism plus a Title-case proper-noun
 *     modifier before the head noun reads as an entity name, not a heading), so
 *     it is a clean probe of the unguarded path and nothing else;
 *   - the plainer two-token form the issue body cites (`Northgate Education`)
 *     would NOT probe this path — it passes every guard and is consumed by
 *     `matchAnchorFallback` upstream, a different defect on a different layer;
 *   - its own row carries no date (role 2's date range rides the TITLE row
 *     above it, and the row below is a location), so the SIDEBAR-band gate is
 *     the only thing holding it out. Revert that gate and the fixture flips.
 *
 * Geometry (US Letter, 612 × 792):
 *   - sidebar rail at x = 40, inking to ≈ 160 — the NARROW band;
 *   - résumé body at x = 224, inking to ≈ 470 — the WIDE band;
 *   - a clean ≈ 60pt gutter between them, centred well inside the central band
 *     `detectColumnBoundaries` scans, and painted by no row.
 *   The name sits above the rail (left band) rather than over the gutter, so no
 *   row crosses the corridor at all and the `two_column` trigger fires cleanly.
 *
 * SYNTHETIC PERSONA ONLY (repo is public; see tests/fixtures/pdfs/README.md):
 *   name  Rowan Ellis
 *   email rowan.ellis@example.com
 *   phone (503) 555-0142   ← real area code + 555 exchange + 0100–0199 subscriber
 *
 * Usage:  node scripts/fixtures/gen-sidebar-left-anchor-company.mjs
 * Emits:  tests/fixtures/pdfs/unknown/two-column-sidebar-left-anchor-company.pdf
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "../..");
const OUT_DIR = join(REPO_ROOT, "tests/fixtures/pdfs/unknown");
const OUT_FILE = join(OUT_DIR, "two-column-sidebar-left-anchor-company.pdf");

const BODY = 9; // body font size (pt)
// Section headers carry NO font-size lift — bold + ALL CAPS at body size, the
// shape a professional-network PDF export actually renders. That keeps the
// markdown emitter from promoting them, so `parseHeuristic` falls back to the
// line-regex splitter (`splitIntoSections`) — the ONLY splitter that runs the
// column-band gate this fixture exists to pin. With a font-size lift the
// markdown-anchored splitter wins and the fixture pins nothing.
const HEAD = BODY;
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

/** Draw one text item at `x` on the baseline `y` (top-origin rows are computed
 *  per column, so each column advances its own cursor). */
function draw(text, x, y, { size = BODY, useFont = font } = {}) {
  page.drawText(text, { x, y, size, font: useFont, color: BLACK });
}

// ── Left rail: name above a narrow contact / skills column ──────────────────
let railY = 736;
const rail = (text, opts) => {
  draw(text, RAIL_X, railY, opts);
  railY -= LINE_H;
};

rail("ROWAN ELLIS", { size: NAME, useFont: bold });
railY -= 8;
rail("rowan.ellis@example.com");
rail("(503) 555-0142");
rail("Portland, OR");
railY -= 8;
rail("SKILLS", { useFont: bold });
for (const tool of [
  "Python",
  "TypeScript",
  "PostgreSQL",
  "Terraform",
  "Docker",
  "Kubernetes",
  "GraphQL",
]) {
  rail(tool);
}

// ── Right body: the résumé proper ───────────────────────────────────────────
let bodyY = 736;
const body = (text, opts) => {
  draw(text, BODY_X, bodyY, opts);
  bodyY -= LINE_H;
};
/** A role's "title … dates" row: two items on one baseline, gap < 50pt so line
 *  grouping keeps them a single PdfLine. The date rides the TITLE row, never
 *  the employer row below it — which is what leaves the employer line un-dated
 *  and therefore a clean probe of the band gate alone. */
const roleRow = (title, dates) => {
  draw(title, BODY_X, bodyY, { useFont: bold });
  draw(dates, BODY_X + bold.widthOfTextAtSize(title, BODY) + DATE_GAP, bodyY);
  bodyY -= LINE_H;
};

body("EXPERIENCE", { size: HEAD, useFont: bold });

// Role 1 — ordinary employer, establishes the section before the trigger line.
roleRow("Lead Platform Engineer", "Feb 2019 - Present");
body("Cascade Logistics Group");
body("Portland, OR");
body("• Ran the overnight logistics desk across three regions");
body("• Cut deploy time from forty minutes to six");
bodyY -= 6;

// Role 2 — THE DEFECT. The employer's trailing token is a section anchor, the
// row carries no date of its own, and the guarded matcher rejects it (Guard 8).
roleRow("Staff Engineer", "Jun 2015 - Jan 2019");
body("NGP Professional Education");
body("Portland, OR");
body("• Built the reporting pipeline the finance team runs on");
body("• Mentored four engineers through the platform migration");
bodyY -= 6;

// Role 3 — everything the spurious section used to swallow.
roleRow("Software Engineer", "Aug 2012 - May 2015");
body("Harbor Point Systems");
body("Seattle, WA");
body("• Shipped the billing service that handles every invoice");
bodyY -= 10;

// The one GENUINE education section — it must hold the degree and nothing else.
body("EDUCATION", { size: HEAD, useFont: bold });
roleRow("B.S. Computer Science", "2008 - 2012");
body("State University");

mkdirSync(OUT_DIR, { recursive: true });
const bytes = await doc.save();
writeFileSync(OUT_FILE, bytes);
console.log(`wrote ${OUT_FILE} (${bytes.length} bytes)`);
