// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Corpus round-trip invariant gate (#293).
 *
 * For every fixture PDF, assert that our own reconstructed-PDF output re-parses
 * back to the same structured résumé:
 *
 *   parse1 = runCascade(fixture)
 *   model  = buildAtsResumeModel(parse1, score(parse1))
 *   bytes  = renderAtsResumePdf(model)          // the "Download PDF" surface
 *   parse3 = runCascade(bytes)
 *   assert invariants(parse1, parse3)
 *
 * This is a SELF-CONSISTENCY check — the renderer must emit shapes our own
 * parser round-trips — fully in our control on both ends, no dependency on
 * quirky source PDFs. It generalizes the single-fixture `render-roundtrip.repro`
 * test (#284/#291/#292) to the whole corpus so future renderer or parser
 * changes can't silently regress a round-trip that works today.
 *
 * Only the parse1-vs-parse3 diff carries signal. The original 5-step idea also
 * diffed rendered PDF bytes against a re-render; `renderAtsResumePdf` is
 * deterministic, so those bytes are identical and prove only render determinism,
 * never parse quality. That step is intentionally omitted (#293 scope note).
 *
 * `triggers` are deliberately NOT an invariant: reconstruction normalizes layout
 * to a single-column ATS-clean shape on purpose, so layout triggers (two_column,
 * etc.) legitimately drop on re-parse. Asserting trigger equality would flag the
 * intended normalization as a regression.
 *
 * PII-free: this asserts field mapping (counts, degree/title/company strings that
 * are synthetic-persona by policy), never dumps a snapshot of values.
 *
 * ── Known-failure baseline (ratchet) ──
 * The round-trip is NOT yet clean across the whole corpus — the audit that
 * motivated this gate surfaced a batch of latent renderer/parser bugs (education
 * count inflation, experience header re-segmentation in dense/two-column layouts,
 * skills token splits, one total re-parse collapse). Those are tracked as
 * follow-up issues, not fixed here. `KNOWN_FAILURES` lists, per fixture, which
 * invariant CATEGORIES are currently allowed to fail. The gate therefore:
 *   - fails if a NON-baselined category regresses on any fixture (the ratchet's
 *     teeth — protects every invariant that passes today), and
 *   - fails if a BASELINED category now PASSES (stale entry — a bug got fixed,
 *     so its baseline line must be deleted, tightening the gate).
 * Net effect: the baseline can only shrink. Fix a bug → delete its line.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";
import { runCascade } from "./cascade.ts";
import { computeAnonymousAtsScore } from "../score/score.ts";
import type { CascadeResult } from "./types.ts";
import { buildAtsResumeModel } from "../pdf/ats-resume-model.ts";
import { renderAtsResumePdf } from "../pdf/render-ats-pdf.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = join(HERE, "../../..", "tests/fixtures/pdfs");

type Category =
  | "contact"
  | "experience"
  | "education"
  | "skills"
  | "summary"
  // `render` = renderAtsResumePdf threw before any re-parse could run. A crash in
  // the Download-PDF path is more severe than a field swap; it's baselined the
  // same way so the gate stays green while the fix is tracked separately.
  | "render";

/**
 * Per-fixture invariant categories currently allowed to fail. Keyed by the
 * fixture path relative to `tests/fixtures/pdfs/`. Shrink this as the follow-up
 * round-trip bugs are fixed — a fixed bug makes its category pass, which trips
 * the stale-entry check below and forces the line's removal.
 *
 * Grouped by the likely shared root cause so follow-up issues map cleanly:
 */
const KNOWN_FAILURES: Record<string, Category[]> = {
  // renderAtsResumePdf crashes on a non-WinAnsi glyph in the parsed text
  // (pdf-lib StandardFonts only encode WinAnsi): "→" (0x2192), "‐" (0x2010).
  // A hard crash in the Download-PDF path — highest-severity of the round-trip
  // finds. Tracked as its own follow-up.
  "google-docs/google-docs-skia-proxy-classic.pdf": ["render"],
  "unknown/weasyprint-cairo-classic.pdf": ["render"],
  "word/openresume-laverne-word-quartz.pdf": ["render"],

  // Education count inflation: reconstructed education emits a phantom extra
  // entry (1→2, 2→3) on re-parse.
  "google-docs/google-docs-skia-proxy-achievements-oneline.pdf": ["education"],
  "google-docs/google-docs-skia-proxy-additional-skills.pdf": ["education"],
  "google-docs/google-docs-skia-proxy-honors-subheadings.pdf": ["education"],
  "latex/header-as-name-functional-resume.pdf": ["education"],
  "unknown/chromium-qualified-experience-headers.pdf": ["education"],
  "word/chanchal-sharma-bulleted-skills.pdf": ["education"],
  "word/chanchal-sharma-sample.pdf": ["education"],

  // Experience header re-segmentation: title/company (and sometimes dates) swap
  // or shift on re-parse in denser / multi-role / two-column layouts.
  "google-docs/google-docs-skia-proxy-certifications.pdf": ["experience"],
  "latex/awesome-cv-cv.pdf": ["experience"],
  "unknown/chromium-two-column-sidebar.pdf": ["experience"],
  "unknown/two-column-achievements-sidebar.pdf": ["experience"],

  // Experience header re-segmentation + a skills-line token split (+1 skill).
  "google-docs/google-docs-skia-proxy-role-first-experience.pdf": [
    "experience",
    "skills",
  ],
  "latex/deedy-resume-macfonts.pdf": ["experience", "skills"],
  "latex/deedy-resume-openfonts.pdf": ["experience", "skills"],
  "unknown/openresume-react-pdf.pdf": ["experience", "skills"],

  // Multiple: experience swap, education institution pollution
  // ("University of California" → "… · Berkeley Berkeley, CA"), skills +1.
  "google-docs/google-docs-skia-proxy-programs-skills-software.pdf": [
    "experience",
    "education",
    "skills",
  ],

  // Total re-parse collapse: the reconstructed PDF reads back empty (contact,
  // experience, and education all drop out).
  "google-docs/google-docs-skia-proxy-coursework-dup.pdf": [
    "contact",
    "experience",
    "education",
  ],
};

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
    parsed: { ...cascade.parsed },
    fieldConfidence: cascade.fieldConfidence,
    triggers: cascade.triggers,
    rawText: cascade.rawText,
    sections: cascade.sections,
  });
}

