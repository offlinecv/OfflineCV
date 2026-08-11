// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Snapshot-driven corpus regression test (#1).
 *
 * Walks `tests/fixtures/pdfs/<category>/*.pdf`, runs `runCascade` +
 * `computeAnonymousAtsScore` against each file, and diffs the result against
 * a co-located `*.expected.json` snapshot.
 *
 * The snapshot shape is deliberately lossy: counts, field-presence flags, and
 * dimension numbers — never raw text or field values. That keeps the test
 * deterministic, fast to review in PRs, and free of PII so contributors can
 * inspect fixtures without leaking persona content.
 *
 * Workflow:
 *   - Add a PDF under `tests/fixtures/pdfs/<category>/<name>.pdf`.
 *   - `npm run bake-fixtures` (sets `UPDATE_FIXTURES=1`) writes
 *     `<name>.expected.json` next to it.
 *   - `npm run test` (no env) diffs subsequent runs against the snapshot.
 *
 * ── The GROUND-TRUTH pass (#654) rides the same walk ──
 * Everything above measures CHANGE: the snapshot is lossy on purpose, so a
 * fixture whose company is parsed as its city passes forever as long as it keeps
 * being parsed that way. The truth pass measures CORRECTNESS instead — it diffs
 * the parse against a hand-authored `<name>.truth.json` stating what the PDF
 * actually says, and fails any field that disagrees without a `knownWrong`
 * exemption. It runs INSIDE the per-fixture `it` above, off the same parse, and
 * BEFORE the bake's early return; a standalone suite would re-parse all 57 PDFs.
 * See `__test-utils__/ground-truth.ts` for the model, and the scoreboard suite at
 * the bottom of this file for exactly what is enforced versus only reported.
 */

import { promises as fsp, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { runCascade } from "./cascade.ts";
import { computeAnonymousAtsScore } from "../score/score.ts";
import type { CascadeResult, HeuristicParsedResume } from "./types.ts";
import { buildReproArtifact } from "./repro-artifact.ts";
import type { DerivedSignals } from "./defect-classes.ts";
import { sweepParse } from "./sweep.ts";
import { runRoundtripHop } from "./roundtrip-hop.ts";
import { CORPUS_SNAPSHOT_SCHEMA_VERSION } from "./__test-utils__/corpus-snapshots.ts";
import {
  readOriginJson,
  reproTestsReferencingIssue,
  type OriginJson,
} from "./__test-utils__/origin-links.ts";
import {
  TRUTH_FIELDS,
  addTo,
  emptyTotals,
  formatScoreboard,
  isExact,
  precision,
  readTruth,
  recall,
  scoreAgainstTruth,
  unfiledFields,
  type TruthTotals,
} from "./__test-utils__/ground-truth.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "../../..");
const FIXTURE_ROOT = join(REPO_ROOT, "tests/fixtures/pdfs");
const UPDATE = process.env.UPDATE_FIXTURES === "1";

/** Bump when the snapshot shape below changes so existing .expected.json
 *  files visibly fail until re-baked.
 *  - v2 (#95): added `cascade.projectsCount`; Projects section is now
 *    extracted, so `fieldsPopulated` may include `projects`.
 *  - v3 (#96): added `cascade.achievementsCount`; the Achievements family
 *    (achievements/accomplishments/awards/activities) is promoted out of the
 *    `other` sink into a real extracted section, so `fieldsPopulated` may now
 *    include `heuristic_achievements`.
 *  - v4 (#425 follow-up): the parser now lifts a standalone header headline
 *    ("Engineering Lead") from the profile block via `extractHeadline`, so
 *    `fieldsPopulated` may include `headline` on résumés that carry one.
 *  - v5 (#469): added the `reproArtifact` block (`buildReproArtifact`, the
 *    structure-only parse fingerprint) and the `derived` block (the flat,
 *    boolean-only `DerivedSignals` — the value-level signals the artifact is
 *    structurally blind to, including the export → re-parse round-trip hop).
 *    Together they make each fixture a `CorpusEntry` the `/probe-resume` sweep
 *    (`fixture-match.ts`) can match a real résumé's defects against WITHOUT
 *    re-parsing 45 PDFs. Both blocks are PII-free BY TYPE — numbers, booleans,
 *    fixed enums, no free-form string slot — so the snapshots stay "lossy by
 *    design, never field values". */
const SNAPSHOT_SCHEMA_VERSION = CORPUS_SNAPSHOT_SCHEMA_VERSION;

/**
 * The full `DerivedSignals` bag for one fixture — every key in
 * `DERIVED_SIGNAL_KEYS`, no more and no fewer (`loadCorpus()` rejects a snapshot
 * missing any of them, so the count is pinned mechanically and this comment
 * cannot rot into a wrong number).
 *
 * Computed by `sweepParse()` — the SAME function `/probe-resume` runs over the
 * real résumé. That identity is not tidiness: it is what puts the résumé and the
 * fixtures on the same axes, without which every coverage answer the sweep prints
 * would be comparing two different things.
 *
 * A localizer never renders or re-parses — the caller performs the hop
 * (`runRoundtripHop`), which NEVER throws: a crash in any of its four layers is
 * DATA (`renderThrewOnRoundtrip: true` + `roundtripOracleUnavailable: true`),
 * never a bake failure.
 */
async function bakeDerived(cascade: CascadeResult): Promise<DerivedSignals> {
  return sweepParse(cascade, await runRoundtripHop(cascade)).derived;
}

function walkPdfs(dir: string): string[] {
  const out: string[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walkPdfs(p));
    else if (e.isFile() && e.name.toLowerCase().endsWith(".pdf")) out.push(p);
  }
  return out.sort();
}

function fieldsPopulated(parsed: HeuristicParsedResume): string[] {
  const keys: string[] = [];
  for (const [k, v] of Object.entries(parsed)) {
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v) && v.length === 0) continue;
    // `profiles` (#335) is an additive mirror of the four legacy `*_url` link
    // keys — it carries no new field-presence signal, so it is excluded here to
    // keep the Phase-1 migration snapshot-safe (no re-bake). Phase 2 flips the
    // legacy keys to `profiles` and re-bakes the corpus deliberately.
    if (k === "profiles") continue;
    // `skillCategories` (#473) is an additive STRUCTURED view over `skills` — it
    // carries no new field-presence signal (its presence implies `skills`), so
    // it is excluded here to keep the snapshot migration-safe: a categorised
    // fixture's `fieldsPopulated` does not move, no re-bake needed.
    if (k === "skillCategories") continue;
    keys.push(k);
  }
  return keys.sort();
}

