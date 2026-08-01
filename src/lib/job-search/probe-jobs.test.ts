// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Whole-lane job-search probe — inert in CI, runs ONLY when
 * `RL_JOBS_PDF=<path>` is set:
 *
 *   RL_JOBS_PDF=/abs/path/to/resume.pdf npx vitest run \
 *     src/lib/job-search/probe-jobs.test.ts
 *
 * The execution vehicle for the `probe-jobs` skill. It is the job-search
 * sibling of `probe-resume`: where that one sweeps the PARSER off a single
 * parse, this one sweeps the RANKER off a single live search. It reproduces the
 * exact default path the deployed panel runs (`FindJobsPanel` →
 * `useCompanyTargets` → `buildJobQuery` → `searchJobs`), then DECOMPOSES every
 * ranking decision into the STAR rating axes (`rating.ts`: fitness / comp /
 * location / seniority → overall) plus the raw signals behind them (coverage,
 * specificity-weighted base, comp attribution, seniority rung), to answer the
 * question theory can't:
 *
 *   > These results feel wrong for the fine-grained jobs. WHERE, mechanically,
 *   > did the ranker put the good fit below the thin one?
 *
 * Since the #561 star redesign, the probe's job is twofold: CONFIRM the rating
 * spreads the compressed real-data set across the 0–5 range (the fine jobs
 * separate from the noise) and catch residual issues (a non-discriminating
 * rating, sparse comp, unparsed seniority, degraded feeds).
 *
 * Unlike the six parser probes this lane is NETWORKED and NON-DETERMINISTIC:
 *   - Running it EGRESSES the same keyword string prod does (the audited
 *     `providers/keywords.ts` surface) + the public company slugs. It is not
 *     offline. Do not run it where that egress is unwanted.
 *   - Node has no CORS, so the capture may reach feeds a browser's CORS set
 *     cannot, and live postings drift run-to-run. The snapshot it writes is the
 *     record of what THIS run saw; a rank finding is reproduced against that
 *     snapshot, not against tomorrow's live feed.
 *
 * ── PII guardrail (three tiers — stricter than the parser probes) ──
 * 1. RÉSUMÉ PII (name, employers, title, skill cluster) and 2. the REAL SEARCH
 *    SURFACE (matched company names, live posting titles/text — the candidate's
 *    actual job search) live ONLY in the gitignored JSON report. The CONSOLE
 *    prints NO résumé value and NO posting title/company: every posting is a
 *    stable index (`job#3`), and every axis is a number, a boolean, a defect
 *    CLASS, or a fixed enum. Cross-reference `job#3` → real title in the
 *    gitignored report locally; never paste it onward.
 * 3. The report also carries a `piiValues` list (name tokens, employers, email,
 *    phone, matched company names, posting titles) so the skill's auto-file
 *    scrub-gate can hard-refuse any drafted issue body containing one.
 *
 * | Var | Default | Meaning |
 * |---|---|---|
 * | `RL_JOBS_PDF` | *(unset)* | Absolute path to the résumé PDF. Unset → inert. |
 * | `RL_JOBS_OUT` | `internal/job-search/` | Directory for the full JSON report. |
 *
 * MINTS NOTHING, COMMITS NOTHING, FILES NOTHING. It classifies defects PII-free
 * and names the owning unit-test file; the skill layer drafts + scrub-gates +
 * files. A human path exists too (see the skill's "Filing what you find").
 */

import { execFileSync } from "node:child_process";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

import { describe, it, expect } from "vitest";

import { runCascade } from "../heuristics/cascade.ts";
import { REPO_ROOT } from "../heuristics/__test-utils__/corpus-snapshots.ts";
import type { HeuristicParsedResume } from "../heuristics/types.ts";
import { buildJobQuery, type JobQuery } from "./query-builder.ts";
import { seniorityRung } from "./seniority.ts";
import type { JobSearchResult } from "./search.ts";
import type { CompanyEntry } from "./company-registry.ts";
import {
  roleFilterForResume,
  seedExcludeTermsForFamilies,
} from "./role-keywords.ts";
import { classifySectorHeuristic } from "./sector.ts";
import { companiesForSector } from "./company-registry.ts";
import { COMPANY_LIMIT } from "../../hooks/useCompanyTargets.ts";
import { ratingInputFor, type RankedJob } from "./rank.ts";
import type { RatingInput, JobRating } from "./rating.ts";

/**
 * The report directory, validated the same way `probe-resume` validates its
 * own: the default (`internal/`) is gitignored; an override that lands inside
 * the repo and is NOT gitignored is a hard failure, because the report is a
 * diagnostics artifact derived from a real résumé + the candidate's live search
 * and must never become committable. `git check-ignore` is the authority.
 */
function resolveOutDir(): string {
  const override = process.env.RL_JOBS_OUT;
  if (!override) return join(REPO_ROOT, "internal/job-search");

  const dir = isAbsolute(override) ? override : resolve(process.cwd(), override);
  const rel = relative(REPO_ROOT, dir);
  const insideRepo = rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  if (!insideRepo) return dir;

  try {
    execFileSync("git", ["check-ignore", "-q", "--", dir], { cwd: REPO_ROOT });
    return dir;
  } catch {
    throw new Error(
      `RL_JOBS_OUT="${override}" resolves inside the repo at "${rel}" and is NOT ` +
        `gitignored. The report carries a real résumé's derived query and the ` +
        `candidate's live matched postings — it must never become committable. ` +
        `Point RL_JOBS_OUT at a gitignored path (the default "internal/job-search/") ` +
        `or somewhere outside the repo.`,
    );
  }
}

// ── Classification thresholds. Named so a reader can calibrate — not magic. ──
/** Above this share of shown postings carrying no extracted comp, the comp
 *  floor knob is effectively inert on this résumé's real feed sample. */
const COMP_SPARSE_SHARE = 0.8;
/** Above this share of shown postings whose TITLE yields no seniority rung, the
 *  seniority axis is silently absent for most of the set (level axis near-dead). */
const SENIORITY_UNPARSED_SHARE = 0.8;
/** The overall star rating must spread at least this far (max − min) across the
 *  shown set, else it fails #561's whole point — it is not separating the fine
 *  jobs from the noise, just relabeling a flat percentage as flat stars.
 *
 *  RECALIBRATED FOR #716 (was 2). That value was calibrated under the STRETCHED
 *  HYBRID fitness axis #716 deleted, where fitness was
 *  `0.4·base/(base+9) + 0.6·(base−min)/(max−min)` over the set. The stretch term
 *  contributed a fixed 0.6 fraction (3.0★) between the set's own min and max, so
 *  the hybrid FITNESS spread was `2·Δ(base/(base+9)) + 3.0` — always ≥ 3.0.
 *  But this threshold reads `rating.overall`, not the fitness axis, and the
 *  blend dilutes that: re-running the deleted hybrid with the other three axes
 *  present and constant gave 1.98 (bases 0…21), 1.59 (4…12) and 1.41 (6…8) —
 *  all UNDER 2. So the old value was mis-set toward false POSITIVES, firing on
 *  healthy sets whenever comp/location/seniority were present, not inert as the
 *  fitness-only arithmetic suggests. Either way it cannot be carried over.
 *
 *  The absolute curve is `5·base/(base+9)` with no set term, so the spread now
 *  scales directly with the observed base range (`rating.ts`: real-résumé base
 *  ceiling ~21, mean ~7). Measured `rating.overall` spread, by how many axes are
 *  present — fitness carries 0.45/1.0 with all four, up to 1.0 alone, so the
 *  dilution factor ranges 0.45…1.0 and BOTH ends are live regimes:
 *
 *                                  fitness only   +comp   all four
 *    bases 0…21 (wide, healthy)        3.50        1.97      1.58   must pass
 *    bases 4…12 (tight, healthy)       1.32        0.74      0.59   must pass
 *    bases 6…8  (non-discriminating)   0.35        0.20      0.16   must fire
 *
 *  The threshold must clear the LEAST-diluted flat set (0.353, fitness only) and
 *  stay under the MOST-diluted healthy one (0.593, all four axes) — a window of
 *  (0.353, 0.593]. 0.5 takes it with ~1.4× headroom over the flat set and ~0.09★
 *  under the diluted healthy one, biased toward the false-NEGATIVE side on
 *  purpose: this defect is `severity: "blocking"` and is the probe-jobs skill's
 *  issue-filing trigger, so a spurious blocking finding costs more than a missed
 *  marginal one. */
const DISCRIMINATION_MIN_SPREAD = 0.5;
/** A "strong fit" is a posting in the top this-share by FITNESS. */
const STRONG_FIT_SHARE = 0.1;
/** A strong fit is BURIED (the #570/#562 pathology) if its overall rank falls
 *  outside the top this-share of the set — fitness dominates the rating, so a
 *  top-fitness posting should never be pushed deep by the minor axes. */
const BURIED_RANK_SHARE = 0.25;

/** Non-salary dollar contexts that, if present in an extracted comp's source
 *  substring, make a below-floor penalty suspect (#564 misattribution class).
 *  Matched only against `compensation.raw` (a posting-text substring), never
 *  printed to the console. */
const NON_SALARY_CONTEXT = /\b(funding|raised|valuation|budget|revenue|arr|seed|series\s+[a-e]|million|billion|[0-9]\s*[mb]n?\b)/i;

interface Defect {
  /** PII-free class slug. */
  class: string;
  severity: "blocking" | "signal" | "info";
  /** PII-free numeric/boolean evidence. */
  evidence: Record<string, number | boolean | string>;
  /** Which unit-test file owns a synthetic reproducer for this class. */
  ownerTest: string;
}

/** One posting's PII-free decomposition row (console-safe). */
interface DecompRow {
  idx: number;
  /** The raw signals that fed the rating (base, comp, distances). */
  input: RatingInput;
  /** The 0–5 star rating (overall + sub-axes). */
  rating: JobRating;
  /** Raw coverage 0..100 — the compressed number the rating works around. */
  score: number;
  termCount: number;
  hasComp: boolean;
  belowFloor: boolean;
  locationMatch: boolean;
  /** True when a below-floor penalty fired AND the extracted comp's source
   *  substring reads like non-salary dollars — a #564 misattribution suspect. */
  compRawSuspect: boolean;
}

describe.runIf(process.env.RL_JOBS_PDF)(
  "whole-lane job-search probe (RL_JOBS_PDF)",
  () => {
    // Deliberate monolithic diagnostic harness (mirrors probe-resume): one
    // linear read-out of capture → decomposition → defect classification, in a
    // single scroll. Not production logic; it never asserts on what it FINDS.
    // fallow-ignore-next-line complexity
    it("captures a live search, decomposes the star rating, classifies defects PII-free", async () => {
      const path = process.env.RL_JOBS_PDF!;
      const outDir = resolveOutDir();

      // ── Parse. `canonical.fields` IS the HeuristicParsedResume the panel holds. ─
      const cascade = await runCascade(new Uint8Array(readFileSync(path)));
      const parsed = cascade.canonical.fields;

      // ── Reproduce the panel's DEFAULT search wiring exactly (no user edits):
      //    role filter seeds families + exclude chips; sector heuristic seeds
      //    the company pool (all suggested = selected on mount). ────────────────
      const roleFilter = roleFilterForResume(parsed);
      const query = buildJobQuery(
        parsed,
        seedExcludeTermsForFamilies(roleFilter.families),
        roleFilter.families,
      );
      const guess = classifySectorHeuristic(parsed);
      const companies = companiesForSector(guess.sector, COMPANY_LIMIT);

      // ── Capture: one live search. Egresses keywords + slugs (documented). ────
      const result = await searchLive(query, parsed, companies);

      // ── Decompose every shown job into the SAME rating inputs rank.ts used. ───
      const queryLocation = query.location?.trim() || undefined;
      const querySeniorityRung = seniorityRung(query.seniority);
      const rows: DecompRow[] = result.jobs.map((job, idx) => {
        const input = ratingInputFor(job, queryLocation, querySeniorityRung, query.compFloor);
        const raw = job.posting.compensation?.raw ?? "";
        return {
          idx,
          input,
          rating: job.rating,
          score: job.score,
          termCount: job.jdMatch.terms.length,
          hasComp: Boolean(job.posting.compensation),
          belowFloor: job.belowFloor,
          locationMatch: input.locationMatch,
          compRawSuspect: job.belowFloor && NON_SALARY_CONTEXT.test(raw),
        };
      });

      // ── Classify defects (PII-free). ─────────────────────────────────────────
      const defects = classify(rows, result, query, queryLocation);

      // ── The gitignored report: everything, incl. the real search surface. ────
      const piiValues = collectPiiValues(parsed, query, result);
      const report = {
        path,
        capturedAt: "(stamped by the skill after the run — Date.now is unavailable in-harness)",
        ratingAlgoNote: "star rating per the weights + curves in rating.ts",
        query, // titles/skills/location/seniority — résumé-derived, PII
        sector: guess.sector,
        companyCount: companies.length,
        degradedProviders: result.degradedProviders,
        providerCount: result.providerCount,
        excludeSuppressed: result.excludeSuppressed,
        roleSuppressed: result.roleSuppressed,
        rawPostingCount: result.rawPostings.length,
        shownCount: result.jobs.length,
        defects,
        // The index → real posting map. This is the tier-2 surface; gitignored only.
        postings: result.jobs.map((job, idx) => ({
          idx,
          title: job.posting.title,
          company: job.posting.company,
          location: job.posting.location,
          source: job.posting.source,
          url: job.posting.url,
          score: job.score,
          termCount: job.jdMatch.terms.length,
          rating: job.rating,
          compRaw: job.posting.compensation?.raw ?? null,
          belowFloor: job.belowFloor,
        })),
        rows,
        piiValues,
      };
      mkdirSync(outDir, { recursive: true });
      const outFile = join(
        outDir,
        `jobs-${basename(path).replace(/\.[^.]+$/, "")}.json`,
      );
      writeFileSync(outFile, JSON.stringify(report, null, 2));

      // ── The console read-out. Indices, numbers, booleans, classes only. ──────
      console.log(renderReadout(rows, defects, result, query, outFile));

      // Diagnostic: never fails on findings, but must fail if it could not run.
      expect(result.providerCount).toBeGreaterThan(0);
    }, 120_000); // live network capture — well over the 5s default.
  },
);

/**
 * Run the real orchestrator against live feeds. Split out so the one networked
 * call is named and the egress is obvious. Uses a never-aborted signal — the
 * probe wants the full sample, not a superseded partial. `searchJobs` is
 * dynamic-imported (the cascade-tier pattern) exactly as `FindJobsPanel` reaches
 * it, so nothing pulls the provider chunk into this module's static graph.
 */
async function searchLive(
  query: JobQuery,
  parsed: HeuristicParsedResume,
  companies: readonly CompanyEntry[],
): Promise<JobSearchResult> {
  const { searchJobs } = await import("./search.ts");
  return searchJobs(query, parsed, new AbortController().signal, companies);
}

/**
 * The defect classifier. Every branch reports PII-free evidence (counts,
 * shares, booleans) and names the unit-test file that should carry a synthetic
 * reproducer for the class.
 */
function classify(
  rows: DecompRow[],
  result: JobSearchResult,
  query: { location?: string; seniority?: string; compFloor?: number; families?: string[] },
  queryLocation: string | undefined,
): Defect[] {
  const defects: Defect[] = [];
  const n = rows.length;

  if (n === 0) {
    defects.push({
      class: "empty-result-set",
      severity: "blocking",
      evidence: {
        rawPostingCount: result.rawPostings.length,
        degraded: result.degradedProviders.length,
        providerCount: result.providerCount,
        roleSuppressed: result.roleSuppressed,
        excludeSuppressed: result.excludeSuppressed,
      },
      ownerTest: "search.test.ts",
    });
    return defects;
  }

  defects.push(...classifyRating(rows, n));
  defects.push(...classifyLevelAndComp(rows, query, n));
  defects.push(...classifyLocation(rows, queryLocation, n));
  defects.push(...classifyResultHealth(result, query, n));
  return defects;
}

/**
 * Rating-model health: does the star rating discriminate (#561), and does a
 * minor axis bury a strong fit (#570/#562)?
 */
function classifyRating(rows: DecompRow[], n: number): Defect[] {
  const defects: Defect[] = [];

  // ── Rating discrimination (#561's success criterion). ────────────────────────
  // The whole point of the star redesign is to spread a compressed set across
  // 0–5 so the fine jobs separate. Measure the overall-star spread; if the
  // rating is as flat as the percentage it replaced, the redesign failed here.
  const overalls = rows.map((r) => r.rating.overall);
  const overallMax = Math.max(...overalls);
  const overallMin = Math.min(...overalls);
  const overallMean = overalls.reduce((a, b) => a + b, 0) / n;
  const spread = overallMax - overallMin;
  defects.push({
    class: "rating-distribution",
    severity: spread < DISCRIMINATION_MIN_SPREAD ? "blocking" : "info",
    evidence: {
      overallMax: round2(overallMax),
      overallMin: round2(overallMin),
      overallMean: round2(overallMean),
      spread: round2(spread),
      topBand4plus: rows.filter((r) => r.rating.overall >= 4).length,
      threshold: DISCRIMINATION_MIN_SPREAD,
      note:
        spread < DISCRIMINATION_MIN_SPREAD
          ? "overall stars do not separate the set — the rating is not discriminating (#561 unmet)"
          : "overall stars spread across the range — the rating separates the fine jobs (#561 met)",
    },
    ownerTest: "rating.test.ts",
  });

  // ── Raw coverage compression (the upstream cause the rating works around). ───
  // INFO, not blocking: the star rating exists precisely to handle this, so a
  // compressed raw coverage is expected. Surfaced so a reader sees the gap the
  // saturating fitness curve is bridging, and can check against
  // `rating-distribution` above whether it actually bridged it.
  const scores = rows.map((r) => r.score);
  const rawMax = Math.max(...scores);
  const rawMean = scores.reduce((a, b) => a + b, 0) / n;
  if (rawMax < 60 && rawMean < 20) {
    defects.push({
      class: "raw-coverage-compressed",
      severity: "info",
      evidence: {
        rawMax,
        rawMean: round2(rawMean),
        shareOver30: round2(scores.filter((s) => s >= 30).length / n),
        shown: n,
        note: "raw JD-term coverage is compressed; the star rating's saturating curve expands it — see rating-distribution",
      },
      ownerTest: "rating.test.ts",
    });
  }

  // ── Strong-fit-buried guard (the #570/#562 regression the model prevents). ───
  // The old model let a flat location/seniority penalty sink a strong fit from
  // rank ~1 to rank ~9. Fitness dominates the star rating (weight 0.45, and comp
  // — the only other driver — is a legitimate co-driver, NOT a bug when it
  // reorders), so a top-fitness posting should still surface near the top. Take
  // the strongest fits and check none is buried outside the top band by overall
  // rank (rows are in overall-rank order, so idx === rank). Comp reordering
  // within the top band is fine; a strong fit shoved deep is not.
  const byFitness = [...rows].sort((a, b) => b.rating.fitness - a.rating.fitness);
  const strongCount = Math.max(1, Math.round(n * STRONG_FIT_SHARE));
  const buriedRank = Math.round(n * BURIED_RANK_SHARE);
  const buried = byFitness.slice(0, strongCount).filter((r) => r.idx >= buriedRank);
  if (buried.length > 0) {
    defects.push({
      class: "strong-fit-buried",
      severity: "blocking",
      evidence: {
        buriedCount: buried.length,
        strongFitCount: strongCount,
        deepestBuriedRank: Math.max(...buried.map((r) => r.idx)),
        buriedRankThreshold: buriedRank,
        shown: n,
        note: "a top-fitness posting ranks outside the top band — a minor axis is burying it (#570/#562 regression)",
      },
      ownerTest: "rating.test.ts",
    });
  }

  return defects;
}

/**
 * Input-health diagnostics for the level and compensation axes — these are
 * about what feeds the model, not about the model itself.
 */
function classifyLevelAndComp(
  rows: DecompRow[],
  query: { seniority?: string; compFloor?: number },
  n: number,
): Defect[] {
  const defects: Defect[] = [];

  // #562 — the level axis is inert or near-dead on this résumé's real set.
  if (query.seniority === undefined) {
    defects.push({
      class: "seniority-axis-inert-no-query-level",
      severity: "signal",
      evidence: { querySeniority: "undefined", shown: n },
      ownerTest: "query-builder.test.ts",
    });
  } else {
    const unparsed = rows.filter((r) => r.input.seniorityDistance === null).length;
    if (unparsed / n >= SENIORITY_UNPARSED_SHARE) {
      defects.push({
        class: "seniority-titles-unparsed",
        severity: "signal",
        evidence: {
          unparsedShare: round2(unparsed / n),
          unparsed,
          shown: n,
          threshold: SENIORITY_UNPARSED_SHARE,
        },
        ownerTest: "seniority.test.ts",
      });
    }
  }

  // #564 — comp knob effectively inert (nothing extracted on the real feeds).
  const noComp = rows.filter((r) => !r.hasComp).length;
  if (noComp / n >= COMP_SPARSE_SHARE) {
    defects.push({
      class: "comp-extraction-sparse",
      severity: query.compFloor !== undefined ? "blocking" : "info",
      evidence: {
        noCompShare: round2(noComp / n),
        noComp,
        shown: n,
        floorSet: query.compFloor !== undefined,
      },
      ownerTest: "compensation.test.ts",
    });
  }

  // #564 — a below-floor penalty fired on a posting whose extracted comp source
  // reads like non-salary dollars (funding/budget/valuation). Suspect misparse.
  const belowFloor = rows.filter((r) => r.belowFloor);
  if (belowFloor.length > 0) {
    const suspect = belowFloor.filter((r) => r.compRawSuspect).length;
    defects.push({
      class: suspect > 0 ? "comp-below-floor-misattributed" : "comp-below-floor-fired",
      severity: suspect > 0 ? "blocking" : "info",
      evidence: {
        belowFloorCount: belowFloor.length,
        suspectNonSalaryRaw: suspect,
        shown: n,
        note: "suspect rows: comp.raw matched a non-salary dollar context; inspect the gitignored report",
      },
      ownerTest: "compensation.test.ts",
    });
  }

  return defects;
}

/**
 * #545 — location axis inert: the query has a location but ~nothing matches, or
 * there is no location at all, so the axis never breaks a tie.
 */
function classifyLocation(
  rows: DecompRow[],
  queryLocation: string | undefined,
  n: number,
): Defect[] {
  const defects: Defect[] = [];

  if (queryLocation === undefined) {
    defects.push({
      class: "location-axis-inert-no-query-location",
      severity: "info",
      evidence: { shown: n },
      ownerTest: "rating.test.ts",
    });
  } else {
    const matched = rows.filter((r) => r.locationMatch).length;
    if (matched === 0) {
      defects.push({
        class: "location-axis-inert-zero-matches",
        severity: "signal",
        evidence: { shown: n, matched: 0 },
        ownerTest: "rating.test.ts",
      });
    }
  }

  return defects;
}

/**
 * Result-level health: never-fail-closed flags that fired (the user's filter
 * was silently skipped), and feed degradation that thins the ranker's sample.
 */
function classifyResultHealth(
  result: JobSearchResult,
  query: { families?: string[] },
  n: number,
): Defect[] {
  const defects: Defect[] = [];

  // Never-fail-closed flags fired: the user's filter was silently skipped.
  if (result.roleSuppressed) {
    defects.push({
      class: "role-filter-suppressed",
      severity: "signal",
      evidence: { families: (query.families ?? []).length, shown: n },
      ownerTest: "refine.test.ts",
    });
  }
  if (result.excludeSuppressed) {
    defects.push({
      class: "exclude-filter-suppressed",
      severity: "signal",
      evidence: { shown: n },
      ownerTest: "role-keywords.test.ts",
    });
  }

  // Feed health — not a rank bug, but it thins the sample the ranker sees.
  if (result.degradedProviders.length > 0) {
    defects.push({
      class: "providers-degraded",
      severity: result.degradedProviders.length === result.providerCount ? "blocking" : "info",
      evidence: {
        degraded: result.degradedProviders.length,
        providerCount: result.providerCount,
      },
      ownerTest: "(feed health — not a unit-test target)",
    });
  }

  return defects;
}

function collectPiiValues(
  parsed: { full_name?: string; experience?: Array<{ company?: string; title?: string }> },
  query: { titles: string[]; skills: string[] },
  result: JobSearchResult,
): string[] {
  const set = new Set<string>();
  const add = (v: unknown) => {
    if (typeof v === "string") {
      const t = v.trim();
      if (t.length >= 3) set.add(t);
    }
  };
  add(parsed.full_name);
  for (const part of (parsed.full_name ?? "").split(/\s+/)) add(part);
  for (const exp of parsed.experience ?? []) {
    add(exp.company);
    add(exp.title);
  }
  for (const t of query.titles) add(t);
  for (const s of query.skills) add(s);
  for (const job of result.jobs) {
    add((job as RankedJob).posting.company);
    add((job as RankedJob).posting.title);
  }
  return [...set];
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/** The PII-free console read-out. */
function renderReadout(
  rows: DecompRow[],
  defects: Defect[],
  result: JobSearchResult,
  query: { titles: string[]; skills: string[]; seniority?: string; location?: string; families?: string[]; compFloor?: number },
  outFile: string,
): string {
  const head =
    `RL_JOBS_PDF job-search sweep for ${outFile}\n` +
    `  (PDF path withheld from console — it may carry a name; see the gitignored report)\n\n` +
    `  QUERY SHAPE (counts only — no values):\n` +
    `    titles=${query.titles.length}  skills=${query.skills.length}  ` +
    `seniority=${query.seniority ? "set" : "undefined"}  location=${query.location ? "set" : "undefined"}  ` +
    `families=${(query.families ?? []).length}  compFloor=${query.compFloor !== undefined ? "set" : "unset"}\n` +
    `  CAPTURE:\n` +
    `    raw=${result.rawPostings.length}  shown=${rows.length}  ` +
    `providers=${result.providerCount}  degraded=${result.degradedProviders.length}  ` +
    `roleSuppressed=${result.roleSuppressed}  excludeSuppressed=${result.excludeSuppressed}\n`;

  const table =
    `\n  RANK DECOMPOSITION (top ${Math.min(rows.length, 20)} of ${rows.length}) — ★ = 0–5 stars:\n` +
    `    idx  score  terms   base   fit★  comp★   loc★  sen★  OVR★   sdst  comp  <floor  locM\n` +
    rows
      .slice(0, 20)
      .map((r) => {
        const rt = r.rating;
        return (
          `    ${pad(r.idx, 3)}  ${pad(r.score, 5)}  ${pad(r.termCount, 5)}  ` +
          `${pad(round1(r.input.base), 5)}  ${pad(star(rt.fitness), 5)}  ${pad(star(rt.compensation), 5)}  ` +
          `${pad(star(rt.location), 5)}  ${pad(star(rt.seniority), 4)}  ${pad(star(rt.overall), 4)}  ` +
          `${pad(r.input.seniorityDistance ?? "—", 4)}  ${pad(r.hasComp ? "y" : "—", 4)}  ` +
          `${pad(r.belowFloor ? "y" : "—", 6)}  ${r.locationMatch ? "y" : "—"}`
        );
      })
      .join("\n");

  const defectBlock =
    `\n\n  DEFECTS FOUND (${defects.length}):\n` +
    (defects.length
      ? defects
          .map(
            (d) =>
              `    [${d.severity.toUpperCase()}] ${d.class}\n` +
              `        evidence: ${JSON.stringify(d.evidence)}\n` +
              `        reproducer owner: ${d.ownerTest}`,
          )
          .join("\n")
      : "    (none — the ranking looks clean on this sample)");

  return (
    head +
    table +
    defectBlock +
    `\n\n  Full JSON (real titles/companies + piiValues) → ${outFile}` +
    `\n  ⚠️ gitignored; do NOT commit and do NOT paste onward — it is the candidate's live search surface.\n`
  );
}

/** Render a nullable star value: one decimal, or "—" when the axis is absent. */
function star(v: number | null): string {
  return v === null ? "—" : String(round1(v));
}

function pad(v: number | string, w: number): string {
  return String(v).padStart(w);
}
function round1(x: number): number {
  return Math.round(x * 10) / 10;
}
