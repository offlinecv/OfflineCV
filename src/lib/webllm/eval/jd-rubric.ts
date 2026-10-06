// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import { extractJdTerms } from "../../jd-match/extract-jd-terms.ts";
import { computeCoverageFromCorpus } from "../../jd-match/coverage.ts";
import type { JdMatchResult, SemanticJdMatchResult } from "../../jd-match/types.ts";
import type { RequirementVerdict } from "../../jd-match/llm/judge-evidence.ts";
import type { JdEvalFixture, JdGoldLabel } from "./jd-types.ts";

/**
 * Deterministic, model-free checks on a semantic JD-match result (issue
 * #205). No field here calls a judge model — every criterion is a pure
 * function over the `JdMatchResult` + fixture text, the same discipline
 * `rubric.ts` applies to a rewrite.
 *
 * The six checks the issue asks for, and how each is scoped:
 *
 *   1. JSON well-formed — scoped to "extraction did not hard-fail" rather
 *      than "parsed without repair". `parse_repaired` lives only in
 *      `extract-requirements.ts`'s telemetry call, which is not on the
 *      `JdMatchResult` the seam returns, and plumbing it through `JdMatchFn`
 *      for a flag the rubric would then just negate is not worth a second
 *      return shape. `runLlmMatch` ALREADY collapses every extraction
 *      failure (hard throw OR a legitimately-empty extraction) to the
 *      keyword fallback (see its docblock), so `result.path === "semantic"`
 *      is a sound proxy: a result on the semantic arm is, by construction,
 *      one `extractRequirements` did not throw out of. Implementer's call,
 *      per the issue — stated here and in the PR description.
 *   2. No invented requirements — every verdict's joined requirement has
 *      non-empty text, no two verdicts share a requirement (normalized), and
 *      no requirement text is a verbatim copy of a JD heading line.
 *   3. Status shape — every verdict's status is one of met/partial/missing.
 *   4. Reasons sane — every verdict's reason is non-empty and length-sane.
 *   5. Evidence groundedness — when a verdict carries `evidence`, it must be
 *      a substring of the résumé text (case-insensitive).
 *   6. Gold agreement — reported only, no CI gate (non-determinism is
 *      expected on a real model; the stub leg exercises the computation,
 *      not a pass bar).
 */

const VALID_STATUSES = new Set<RequirementVerdict["status"]>([
  "met",
  "partial",
  "missing",
]);

/** Sane band for a one-sentence, résumé-grounded verdict reason. */
const REASON_MIN_CHARS = 8;
const REASON_MAX_CHARS = 400;

/** A JD heading line is short, has no sentence-ending punctuation, and reads
 *  as a title rather than a requirement sentence. Deliberately permissive —
 *  it only needs to catch the "copied the heading verbatim" failure mode,
 *  not classify every line in a JD. */
const HEADING_MAX_WORDS = 6;
const HEADING_MAX_CHARS = 60;
const HEADING_SHAPE_RE = /^[A-Z][A-Za-z0-9&/,'-]*(?:\s+[A-Za-z0-9&/,'-]+)*$/;

/** Fuzzy-match threshold for joining a gold label to a model requirement —
 *  see `scoreGoldAgreement`. Low on purpose: the model's wording and the
 *  label's wording are independently written, so even a true match often
 *  shares only a handful of content words. */
const FUZZY_MATCH_THRESHOLD = 0.3;

export interface GoldAgreementRow {
  gold: JdGoldLabel;
  /** The model requirement the label fuzzy-joined to, or `null` if nothing
   *  cleared `FUZZY_MATCH_THRESHOLD`. */
  matchedRequirementId: string | null;
  matchedStatus: RequirementVerdict["status"] | null;
  /** `matchedStatus === gold.expectedStatus`. Always `false` when unmatched —
   *  an un-joinable label is not an agreement by default. */
  agree: boolean;
}

export interface GoldAgreementResult {
  rows: readonly GoldAgreementRow[];
  /** `agree` count / `rows.length`. `0` when there are no gold labels at all
   *  (distinct from a label set that failed to join every row — both are
   *  legitimate shapes, so this is NOT `null`-guarded; a fixture author who
   *  wants an agreement number ships at least one label). */
  agreementRate: number;
}

export interface JdRubricResult {
  jsonWellFormed: boolean;
  noInventedRequirements: boolean;
  statusShapeValid: boolean;
  reasonsSane: boolean;
  evidenceGrounded: boolean;
  goldAgreement: GoldAgreementResult;
}

/** The empty rubric for a result the seam failed to produce at all (every
 *  criterion reads as a fail so the row surfaces in the report). */
export function emptyJdRubric(): JdRubricResult {
  return {
    jsonWellFormed: false,
    noInventedRequirements: false,
    statusShapeValid: false,
    reasonsSane: false,
    evidenceGrounded: false,
    goldAgreement: { rows: [], agreementRate: 0 },
  };
}

export interface ScoreJdRubricInput {
  result: JdMatchResult;
  jdText: string;
  resumeText: string;
  gold: readonly JdGoldLabel[];
}

