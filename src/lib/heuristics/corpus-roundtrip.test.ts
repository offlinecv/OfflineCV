// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

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

import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";
import { runCascade } from "./cascade.ts";
import type { CascadeResult } from "./types.ts";
import { runRoundtripHop } from "./roundtrip-hop.ts";
import type { RoundtripCategory } from "./localize/roundtrip.ts";
import { invariantFailures, harnessDiff } from "./localize/roundtrip.ts";
import {
  FIXTURE_ROOT,
  walkPdfs,
  relKey,
  assertNoStaleKeys,
  assertRatchet,
  baselineCategories,
  loadKnownFailures,
} from "./corpus-gate.test-utils.ts";
import knownFailuresFile from "./corpus-roundtrip.known-failures.json";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Re-exported for readability at this file's original name; the type itself
 *  now lives at `./localize/roundtrip.ts` (issue #469 step 4) so the shared
 *  detector logic and its category type travel together. */
type Category = RoundtripCategory;

/**
 * Per-fixture invariant categories currently allowed to fail, loaded from the
 * ISSUE-LINKED baseline (`./corpus-roundtrip.known-failures.json`, #654).
 *
 * The map used to be a TypeScript literal whose reasoning lived in comments; it
 * is JSON now for one reason: an exemption whose issue has since been CLOSED is
 * orphaned baseline, no test can see that (issue state lives on GitHub), and CI
 * cannot import a `.ts` test module to check it. `scripts/check-known-failures.mjs`
 * reads the JSON directly. Each entry carries `{category, issue, status, note}` —
 * the prose that used to float in a comment block now sits on the entry it
 * explains. `loadKnownFailures` validates the shape and pins the file's
 * `categories` list against `CATEGORIES` below, so the two cannot drift.
 *
 * Shrink it as the follow-up round-trip bugs are fixed — a fixed bug makes its
 * category pass, which trips the stale-entry check and forces the entry's removal.
 *
 * ── What has already been retired here, kept because a reader will wonder ──
 * The experience header title/company SWAP (#298) is FIXED: `disambiguateCompanyTitle`
 * uses the date-anchor line position as a tiebreak, so the reconstructed stacked
 * shape re-segments to the title/company it was built from. The skills-line token
 * split (#299/#E) is fixed by #301 (`wrap()` keeps each " · "-delimited skill
 * atomic). The total re-parse collapse (#296) is fixed by removing the spurious
 * `avgItems < 15` arm from `probeScanned`. Education "institution pollution" was
 * fixed in #294 via the " · " middot boundary. The awesome-cv "Expected" end-date
 * qualifier was absorbed into `DATE_RANGE_RE` by #383. Both #436 one-line-header
 * roots — the neutral two-segment middot SWAP and the wrapped-org TRUNCATION —
 * landed (#495 plus the renderer's conditional date-column reservation and
 * `tryFoldCompleteDateHeader`), which is why only the entries in the JSON remain.
 */
const CATEGORIES: Category[] = [
  "contact",
  "experience",
  "education",
  "skills",
  "summary",
  "render",
];

const KNOWN_FAILURES = loadKnownFailures<Category>(knownFailuresFile, CATEGORIES);

// Fixture-read + full runCascade→render→runCascade round-trip per fixture is
// slow under a coverage-instrumented full-suite `verify` run; scope a higher
// timeout to just this suite rather than bumping vitest's global default (#360).
describe("corpus round-trip invariants (#293)", { timeout: 20000 }, () => {
  const fixtures = walkPdfs(FIXTURE_ROOT);

  it("finds fixtures to round-trip", () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  it("every KNOWN_FAILURES key names a real fixture", () => {
    assertNoStaleKeys(KNOWN_FAILURES, fixtures);
  });

  for (const fixture of fixtures) {
    const rel = relKey(fixture);
    it(`round-trips: ${rel}`, async () => {
      const p1 = await runCascade(new Uint8Array(readFileSync(fixture)));
      // The one shared render → re-parse hop (`./roundtrip-hop.ts`), also used
      // by the corpus bake's `derived` block (#469 step 5).
      const { after: p3, renderError } = await runRoundtripHop(p1);

      // A render crash pre-empts every field invariant; record it as the single
      // `render` failure so the baseline/ratchet logic below handles it
      // uniformly.
      const fails: Record<Category, string[]> =
        p3 && !renderError
          ? { ...invariantFailures(p1, p3), render: [] }
          : {
              contact: [],
              experience: [],
              education: [],
              skills: [],
              summary: [],
              render: [renderError ?? "renderAtsResumePdf produced no parse"],
            };
      // Shared ratchet (#459): non-baselined category must pass; a baselined
      // category that now passes fails with "remove it from KNOWN_FAILURES".
      assertRatchet(rel, CATEGORIES, fails, baselineCategories(KNOWN_FAILURES, rel));
    });
  }
});

/**
 * Skills category round-trip (#473). The whole-corpus ratchet above pins the
 * FLAT invariants only; the structured category view is new, so this asserts
 * directly that a categorised résumé's `skillCategories` survives the
 * parse → export → re-parse hop intact — the exported PDF renders one
 * `Label: a · b · c` row per category, and re-parsing recovers the same
 * labels and members (not just the same flat skills).
 *
 * PII-free: the fixture is a synthetic persona; labels/counts are asserted, no
 * value snapshot is dumped.
 */
describe("skills categories round-trip (#473)", () => {
  const CATEGORISED_FIXTURE = join(
    FIXTURE_ROOT,
    "unknown",
    "bulleted-labelled-single-column-skills.pdf",
  );

  it("re-parses the categorised fixture to the same categories", async () => {
    const before = await runCascade(
      new Uint8Array(readFileSync(CATEGORISED_FIXTURE)),
    );
    const cats = before.canonical.fields.skillCategories;

    // The categories the parser captured, and their coherence invariant.
    expect(cats?.map((c) => c.label)).toEqual([
      "Frontend",
      "Frontend Testing",
      "Backend",
      "Cloud & Infra",
      "Databases & Caching",
      "Product & Collaboration",
      "Data & Analytics",
    ]);
    expect(before.canonical.fields.skills).toEqual(
      cats!.flatMap((c) => c.skills),
    );

    // parse → export → re-parse recovers the SAME category structure.
    const { after, renderError } = await runRoundtripHop(before);
    expect(renderError).toBeUndefined();
    expect(after?.canonical.fields.skillCategories).toEqual(cats);
  });
});

/**
 * Certifications round-trip (#884). Same reason the skills-category hop above
 * has its own block: the whole-corpus ratchet pins contact / experience /
 * education / skills / summary, and the credential buckets are in none of those
 * categories — so nothing there would notice certifications coming back in the
 * WRONG bucket.
 *
 * What makes the hop non-trivial is that the bucket survives only because the
 * exporter draws the source's VERBATIM heading. Under the pre-#884 fold this
 * fixture exported the literal word "Achievements" over its certifications, and
 * a re-parse of that PDF put them in the achievements bucket — the parse was
 * lossy in one direction and self-consistently wrong in the other.
 *
 * PII-free: the fixture is a synthetic persona; only counts are asserted.
 */
describe("certifications round-trip (#884)", () => {
  const CERTIFICATIONS_FIXTURE = join(
    FIXTURE_ROOT,
    "google-docs",
    "google-docs-skia-proxy-certifications.pdf",
  );

  it("re-parses an exported Certifications section back into its own bucket", async () => {
    const before = await runCascade(
      new Uint8Array(readFileSync(CERTIFICATIONS_FIXTURE)),
    );
    const certCount = before.canonical.fields.heuristic_certifications?.length;
    expect(certCount).toBeGreaterThan(0);
    expect(before.canonical.fields.heuristic_achievements).toBeUndefined();

    const { after, renderError } = await runRoundtripHop(before);
    expect(renderError).toBeUndefined();
    expect(after?.canonical.fields.heuristic_certifications?.length).toBe(
      certCount,
    );
    expect(after?.canonical.fields.heuristic_achievements).toBeUndefined();
  });
});

/**
 * Institution-led education with HINT-LESS schools (#882).
 *
 * The whole-corpus ratchet above compares parse1 against parse3, so it can only
 * see a round-trip that CHANGES something. This entry shape needs the other half
 * of the proof too — that parse1 is right in the FIRST place — because the two
 * halves fail together and the ratchet is blind to that:
 *
 *   • #882 flips a degreed education entry to lead with the INSTITUTION, dated
 *     flush-right on that line, degree beneath. That is what the widely-copied
 *     templates do and what the exporter now emits.
 *   • The segmenter's institution cue is `INSTITUTION_HINTS`
 *     (`University|College|Institute|School|Academy|Polytechnic`), which matches
 *     none of `Caltech`, `MIT`, `Georgia Tech`. Under DEGREE-first ordering the
 *     shortfall was invisible — the degree line led, and the degree-repeat flush
 *     found every boundary. Under INSTITUTION-first the boundary lands one line
 *     earlier than any cue that can see it.
 *
 * Measured on this fixture BEFORE the institution-lead cue existed: three
 * entries came back as three chunks whose degrees were paired with the WRONG
 * schools ("Georgia Tech" carrying MIT's `M.S.`) and whose third institution was
 * the tail of a degree line (", Computer Science, cum laude"). The COUNT was
 * right the whole time. So a count-only assertion proves nothing here, and this
 * block asserts the pairing.
 *
 * PII-free: synthetic persona (`scripts/fixtures/gen-education-hintless-institution-lead.mjs`);
 * the asserted strings are institution/degree names, synthetic by policy.
 */
describe("hint-less institution-led education (#882)", () => {
  const FIXTURE = join(
    FIXTURE_ROOT,
    "unknown",
    "education-hintless-institution-lead.pdf",
  );

  /** `[institution, degree, field]` per entry, in document order. */
  const EXPECTED = [
    ["Caltech", "Ph.D.", "Applied Mathematics"],
    ["MIT", "M.S.", "Computer Science"],
    ["Georgia Tech", "B.S.", "Computer Science"],
  ];

  it("parses three hint-less schools as three entries, each with its own degree", async () => {
    const before = await runCascade(new Uint8Array(readFileSync(FIXTURE)));
    const edu = before.canonical.fields.education ?? [];
    expect(edu.map((e) => [e.institution, e.degree, e.field])).toEqual(EXPECTED);
    // The open-ended range keeps its ongoing flag rather than collapsing to a
    // bare start date (#882) — `ResumeEducation.is_current` did not exist before.
    expect(edu[0]?.is_current).toBe(true);
    expect(edu[0]?.start_date).toBe("Sep 2022");
    // The lone MONTH-YEAR shape, which used to draw glued: recovered whole.
    expect(edu[1]?.end_date).toBe("May 2022");
  });

  it("re-exports and re-parses to the SAME three entries — 3 in, 3 out", async () => {
    const before = await runCascade(new Uint8Array(readFileSync(FIXTURE)));
    const { after, renderError } = await runRoundtripHop(before);
    expect(renderError).toBeUndefined();
    const edu = after?.canonical.fields.education ?? [];
    expect(edu.map((e) => [e.institution, e.degree, e.field])).toEqual(EXPECTED);
    expect(edu[0]?.is_current).toBe(true);
    expect(edu[2]?.gpa).toBe("3.72/4.00");
    expect(edu[2]?.honors).toBe("cum laude");
  });
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

// `entryValueFails` / `skillsValueFails` / `harnessDiff` are imported from
// `./localize/roundtrip.ts` (issue #469 step 4) — see that module's header
// for why the value-level diffs live there alongside the mapping-only ones
// the corpus gate above uses.

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
      const res = await runRoundtripHop(prev);
      if (!res.after || res.renderError) {
        renderError = (res.renderError ?? "renderAtsResumePdf produced no parse").replace(
          /^renderAtsResumePdf threw:/,
          `renderAtsResumePdf threw on hop ${hop}:`,
        );
        break;
      }
      parses.push(res.after);
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
