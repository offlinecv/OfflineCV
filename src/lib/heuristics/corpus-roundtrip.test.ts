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

import { readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, basename } from "node:path";
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

  // Multiple: experience swap, skills +1. (The education "institution
  // pollution" — "University of California" → "… · Berkeley, CA" glued — was
  // fixed by teaching `stripInstitutionLocation` the " · " middot boundary the
  // reconstructed education sub-line emits, #294; education now round-trips.)
  "google-docs/google-docs-skia-proxy-programs-skills-software.pdf": [
    "experience",
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

/** Contact scalar-field diffs (name/email/phone/location/linkedin). */
function contactFails(
  c1: CascadeResult["parsed"],
  c3: CascadeResult["parsed"],
): string[] {
  const out: string[] = [];
  for (const k of [
    "full_name",
    "email",
    "phone",
    "location",
    "linkedin_url",
  ] as const) {
    if (!same(c1[k], c3[k]))
      out.push(`${k}: ${JSON.stringify(c1[k])} → ${JSON.stringify(c3[k])}`);
  }
  return out;
}

/** Ordered-entry-list diff (shared by experience and education): a count
 *  mismatch, else per-field inequality at each index. */
function entryListFails<T>(
  a1: readonly T[],
  a3: readonly T[],
  keys: readonly (keyof T)[],
  label: string,
): string[] {
  if (a1.length !== a3.length)
    return [`${label} count ${a1.length} → ${a3.length}`];
  const out: string[] = [];
  a1.forEach((r, i) => {
    for (const k of keys)
      if (!same(r[k], a3[i]?.[k])) out.push(`${label}[${i}].${String(k)}`);
  });
  return out;
}

/** Summary length drift ≥ 5% (the round-trip truncation signal, #292). */
function summaryFails(s1: string, s3: string): string[] {
  if (s1.length === 0) return [];
  const deltaPct = (100 * Math.abs(s1.length - s3.length)) / s1.length;
  return deltaPct >= 5
    ? [`|Δ| ${deltaPct.toFixed(1)}% (${s1.length} → ${s3.length})`]
    : [];
}

/** Collect per-category failure messages for one round-trip. Empty array for a
 *  category ⇒ that invariant holds. */
function invariantFailures(
  p1: CascadeResult,
  p3: CascadeResult,
): Record<Exclude<Category, "render">, string[]> {
  const c1 = p1.parsed;
  const c3 = p3.parsed;
  const sk1 = (c1.skills ?? []).length;
  const sk3 = (c3.skills ?? []).length;
  return {
    contact: contactFails(c1, c3),
    experience: entryListFails(
      c1.experience ?? [],
      c3.experience ?? [],
      ["title", "company", "start_date", "end_date"] as const,
      "role",
    ),
    education: entryListFails(
      c1.education ?? [],
      c3.education ?? [],
      ["degree", "field", "institution"] as const,
      "entry",
    ),
    skills: sk1 !== sk3 ? [`count ${sk1} → ${sk3}`] : [],
    summary: summaryFails(c1.summary ?? "", c3.summary ?? ""),
  };
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
 *   RL_RT_PDF=/path/to/real-resume.pdf [RL_RT_ROUNDS=2] npx vitest run \
 *     src/lib/heuristics/corpus-roundtrip.test.ts
 *
 * Round-trip-audits one arbitrary PDF, so a real (uncommitted, possibly
 * PII-bearing) résumé can be triaged WITHOUT being committed as a fixture. This
 * is how the education (#291) and summary (#292) regressions were originally
 * localized. Kept out of the corpus gate above precisely because the input may
 * carry PII.
 *
 * `RL_RT_ROUNDS` (default 1) is the number of render→re-parse HOPS:
 *   - 1 hop  = parse1 → render → parse2                    (2 parses)
 *   - 2 hops = parse1 → render → parse2 → render → parse3  (3 parses)
 * A second hop surfaces corruption that only compounds once a reconstructed PDF
 * is itself re-reconstructed (the parse→export→parse→export→parse cycle).
 *
 * Unlike the corpus gate above (which asserts field MAPPING, never dumping
 * values), this harness prints per-hop field-level VALUE diffs (before → after)
 * so the exact corruption is visible — that output carries PII by design.
 *
 * The full JSON report is written to a gitignored scratch dir (`internal/` is
 * gitignored; default `internal/roundtrip/`, override with `RL_RT_OUT=<dir>`).
 * ⚠️ Both the input PDF and this JSON carry PII — NEVER commit either.
 */

/** Ordered-entry value diff (experience/education): a count mismatch, else the
 *  changed field VALUES `before → after` at each index. Unlike `entryListFails`
 *  above (mapping-only, prints field names) this prints values, so it is
 *  harness-only — never used by the PII-free corpus gate. */
function entryValueFails<T>(
  a1: readonly T[],
  a3: readonly T[],
  keys: readonly (keyof T)[],
  label: string,
): string[] {
  if (a1.length !== a3.length)
    return [`${label} count ${a1.length} → ${a3.length}`];
  const out: string[] = [];
  a1.forEach((r, i) => {
    for (const k of keys)
      if (!same(r[k], a3[i]?.[k]))
        out.push(
          `${label}[${i}].${String(k)}: ${JSON.stringify(r[k])} → ${JSON.stringify(a3[i]?.[k])}`,
        );
  });
  return out;
}

/** Skills value diff: the count delta plus the added/removed tokens. */
function skillsValueFails(s1: readonly string[], s3: readonly string[]): string[] {
  const set1 = new Set(s1);
  const set3 = new Set(s3);
  const removed = s1.filter((s) => !set3.has(s));
  const added = s3.filter((s) => !set1.has(s));
  if (removed.length === 0 && added.length === 0) return [];
  const out = [`count ${s1.length} → ${s3.length}`];
  if (removed.length) out.push(`removed: ${JSON.stringify(removed)}`);
  if (added.length) out.push(`added: ${JSON.stringify(added)}`);
  return out;
}

/** Per-category before → after VALUE diff for one hop. */
function harnessDiff(
  before: CascadeResult,
  after: CascadeResult,
): Record<Exclude<Category, "render">, string[]> {
  const c1 = before.parsed;
  const c3 = after.parsed;
  return {
    contact: contactFails(c1, c3),
    experience: entryValueFails(
      c1.experience ?? [],
      c3.experience ?? [],
      ["title", "company", "start_date", "end_date"] as const,
      "role",
    ),
    education: entryValueFails(
      c1.education ?? [],
      c3.education ?? [],
      ["degree", "field", "institution"] as const,
      "entry",
    ),
    skills: skillsValueFails(c1.skills ?? [], c3.skills ?? []),
    summary: summaryFails(c1.summary ?? "", c3.summary ?? ""),
  };
}

describe.runIf(process.env.RL_RT_PDF)("round-trip dev harness (RL_RT_PDF)", () => {
  it("dumps per-hop field-value diffs for RL_RT_PDF", async () => {
    const path = process.env.RL_RT_PDF!;
    // Number of render→re-parse hops; clamp to ≥ 1.
    const rounds = Math.max(1, Math.trunc(Number(process.env.RL_RT_ROUNDS ?? "1")) || 1);
    const outDir =
      process.env.RL_RT_OUT ?? join(HERE, "../../..", "internal/roundtrip");

    // parses[0] = parse1 (source); parses[n] = re-parse after the nth render hop.
    const parses: CascadeResult[] = [
      await runCascade(new Uint8Array(readFileSync(path))),
    ];
    let renderError: string | undefined;
    for (let hop = 1; hop <= rounds; hop++) {
      const prev = parses[parses.length - 1];
      const model = buildAtsResumeModel(prev, scoreFor(prev));
      try {
        parses.push(await runCascade(await renderAtsResumePdf(model)));
      } catch (err) {
        renderError = `renderAtsResumePdf threw on hop ${hop}: ${(err as Error).message}`;
        break;
      }
    }

    type HopReport = {
      hop: number;
      from: string;
      to: string;
      diff: Partial<Record<Exclude<Category, "render">, string[]>>;
    };
    const hops: HopReport[] = [];
    for (let hop = 1; hop < parses.length; hop++) {
      const fails = harnessDiff(parses[hop - 1], parses[hop]);
      const diff = Object.fromEntries(
        (Object.keys(fails) as Exclude<Category, "render">[])
          .filter((c) => fails[c].length > 0)
          .map((c) => [c, fails[c]]),
      );
      hops.push({ hop, from: `parse${hop}`, to: `parse${hop + 1}`, diff });
    }

    const report = { path, rounds, renderError, hops };

    // Full JSON → gitignored scratch (carries PII by design).
    mkdirSync(outDir, { recursive: true });
    const outFile = join(
      outDir,
      `roundtrip-${basename(path).replace(/\.[^.]+$/, "")}-r${rounds}.json`,
    );
    writeFileSync(outFile, JSON.stringify(report, null, 2));

    const console_lines = hops.map((h) =>
      Object.keys(h.diff).length
        ? `  hop ${h.hop} (${h.from} → ${h.to}):\n${JSON.stringify(h.diff, null, 2)
            .split("\n")
            .map((l) => `    ${l}`)
            .join("\n")}`
        : `  hop ${h.hop} (${h.from} → ${h.to}): clean — all invariants round-trip`,
    );
    console.log(
      `RL_RT_PDF round-trip diff for ${path} (${rounds} hop${rounds > 1 ? "s" : ""}):\n` +
        (renderError ? `  ⚠️ ${renderError}\n` : "") +
        (console_lines.length ? console_lines.join("\n") : "  (no hops ran)") +
        `\n\nFull JSON → ${outFile}  ⚠️ gitignored; carries PII, do NOT commit.`,
    );
    // Informational only: never fails, so a PII résumé with known bugs doesn't
    // redden the suite.
    expect(true).toBe(true);
  });
});
