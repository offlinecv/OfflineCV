// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

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
    keys.push(k);
  }
  return keys.sort();
}

const pdfs = walkPdfs(FIXTURE_ROOT);

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