const pdfs = walkPdfs(FIXTURE_ROOT);

/**
 * Annotation floor for the ground-truth pass (#654).
 *
 * The corpus is annotated INCREMENTALLY — hand-reading 57 PDFs is the dominant
 * cost of this work — so an un-annotated fixture is a reported gap, not a
 * failure. This is the ratchet on the other side: the number of annotated
 * fixtures may only go UP. Without it, "the scoreboard is red, delete the truth
 * file" is a one-line fix, and a measurement anyone can switch off measures
 * nothing. Raise it when you annotate more; never lower it.
 */
const TRUTH_ANNOTATED_FLOOR = 15;

/**
 * The same ratchet one level down: annotated FIELDS, not files.
 *
 * A file floor alone is evadable without deleting anything — gut a truth file to
 * `"unannotated": [<every field>]` and the file still counts while measuring
 * nothing, which is cheaper than deleting it and far less visible in a diff.
 * (`readTruth` now rejects the fully-gutted case outright; this bounds the
 * partial one, where a handful of inconvenient fields are quietly retired.)
 * Raise it when you annotate more; never lower it.
 */
const TRUTH_ANNOTATED_FIELD_FLOOR = 150;

/**
 * Ceiling on `knownWrong` entries with `status: "unfiled"` — a wrong parse that
 * has been measured but not yet filed as an issue.
 *
 * The state exists because the first run of this harness found eleven
 * disagreements across fifteen fixtures, and most were not described by any open
 * issue. Refusing to record them would have hidden the very thing the harness was
 * built to surface; inventing issue numbers, or calling a live bug "accepted",
 * would have been worse. So they are recorded, printed by
 * `npm run check:baselines` on every run, and bounded here — undescribed debt may
 * not GROW. File the issue and flip the entry to `open`; then lower this.
 */