export function scoreJdRubric({
  result,
  jdText,
  resumeText,
  gold,
}: ScoreJdRubricInput): JdRubricResult {
  // (1) See the docblock above for why this is the scoped proxy rather than
  // a plumbed-through `parse_repaired` flag.
  if (result.path !== "semantic") {
    return { ...emptyJdRubric(), goldAgreement: scoreGoldAgreement([], gold) };
  }

  const { verdicts } = result;

  const noInventedRequirements = checkNoInventedRequirements(verdicts, jdText);

  const statusShapeValid =
    verdicts.length > 0 && verdicts.every((v) => VALID_STATUSES.has(v.status));

  const reasonsSane =
    verdicts.length > 0 &&
    verdicts.every((v) => {
      const len = v.reason.trim().length;
      return len >= REASON_MIN_CHARS && len <= REASON_MAX_CHARS;
    });

  const resumeLower = resumeText.toLowerCase();
  const evidenceGrounded = verdicts.every((v) => {
    if (v.evidence === undefined) return true;
    const trimmed = v.evidence.trim().toLowerCase();
    return trimmed.length > 0 && resumeLower.includes(trimmed);
  });

  return {
    jsonWellFormed: true,
    noInventedRequirements,
    statusShapeValid,
    reasonsSane,
    evidenceGrounded,
    goldAgreement: scoreGoldAgreement(verdicts, gold),
  };
}

/** Normalize for comparison: lowercase, strip punctuation, collapse
 *  whitespace. Shared by the heading-dupe check, the gold fuzzy-join, and
 *  the prompt-injection substring check below. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function looksLikeJdHeading(line: string): boolean {
  // A trailing colon ("Minimum Qualifications:") is how most real JDs punctuate
  // a heading — strip it before judging shape, so the heading check isn't
  // defeated by the one piece of punctuation headings actually carry.
  const trimmed = line.trim().replace(/:$/, "");
  if (trimmed.length === 0 || trimmed.length > HEADING_MAX_CHARS) return false;
  if (/[.?!]$/.test(trimmed)) return false;
  if (trimmed.split(/\s+/).length > HEADING_MAX_WORDS) return false;
  return HEADING_SHAPE_RE.test(trimmed);
}

/**
 * (2) No invented requirements. Orphan ids are already dropped upstream by
 * `judgeEvidence`'s reconciliation (an invented id is never read — see its
 * docblock), so there is nothing left to invent at the id level; what can
 * still go wrong is the TEXT: an empty requirement, two verdicts quietly
 * sharing one requirement, or a requirement that is just the JD's own
 * section heading copied back as if it were a competency.
 */
function checkNoInventedRequirements(
  verdicts: readonly RequirementVerdict[],
  jdText: string,
): boolean {
  if (verdicts.length === 0) return false;
  const headings = new Set(
    jdText
      .split(/\r?\n/)
      .filter(looksLikeJdHeading)
      .map((line) => normalize(line)),
  );
  const seen = new Set<string>();
  for (const v of verdicts) {
    const text = v.requirement.text.trim();
    if (text.length === 0) return false;
    const key = normalize(text);
    if (seen.has(key)) return false;
    seen.add(key);
    if (headings.has(key)) return false;
  }
  return true;
}