const same = (a: unknown, b: unknown) =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Collect per-category failure messages for one round-trip. Empty array for a
 *  category ⇒ that invariant holds. */
function invariantFailures(
  p1: CascadeResult,
  p3: CascadeResult,
): Record<Exclude<Category, "render">, string[]> {
  const c1 = p1.parsed;
  const c3 = p3.parsed;
  const fails: Record<Exclude<Category, "render">, string[]> = {
    contact: [],
    experience: [],
    education: [],
    skills: [],
    summary: [],
  };

  for (const k of [
    "full_name",
    "email",
    "phone",
    "location",
    "linkedin_url",
  ] as const) {
    if (!same(c1[k], c3[k]))
      fails.contact.push(
        `${k}: ${JSON.stringify(c1[k])} → ${JSON.stringify(c3[k])}`,
      );
  }

  const e1 = c1.experience ?? [];
  const e3 = c3.experience ?? [];
  if (e1.length !== e3.length) {
    fails.experience.push(`role count ${e1.length} → ${e3.length}`);
  } else {
    e1.forEach((r, i) => {
      for (const k of ["title", "company", "start_date", "end_date"] as const)
        if (!same(r[k], e3[i]?.[k])) fails.experience.push(`role[${i}].${k}`);
    });
  }

  const d1 = c1.education ?? [];
  const d3 = c3.education ?? [];
  if (d1.length !== d3.length) {
    fails.education.push(`entry count ${d1.length} → ${d3.length}`);
  } else {
    d1.forEach((r, i) => {
      for (const k of ["degree", "field", "institution"] as const)
        if (!same(r[k], d3[i]?.[k])) fails.education.push(`entry[${i}].${k}`);
    });
  }

  const sk1 = (c1.skills ?? []).length;
  const sk3 = (c3.skills ?? []).length;
  if (sk1 !== sk3) fails.skills.push(`count ${sk1} → ${sk3}`);

  const s1 = c1.summary ?? "";
  const s3 = c3.summary ?? "";
  if (s1.length > 0) {
    const deltaPct = (100 * Math.abs(s1.length - s3.length)) / s1.length;
    if (deltaPct >= 5)
      fails.summary.push(
        `|Δ| ${deltaPct.toFixed(1)}% (${s1.length} → ${s3.length})`,
      );
  }

  return fails;
}