const UNFILED_TRUTH_CEILING = 10;

/** Generator category = the fixture root's immediate subdirectory. */
function categoryOf(repoRelPdfPath: string): string {
  return relative(FIXTURE_ROOT, join(REPO_ROOT, repoRelPdfPath)).split("/")[0];
}

const truthTotals = new Map<string, TruthTotals>();
const truthAll = emptyTotals();
let annotatedCount = 0;
let annotatedFieldCount = 0;
let unfiledCount = 0;

function recordTruth(
  category: string,
  scores: ReturnType<typeof scoreAgainstTruth>,
): void {
  if (!truthTotals.has(category)) truthTotals.set(category, emptyTotals());
  addTo(truthTotals.get(category)!, scores);
  addTo(truthAll, scores);
  annotatedCount++;
}


/**
 * The ONLY corpus fixtures whose page actually states a work-authorization line
 * (#792), with the statement quoted so an entry can be checked against the PDF
 * rather than trusted.
 *
 * This map is an over-match guard, and it is deliberately an allow-list rather
 * than a snapshot key: `work_authorization` writes a legal claim onto someone's
 * résumé and into the PDF they send to employers, so a false positive is far
 * worse than a miss. Every fixture NOT listed here must come back with the key
 * absent. If a matcher change makes a new fixture "detect" one, the assertion
 * fails and the right response is to read the PDF — adding a line here without
 * doing that defeats the guard.
 */
const STATES_WORK_AUTHORIZATION: ReadonlyMap<string, string> = new Map([
  // Contact line: "973-555-0123 | jordan.bennett@example.com | LinkedIn | GitHub | US Citizen"
  ["tests/fixtures/pdfs/latex/multi-degree-coursework.pdf", "US Citizen"],
]);

