// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Fixture generator for issue #465 — a well-formatted SINGLE-COLUMN résumé whose
 * Skills section is a bulleted list of bold `Label:` category rows, each holding
 * a comma-separated list that soft-wraps onto a continuation line.
 *
 * The shape that matters (and that no existing corpus fixture covers):
 *   • <bold>Frontend:</bold> React, TypeScript, …, HTML5,
 *     CSS3, JavaScript                          ← soft-wrapped continuation
 *
 * The bold label is drawn as its OWN pdf-lib text run, so pdfjs emits it as a
 * separate text item — exactly what a Word/Google-Docs export does. Body ink
 * spans the page so `detectColumnBoundaries` finds no gutter (`triggers: []`).
 *
 * SYNTHETIC PERSONA ONLY (repo is public; see tests/fixtures/pdfs/README.md):
 *   name  Jane Smith
 *   email jane.smith@example.com
 *   phone (312) 555-0123   ← real area code + 555 exchange + 0100–0199 subscriber
 *
 * Usage:  node scripts/fixtures/gen-bulleted-labelled-skills.mjs
 * Emits:  tests/fixtures/pdfs/unknown/bulleted-labelled-single-column-skills.pdf
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "../..");
const OUT_DIR = join(REPO_ROOT, "tests/fixtures/pdfs/unknown");
const OUT_FILE = join(OUT_DIR, "bulleted-labelled-single-column-skills.pdf");

const BODY = 10;
const NAME = 18;
const HEAD = 11;
const MARGIN_X = 54;
const BULLET_X = 60;
const TEXT_X = 74; // bullet hanging indent
const LINE_H = 13;
const BLACK = rgb(0, 0, 0);

const doc = await PDFDocument.create();
const page = doc.addPage([612, 792]);
const font = await doc.embedFont(StandardFonts.Helvetica);
const bold = await doc.embedFont(StandardFonts.HelveticaBold);

let cursorY = 748;

function draw(text, { x = MARGIN_X, size = BODY, useFont = font } = {}) {
  page.drawText(text, { x, y: cursorY, size, font: useFont, color: BLACK });
  return x + useFont.widthOfTextAtSize(text, size);
}

function newline(n = 1) {
  cursorY -= LINE_H * n;
}

// ── Header ───────────────────────────────────────────────────────────────────
draw("Jane Smith", { size: NAME, useFont: bold });
newline(1.6);
draw("jane.smith@example.com | (312) 555-0123 | Austin, TX");
newline(2);

// ── Skills (the fixture's payload) ───────────────────────────────────────────
draw("SKILLS", { size: HEAD, useFont: bold });
newline(1.4);

/**
 * Each row: a bold `Label:` run, then the comma-list continuing on the same
 * baseline, then zero or more soft-wrapped continuation lines at TEXT_X.
 *
 * `tab: true` sets the body at a fixed TAB_X stop instead of one space-width
 * after the label — what a Word / Google-Docs export does when the category
 * bodies are tab-aligned into a ragged column. The blank pdfjs synthesizes for
 * that tab is far WIDER than the spacer floor `splitColumnCells` uses, so the
 * row splits into `Label:` + body cells and takes the multi-column branch that
 * cannot soft-wrap-rejoin. Without that shape, the fixture only exercises the
 * narrow-gap rows, which `dropLeadingBullet` alone already rescues — i.e. it
 * sidesteps the branch #465 actually lives in.
 */
const TAB_X = 200;

const SKILL_ROWS = [
  ["Frontend", ["React, TypeScript, Next.js, Vite, HTML5, CSS3, JavaScript, Tailwind", "CSS, React Query"]],
  ["Frontend Testing", ["React Testing Library, Playwright"]],
  ["Backend", ["Java, Python, Spring Boot, REST APIs, Apache Kafka"]],
  ["Cloud & Infra", ["Docker, Kubernetes, Terraform, Helm, Prometheus, Grafana, AWS (EC2,", "S3, RDS)"]],
  ["Databases & Caching", ["PostgreSQL, MySQL, Redis, MongoDB"]],
  ["Product & Collaboration", ["A/B testing, event-driven architecture, CI/CD, Agile"]],
  // Tab-aligned body + a soft-wrap that breaks the skill "Data Visualization".
  ["Data & Analytics", ["Pandas, NumPy, scikit-learn, Apache Spark, Data", "Visualization, dbt"], { tab: true }],
];

for (const [label, runs, opts = {}] of SKILL_ROWS) {
  draw("•", { x: BULLET_X });
  const afterLabel = draw(`${label}:`, { x: TEXT_X, useFont: bold });
  const bodyX = opts.tab ? TAB_X : afterLabel + font.widthOfTextAtSize(" ", BODY);
  draw(runs[0], { x: bodyX });
  newline();
  for (const cont of runs.slice(1)) {
    draw(cont, { x: TEXT_X });
    newline();
  }
}
newline(1);

// ── Experience ───────────────────────────────────────────────────────────────
draw("EXPERIENCE", { size: HEAD, useFont: bold });
newline(1.4);
draw("Senior Software Engineer, Northwind Systems", { useFont: bold });
draw("Mar 2021 - Present", { x: 470 });
newline();
draw("• Led the rebuild of the customer portal, cutting page load time by 45%.", { x: BULLET_X });
newline();
draw("• Designed an event-driven ingestion pipeline handling 2M records daily.", { x: BULLET_X });
newline(1.6);
draw("Software Engineer, Baytown Labs", { useFont: bold });
draw("Jul 2018 - Feb 2021", { x: 470 });
newline();
draw("• Shipped a REST API serving 30 internal teams with 99.9% uptime.", { x: BULLET_X });
newline(2);

// ── Education ────────────────────────────────────────────────────────────────
draw("EDUCATION", { size: HEAD, useFont: bold });
newline(1.4);
draw("B.S. Computer Science, State University", { useFont: bold });
draw("2014 - 2018", { x: 470 });
newline();

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT_FILE, await doc.save());
console.log(`wrote ${OUT_FILE}`);
