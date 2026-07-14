// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Fixture generator for issue #464 — a single-column Projects section whose
 * per-project bodies are PROSE PARAGRAPHS rather than `•` bullets. Pre-#464 the
 * multi-line header collapse rule in `collectAnchors` folded every non-bullet
 * line into ONE anchor, so only the first project rendered (name only, no
 * description) and the second project vanished entirely.
 *
 * SYNTHETIC PERSONA ONLY (repo is public; see tests/fixtures/pdfs/README.md):
 *   name  Alex Rivera
 *   email alex.rivera@example.com
 *   phone (312) 555-0193
 *
 * Usage:  node scripts/fixtures/gen-single-column-projects-prose-body.mjs
 * Emits:  tests/fixtures/pdfs/unknown/single-column-projects-prose-body.pdf
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "../..");
const OUT_DIR = join(REPO_ROOT, "tests/fixtures/pdfs/unknown");
const OUT_FILE = join(OUT_DIR, "single-column-projects-prose-body.pdf");

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
draw("ALEX RIVERA", { size: NAME, useFont: bold });
nextRow(NAME + 4);
draw("alex.rivera@example.com  |  (312) 555-0193  |  Portland, OR");
nextRow(LINE_H + 8);

// ── EXPERIENCE (minimal, just to anchor the résumé) ────────────────────────
draw("Experience", { size: H2, useFont: bold });
nextRow(H2 + 6);
draw("Software Engineer, Tailspin Consulting                              Aug 2022 - Present");
nextRow();
draw("• Owned the customer analytics service, 3M events/day");
nextRow(LINE_H + 8);

// ── PROJECTS — prose-body, NO bullets ──────────────────────────────────────
draw("Projects", { size: H2, useFont: bold });
nextRow(H2 + 6);

// Project 1: name + tech-stack + 2-sentence prose description.
draw("Ridgemont Resume Studio", { useFont: bold });
nextRow();
draw("React, Next.js, TypeScript, Tailwind CSS");
nextRow();
draw("Built a client-side resume review platform providing real-time feedback and ATS scoring.");
nextRow();
draw("Optimized rendering with responsive interfaces and shipped weekly to 200+ testers.");
nextRow(LINE_H + 4);

// Project 2: name + tech-stack + 2-sentence prose description.
draw("Ledger Ingest Toolkit", { useFont: bold });
nextRow();
draw("Java, Spring Boot, Kafka, Redis, Docker, Terraform, AWS EC2");
nextRow();
draw("Designed a distributed-systems teaching harness with real-time A/B testing and Kafka event processing.");
nextRow();
draw("Documented Redis-backed caching patterns and shipped as an OSS repo used by 400+ students.");

mkdirSync(OUT_DIR, { recursive: true });
const bytes = await doc.save();
writeFileSync(OUT_FILE, bytes);
console.log(`wrote ${OUT_FILE} (${bytes.length} bytes)`);