describe("corpus snapshots", () => {
  if (pdfs.length === 0) {
    // Empty corpus is a valid state — keeps CI green between adding the
    // harness and seeding fixtures. Add a PDF under
    // tests/fixtures/pdfs/<category>/ and `npm run bake-fixtures`.
    it.skip("no fixtures present — drop PDFs under tests/fixtures/pdfs/<category>/", () => {});
    return;
  }

  for (const pdfPath of pdfs) {
    const rel = relative(REPO_ROOT, pdfPath);
    const expectedPath = pdfPath.replace(/\.pdf$/i, ".expected.json");

    describe(rel, () => {
      it(
        "cascade + score match the snapshot",
        async () => {
          const bytes = await fsp.readFile(pdfPath);
          const cascade = await runCascade(new Uint8Array(bytes));

          // #792 over-match guard — see `STATES_WORK_AUTHORIZATION`. Asserted
          // here rather than through the snapshot because the snapshot records
          // only that a field is populated, never its value, and the value is
          // the part that would be a fabricated legal claim.
          expect(
            cascade.canonical.fields.work_authorization,
            `${rel}: work_authorization must stay absent unless the page states ` +
              `one. Read the PDF before adding it to STATES_WORK_AUTHORIZATION.`,
          ).toBe(STATES_WORK_AUTHORIZATION.get(rel));

          const score = computeAnonymousAtsScore({
            parsed: {
              full_name: cascade.canonical.fields.full_name,
              email: cascade.canonical.fields.email,
              phone: cascade.canonical.fields.phone,
              location: cascade.canonical.fields.location,
              linkedin_url: cascade.canonical.fields.linkedin_url,
              summary: cascade.canonical.fields.summary,
              skills: cascade.canonical.fields.skills,
              experience: cascade.canonical.fields.experience,
              education: cascade.canonical.fields.education,
            },
            fieldConfidence: cascade.canonical.fieldConfidence,
            triggers: cascade.triggers,
            rawText: cascade.rawText,
            sections: cascade.canonical.sections,
          });

          const snapshot = {
            schemaVersion: SNAPSHOT_SCHEMA_VERSION,
            cascade: {
              confidence: Math.round(cascade.confidence * 100) / 100,
              triggers: [...cascade.triggers],
              tiers: [...cascade.tiers],
              suggestedEscalation: cascade.suggestedEscalation,
              fieldsPopulated: fieldsPopulated(cascade.canonical.fields),
              skillsCount: cascade.canonical.fields.skills?.length ?? 0,
              experienceCount: cascade.canonical.fields.experience?.length ?? 0,
              educationCount: cascade.canonical.fields.education?.length ?? 0,
              projectsCount: cascade.canonical.fields.projects?.length ?? 0,
              achievementsCount:
                cascade.canonical.fields.heuristic_achievements?.length ?? 0,
              rawTextCharCount: cascade.rawText.length,
              pageCount: cascade.diagnostics.pages,
              linkAnnotationCount: cascade.linkAnnotations.length,
              hasMarkdown: !!cascade.markdown,
              sectionSource: cascade.diagnostics.sectionSource ?? null,
            },
            score: {
              overall: score.overall,
              preLayoutOverall: score.preLayoutOverall,
              specificity: {
                score: score.specificity.score,
                max: score.specificity.max,
                gradable: score.specificity.gradable,
                metricBullets: score.specificity.metricBullets,
                totalBullets: score.specificity.totalBullets,
              },
              structure: {
                score: score.structure.score,
                max: score.structure.max,
                gradable: score.structure.gradable,
                goodBullets: score.structure.goodBullets,
                totalBullets: score.structure.totalBullets,
              },
              completeness: {
                score: score.completeness.score,
                max: score.completeness.max,
                gradable: score.completeness.gradable,
                missing: [...score.completeness.missing].sort(),
              },
              layout: {
                triggers: [...score.layout.triggers],
                multiplier: score.layout.multiplier,
                scanned: score.layout.scanned,
              },
              bulletCount: score.bullets?.length ?? 0,
              algoVersion: score.algoVersion ?? null,
            },
            // #469: the fixture's `CorpusEntry` payload — the structure-only
            // parse fingerprint plus the boolean-only value-level signals.
            reproArtifact: buildReproArtifact(cascade),
            derived: await bakeDerived(cascade),
          };

          // ── Ground truth (#654) ────────────────────────────────────────────
          // Runs off the SAME parse as the snapshot above — a standalone suite
          // would re-parse all 57 PDFs a second time — and BEFORE the bake's
          // early return, so `npm run bake-fixtures` cannot silently skip it.
          //
          // Note what is compared: the snapshot above is counts and flags, this
          // is VALUES. That is the whole difference between measuring change and
          // measuring correctness.
          const truth = readTruth(pdfPath);
          if (truth) {
            const parsedFields = cascade.canonical.fields;
            const scores = scoreAgainstTruth(truth, {
              full_name: parsedFields.full_name,
              email: parsedFields.email,
              phone: parsedFields.phone,
              location: parsedFields.location,
              experience: parsedFields.experience ?? [],
              education: parsedFields.education ?? [],
              skills: parsedFields.skills ?? [],
            });
            recordTruth(categoryOf(rel), scores);
            annotatedFieldCount +=
              TRUTH_FIELDS.length - (truth.unannotated?.length ?? 0);
            unfiledCount += unfiledFields(truth).length;

            // The ratchet, field by field. Same two teeth as the corpus gates:
            // an un-exempted field must be EXACT, and an exempted field that has
            // become exact must lose its exemption. The second tooth is what
            // stops `knownWrong` from becoming a graveyard — and it is why a
            // disagreement is recorded as an exemption rather than by editing
            // the truth file, which would make the fix undetectable.
            for (const field of TRUTH_FIELDS) {
              const s = scores[field];
              if (!s) continue; // listed in `unannotated` — no truth to check
              const exempt = truth.knownWrong?.[field];
              const detail =
                `expected ${s.expected}, parsed ${s.predicted}, matched ${s.matched}`;
              if (exempt) {
                expect(
                  isExact(s),
                  `${rel}: '${field}' now matches ground truth (${detail}) — ` +
                    `remove its knownWrong entry (cites #${exempt.issue})`,
                ).toBe(false);
              } else {
                expect(
                  isExact(s),
                  `${rel}: '${field}' does not match ground truth (${detail}). ` +
                    `Either the parser regressed, or this is a newly-found wrong ` +
                    `parse — in which case add a knownWrong entry naming the issue ` +
                    `that owns it. Do NOT edit the truth file to agree with the parser.`,
                ).toBe(true);
              }
            }
          }

          if (UPDATE) {
            await fsp.writeFile(
              expectedPath,
              JSON.stringify(snapshot, null, 2) + "\n",
            );
            return;
          }

          let expectedRaw: string;
          try {
            expectedRaw = await fsp.readFile(expectedPath, "utf8");
          } catch {
            throw new Error(
              `Missing snapshot for ${rel}.\n` +
                `Run \`npm run bake-fixtures\` to generate ` +
                `${relative(REPO_ROOT, expectedPath)} ` +
                `and commit it alongside the PDF.`,
            );
          }
          // ── The self-verifying bake. `derived` is RECOMPUTED here, per run,
          // and diffed against the committed golden — deliberately: a bake that
          // only ever writes and never checks would let a silently-changed
          // signal ship. Know what that couples the goldens to:
          //
          //   The nine `*ChangedAcrossRoundtrip` bits come from the export →
          //   re-parse hop, so they pin EXACT BITS of `pdf-lib`'s render output
          //   AND of the font-fallback path (the current goldens were baked with
          //   "Poppins font embed failed, falling back to Helvetica"). A pdf-lib
          //   bump, a font-loading fix, or a change to `render-ats-pdf.ts` can
          //   therefore turn corpus tests red WITHOUT any parser change.
          //
          // That is a FEATURE — the round-trip is a product invariant and a
          // silent change to it should be visible — but it is a different
          // contract from `corpus-roundtrip.test.ts`, which asserts round-trip
          // INVARIANTS (nothing may be lost) rather than exact bits.
          //
          // When such a red is expected and understood: re-run
          // `npm run bake-fixtures`, then diff the goldens and confirm the ONLY
          // moved keys are the round-trip ones. A moved parse/score/artifact key
          // in that diff is a real regression, not a re-bake artifact.
          const expected = JSON.parse(expectedRaw);
          expect(snapshot).toEqual(expected);
        },
        // PDF parse + score is fast for normal-sized resumes, but generous
        // ceiling so a slow CI runner doesn't false-fail on a 2MB LaTeX export.
        // Raised from 15s for #469: the snapshot's `derived` block needs the
        // export → re-parse hop, so each fixture now costs parse + render +
        // re-parse (the same budget `corpus-roundtrip.test.ts` runs on).
        25_000,
      );
    });
  }
});