const CATEGORIES: Category[] = [
  "contact",
  "experience",
  "education",
  "skills",
  "summary",
  "render",
];

describe("corpus round-trip invariants (#293)", () => {
  const fixtures = walkPdfs(FIXTURE_ROOT);

  it("finds fixtures to round-trip", () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  it("every KNOWN_FAILURES key names a real fixture", () => {
    const rel = new Set(fixtures.map((f) => relative(FIXTURE_ROOT, f)));
    for (const key of Object.keys(KNOWN_FAILURES))
      expect(rel.has(key), `stale KNOWN_FAILURES key: ${key}`).toBe(true);
  });

  for (const fixture of fixtures) {
    const rel = relative(FIXTURE_ROOT, fixture);
    it(`round-trips: ${rel}`, async () => {
      const p1 = await runCascade(new Uint8Array(readFileSync(fixture)));
      const model = buildAtsResumeModel(p1, scoreFor(p1));

      let fails: Record<Category, string[]>;
      try {
        const p3 = await runCascade(await renderAtsResumePdf(model));
        fails = { ...invariantFailures(p1, p3), render: [] };
      } catch (err) {
        // A render crash pre-empts every field invariant; record it as the
        // single `render` failure so the baseline/ratchet logic below handles it
        // uniformly.
        fails = {
          contact: [],
          experience: [],
          education: [],
          skills: [],
          summary: [],
          render: [`renderAtsResumePdf threw: ${(err as Error).message}`],
        };
      }
      const baseline = new Set(KNOWN_FAILURES[rel] ?? []);

      for (const cat of CATEGORIES) {
        const failing = fails[cat].length > 0;
        if (baseline.has(cat)) {
          // Ratchet: a baselined category that now passes means the underlying
          // bug was fixed — delete its line from KNOWN_FAILURES to tighten the
          // gate. (This intentionally fails until the stale entry is removed.)
          expect(
            failing,
            `${rel}: '${cat}' now round-trips — remove it from KNOWN_FAILURES`,
          ).toBe(true);
        } else {
          // The teeth: any non-baselined category must round-trip cleanly.
          expect(
            fails[cat],
            `${rel}: '${cat}' regressed:\n  ${fails[cat].join("\n  ")}`,
          ).toEqual([]);
        }
      }
    });
  }
});

/**
 * Dev triage harness — inert in CI, runs ONLY when `RL_RT_PDF=<path>` is set:
 *
 *   RL_RT_PDF=/path/to/real-resume.pdf npx vitest run \
 *     src/lib/heuristics/corpus-roundtrip.test.ts
 *
 * Dumps the per-category parse1-vs-parse3 diff for one arbitrary PDF, so a
 * real (uncommitted, possibly PII-bearing) résumé can be round-trip-audited
 * WITHOUT being committed as a fixture. This is how the education (#291) and
 * summary (#292) regressions were originally localized. Kept out of the corpus
 * gate above precisely because the input may carry PII.
 */
describe.runIf(process.env.RL_RT_PDF)("round-trip dev harness (RL_RT_PDF)", () => {
  it("dumps the parse1-vs-parse3 diff for RL_RT_PDF", async () => {
    const path = process.env.RL_RT_PDF!;
    const p1 = await runCascade(new Uint8Array(readFileSync(path)));
    const model = buildAtsResumeModel(p1, scoreFor(p1));
    const p3 = await runCascade(await renderAtsResumePdf(model));
    const fails = invariantFailures(p1, p3);
    const summary = Object.fromEntries(
      (Object.keys(fails) as Exclude<Category, "render">[])
        .filter((c) => fails[c].length > 0)
        .map((c) => [c, fails[c]]),
    );
    console.log(
      `RL_RT_PDF round-trip diff for ${path}:\n` +
        (Object.keys(summary).length
          ? JSON.stringify(summary, null, 2)
          : "clean — all invariants round-trip"),
    );
    // Informational only: never fails, so a PII résumé with known bugs doesn't
    // redden the suite.
    expect(true).toBe(true);
  });
});