function tokenSet(text: string): Set<string> {
  return new Set(normalize(text).split(" ").filter(Boolean));
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Exact maximum-weight bipartite match between one kind's gold labels and
 * the model's same-`kind` requirements. A per-label greedy join (claim each
 * label's own best requirement, in gold-array order) can strand a later
 * label whose only eligible requirement was already claimed by an earlier
 * label for whom it was merely the second-best option — even when swapping
 * the two assignments would have matched both. Bitmask DP over which
 * requirements are taken avoids that; it costs `O(gold * 2^requirements)`,
 * fine at the sizes a hand-authored fixture's gold list ever reaches.
 */
function maxWeightMatch(
  goldGroup: readonly { label: JdGoldLabel; index: number }[],
  verdictGroup: readonly RequirementVerdict[],
): ReadonlyMap<number, { verdict: RequirementVerdict; score: number }> {
  const g = goldGroup.length;
  const v = verdictGroup.length;
  const edge: (number | null)[][] = goldGroup.map(({ label }) => {
    const labelTokens = tokenSet(label.text);
    return verdictGroup.map((verdict) => {
      const score = jaccard(labelTokens, tokenSet(verdict.requirement.text));
      return score >= FUZZY_MATCH_THRESHOLD ? score : null;
    });
  });

  const keyOf = (i: number, mask: number) => i * (1 << v) + mask;
  const memo = new Map<number, number>();
  const choice = new Map<number, number>();

  function solve(i: number, usedMask: number): number {
    if (i === g) return 0;
    const key = keyOf(i, usedMask);
    const cached = memo.get(key);
    if (cached !== undefined) return cached;

    let best = solve(i + 1, usedMask);
    let bestChoice = -1;
    for (let j = 0; j < v; j++) {
      if (usedMask & (1 << j)) continue;
      const score = edge[i][j];
      if (score === null) continue;
      const candidate = score + solve(i + 1, usedMask | (1 << j));
      if (candidate > best) {
        best = candidate;
        bestChoice = j;
      }
    }
    memo.set(key, best);
    choice.set(key, bestChoice);
    return best;
  }
  solve(0, 0);

  const matches = new Map<number, { verdict: RequirementVerdict; score: number }>();
  let mask = 0;
  for (let i = 0; i < g; i++) {
    const picked = choice.get(keyOf(i, mask)) ?? -1;
    if (picked >= 0) {
      matches.set(goldGroup[i].index, { verdict: verdictGroup[picked], score: edge[i][picked]! });
      mask |= 1 << picked;
    }
  }
  return matches;
}

/**
 * (6) Expected-verdict agreement. Gold labels are keyed by normalized text +
 * kind; the model's requirement wording will not equal the label's, so each
 * label is joined to a same-`kind` requirement by token-set Jaccard
 * similarity via `maxWeightMatch`, with a floor (`FUZZY_MATCH_THRESHOLD`)
 * below which the label counts as unmatched rather than forcing a join to
 * the nearest unrelated requirement. Reported only — no CI threshold gate
 * (#205): a real model's agreement rate is expected to vary run to run, so a
 * gate here would be measuring luck, not regression.
 */
export function scoreGoldAgreement(
  verdicts: readonly RequirementVerdict[],
  gold: readonly JdGoldLabel[],
): GoldAgreementResult {
  if (gold.length === 0) return { rows: [], agreementRate: 0 };

  const rows = new Array<GoldAgreementRow>(gold.length);
  const kinds = new Set(gold.map((label) => label.kind));
  for (const kind of kinds) {
    const goldGroup = gold
      .map((label, index) => ({ label, index }))
      .filter((entry) => entry.label.kind === kind);
    const verdictGroup = verdicts.filter((v) => v.requirement.kind === kind);
    const matches = maxWeightMatch(goldGroup, verdictGroup);

    for (const entry of goldGroup) {
      const match = matches.get(entry.index);
      rows[entry.index] =
        match === undefined
          ? { gold: entry.label, matchedRequirementId: null, matchedStatus: null, agree: false }
          : {
              gold: entry.label,
              matchedRequirementId: match.verdict.requirement.id,
              matchedStatus: match.verdict.status,
              agree: match.verdict.status === entry.label.expectedStatus,
            };
    }
  }

  const agreementRate = rows.filter((r) => r.agree).length / rows.length;
  return { rows, agreementRate };
}

export interface SemanticVsKeywordComparison {
  fixtureId: string;
  /** Gold-label agreement rate (0..1) of the semantic result. */
  semanticAgreementRate: number;
  /** Deterministic keyword-path coverage score (0..1, i.e. `CoverageResult.score / 100`)
   *  over the SAME fixture JD + résumé text. */
  keywordCoverageRate: number;
}

/**
 * The #205 "semantic ≥ keyword on home turf" regression check, defined
 * explicitly as the issue asks: run the deterministic keyword path
 * (`extractJdTerms` + `computeCoverageFromCorpus`, the exact composition
 * `runLlmMatch`'s own fallback arm uses) over the SAME fixture, and report
 * both the semantic gold-agreement rate and the keyword coverage rate side
 * by side. Reported, not gated in CI (#205) — the stub leg only asserts this
 * comparison computes a value for both arms; a committed real-model report
 * is the follow-up that argues from the numbers.
 */
export function compareSemanticVsKeyword(
  fixture: JdEvalFixture,
  semanticResult: SemanticJdMatchResult,
): SemanticVsKeywordComparison {
  const terms = extractJdTerms(
    fixture.jd,
    fixture.postingTitle ? { postingTitle: fixture.postingTitle } : {},
  ).all;
  const coverage = computeCoverageFromCorpus(fixture.resume.toLowerCase(), terms);
  return {
    fixtureId: fixture.id,
    semanticAgreementRate: scoreGoldAgreement(semanticResult.verdicts, fixture.gold)
      .agreementRate,
    keywordCoverageRate: coverage.score / 100,
  };
}

/**
 * The #205 prompt-injection check, defined explicitly as the issue asks: the
 * JD carries a known injected instruction (`payload`), and this asserts
 * neither an extracted requirement's text nor a verdict's reason echoes it
 * (normalized substring match), AND that the requirement count is not
 * degenerate — not zero, not collapsed to a single requirement that is
 * itself the payload. A model that ignored the injection and extracted a
 * normal requirement set passes; a model that obeyed it (by going silent, or
 * by echoing a "you're hired" instruction into its own output) fails.
 */
export function checkNoInjectionLeak(
  result: SemanticJdMatchResult,
  payload: string,
): boolean {
  const normalizedPayload = normalize(payload);
  if (normalizedPayload.length === 0) return true;
  if (result.verdicts.length === 0) return false;
  return result.verdicts.every((v) => {
    const requirementLeaks = normalize(v.requirement.text).includes(normalizedPayload);
    const reasonLeaks = normalize(v.reason).includes(normalizedPayload);
    return !requirementLeaks && !reasonLeaks;
  });
}