/**
 * `.origin.json` breadcrumb enforcement (issue #39).
 *
 * A fixture DERIVED from a real résumé carries a sibling `<name>.origin.json`
 * naming the issue(s) it reproduces (see `__test-utils__/origin-links.ts`). The
 * `*.expected.json` golden is lossy by design and cannot catch a value-level
 * regression sneaking back, so the derived fixture's guard is its `*.repro.test.ts`.
 * This asserts that guard EXISTS: every issue a breadcrumb claims to reproduce
 * still has a live `src/lib/heuristics/*.repro.test.ts` referencing `#<issue>`.
 * A derived fixture that stops pinning its bug becomes a test failure here rather
 * than a silent hole.
 */
describe(".origin.json breadcrumbs pin a live repro test", () => {
  const withOrigin = pdfs
    .map((pdf) => ({ pdf, origin: readOriginJson(pdf) }))
    .filter(
      (x): x is { pdf: string; origin: OriginJson } =>
        x.origin !== null && x.origin.reproduces.length > 0,
    );

  if (withOrigin.length === 0) {
    // No derived fixtures carry a breadcrumb yet — the convention ships as
    // infrastructure ahead of the first `.origin.json`. Vacuously green.
    it.skip("no fixture carries a .origin.json with reproduces[] yet", () => {});
    return;
  }

  for (const { pdf, origin } of withOrigin) {
    const rel = relative(REPO_ROOT, pdf);
    it(`${rel}: each reproduced issue has a *.repro.test.ts`, () => {
      for (const issue of origin.reproduces) {
        const tests = reproTestsReferencingIssue(issue);
        expect(
          tests.length,
          `${rel} (ledger ${origin.ledgerId}) declares it reproduces #${issue}, ` +
            `but no src/lib/heuristics/*.repro.test.ts references #${issue}. ` +
            `A derived fixture that stops pinning its bug must fail here — either ` +
            `restore the repro test or update the .origin.json.`,
        ).toBeGreaterThan(0);
      }
    });
  }
});

