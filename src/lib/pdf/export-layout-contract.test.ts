// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Export layout-contract gate (#334).
 *
 * The "Download PDF" exporter guarantees a fixed ATS layout contract:
 *   - SINGLE column, top-to-bottom (render-ats-pdf.ts draws one column).
 *   - REVERSE-CHRONOLOGICAL entries (document order, as parsed).
 *   - CANONICAL section headers — every heading the exporter emits must be a
 *     header our OWN parser re-recognizes on re-upload.
 *   - STANDARD fonts (Poppins with a Helvetica fallback, both text-layer fonts).
 *
 * This test enforces the headers half: it asserts that every heading the
 * exporter can emit — the canonical fallback set, PLUS every verbatim
 * `AtsSection.heading` and the summary heading produced from real fixtures — is
 * recognized by `matchSectionHeader()`. So the export can never emit a heading
 * the parser would fail to re-open as a section on re-upload (which would break
 * the round-trip invariant). PII-free: asserts recognition of heading strings
 * (synthetic-persona fixtures), never dumps field values.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";
import { matchSectionHeader } from "../heuristics/regex.ts";
import { runCascade } from "../heuristics/cascade.ts";
import { computeAnonymousAtsScore } from "../score/score.ts";
import type { CascadeResult } from "../heuristics/types.ts";
import { buildAtsResumeModel } from "./ats-resume-model.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = join(HERE, "../../..", "tests/fixtures/pdfs");

/** The canonical fallback headings `buildAtsResumeModel` emits when a section
 *  carried no recognized verbatim heading (see the `?? "..."` fallbacks). Plus
 *  the Summary fallback (`render-ats-pdf.ts` draws `summaryHeading ?? "Summary"`). */
const CANONICAL_FALLBACK_HEADINGS = [
  "Summary",
  "Experience",
  "Projects",
  "Achievements",
  "Education",
  "Skills",
] as const;

function walkPdfs(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walkPdfs(p));
    else if (e.isFile() && e.name.toLowerCase().endsWith(".pdf")) out.push(p);
  }
  return out.sort();
}

function scoreFor(cascade: CascadeResult) {
  return computeAnonymousAtsScore({
    parsed: { ...cascade.canonical.fields },
    fieldConfidence: cascade.canonical.fieldConfidence,
    triggers: cascade.triggers,
    rawText: cascade.rawText,
    sections: cascade.canonical.sections,
  });
}

describe("export layout contract — canonical headers re-recognize (#334)", () => {
  it("every canonical fallback heading is recognized by matchSectionHeader", () => {
    for (const heading of CANONICAL_FALLBACK_HEADINGS) {
      expect(
        matchSectionHeader(heading),
        `exporter fallback heading "${heading}" is not re-recognized`,
      ).not.toBeNull();
    }
  });

  const fixtures = walkPdfs(FIXTURE_ROOT);

  it("finds fixtures", () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  for (const fixture of fixtures) {
    const rel = fixture.slice(FIXTURE_ROOT.length + 1);
    it(`emits only re-recognizable headings: ${rel}`, async () => {
      const cascade = await runCascade(new Uint8Array(readFileSync(fixture)));
      const model = buildAtsResumeModel(cascade, scoreFor(cascade));

      const headings = model.sections.map((s) => s.heading);
      // The summary heading is drawn separately from `sections` (falls back to
      // "Summary"); include it only when a summary is actually emitted.
      if (model.summary) headings.push(model.summaryHeading ?? "Summary");

      for (const heading of headings) {
        expect(
          matchSectionHeader(heading),
          `${rel}: exporter emits heading "${heading}" that matchSectionHeader does not recognize`,
        ).not.toBeNull();
      }
    });
  }
});