/**
 * The scoreboard (#654) — printed, plus the two things it ENFORCES.
 *
 * Be precise about the split, because a number nothing can fail is a dashboard:
 *
 *   ENFORCED, per fixture, in the walk above — every annotated field must match
 *   ground truth exactly unless it carries a `knownWrong` exemption, and an
 *   exemption that has become exact must be deleted. That is where the teeth are.
 *   ENFORCED here — the number of ANNOTATED fixtures may only go up, so the
 *   cheapest way to make a red field green (delete the truth file) is a failure.
 *   REPORTED only — the precision/recall percentages themselves. They are not a
 *   threshold, deliberately: a per-field ratio over a corpus that is annotated
 *   incrementally moves when the DENOMINATOR changes, so a threshold on it would
 *   fire on annotating a hard fixture — punishing measurement. The per-field
 *   exactness gate above already makes every individual wrong parse a failure;
 *   the ratios exist to answer "which exporter and which field do we parse
 *   worst", which is a ranking question, not a pass/fail one.
 */
describe("ground-truth scoreboard (#654)", () => {
  afterAll(() => {
    if (annotatedCount === 0) return;
    const ordered = new Map([...truthTotals.entries()].sort());
    ordered.set("ALL", truthAll);
    console.log(
      formatScoreboard(ordered, { annotated: annotatedCount, total: pdfs.length }),
    );
  });

  it("annotated-fixture coverage does not shrink", () => {
    expect(
      annotatedCount,
      `only ${annotatedCount} of ${pdfs.length} fixtures carry a .truth.json ` +
        `(floor ${TRUTH_ANNOTATED_FLOOR}). Annotating is how first-parse ` +
        `correctness becomes measurable; deleting a truth file is not a fix.`,
    ).toBeGreaterThanOrEqual(TRUTH_ANNOTATED_FLOOR);
  });

  it("annotated-FIELD coverage does not shrink", () => {
    expect(
      annotatedFieldCount,
      `${annotatedFieldCount} annotated fields across ${annotatedCount} truth ` +
        `files (floor ${TRUTH_ANNOTATED_FIELD_FLOOR}). Retiring a field to ` +
        `\`unannotated\` is not a fix — it is the file floor's blind spot.`,
    ).toBeGreaterThanOrEqual(TRUTH_ANNOTATED_FIELD_FLOOR);
  });

  it("un-filed ground-truth disagreements do not grow", () => {
    expect(
      unfiledCount,
      `${unfiledCount} knownWrong entries carry status "unfiled" (ceiling ` +
        `${UNFILED_TRUTH_CEILING}). A measured wrong parse with no issue behind it ` +
        `is debt: file the issue and flip the entry to "open", do not add another.`,
    ).toBeLessThanOrEqual(UNFILED_TRUTH_CEILING);
  });

  it("every scoreboard ratio is undefined or in [0, 1]", () => {
    // Cheap invariant on the arithmetic itself: `matched` can never exceed
    // either side, so a ratio above 1 would mean the multiset matcher
    // double-counted a duplicated value.
    for (const field of TRUTH_FIELDS) {
      for (const value of [precision(truthAll[field]), recall(truthAll[field])]) {
        if (value === undefined) continue;
        expect(value, `${field} ratio out of range`).toBeGreaterThanOrEqual(0);
        expect(value, `${field} ratio out of range`).toBeLessThanOrEqual(1);
      }
    }
  });
});
