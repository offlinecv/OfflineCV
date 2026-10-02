// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Resume ↔ JD coverage check.
 *
 * Inputs: the cascade's `parsed` shape plus the extracted JD terms.
 * Output: which terms are covered, which are missing, plus a weighted score.
 *
 * Coverage rules:
 *   - Build a flat lowercased corpus from the resume — summary, skills array,
 *     experience titles + descriptions, education degree + field +
 *     institution.
 *   - For each JD term:
 *       · `skill` source: check any alias of that canonical ID against the
 *         corpus, word-boundary-aware via the same regex shape as the JD
 *         extractor.
 *       · `noun` source: check the literal phrase (lowercased) against the
 *         corpus, word-boundary-aware. If that literal check misses, retry
 *         ONCE with the phrase's final token swapped for its counterpart from
 *         an explicit singular/plural pair table — see `corpusMentionsPhrase`
 *         (#847).
 *   - Weight: skill = 1.0, noun = 0.5. Score is weighted coverage as a
 *     percentage: `sum(coveredWeights) / sum(totalWeights) * 100`.
 *
 * The score is intentionally a single number — the UI does not show it as
 * "X% match" (see CONTRIBUTING.md / copy discipline). The copy is built
 * around the covered/missing counts; the score is the supporting headline.
 *
 * Scoring note (#847): the noun pass used to match a JD phrase's literal
 * string only, so a résumé saying "distributed systems" reported a JD's
 * "distributed system" as missing on inflection alone — a false miss, not a
 * real gap. An earlier version of this fix normalized both sides with a
 * general stemmer (determiner-dropping, suffix rules); that was withdrawn —
 * each stemming fix opened a new hole (an all-caps résumé skipped stemming
 * and reintroduced the same false miss; a bare `endsWith("s")` rule turned
 * exact singular matches like "bias" and "lens" into false misses). A
 * single-retry swap against an explicit pair table bridges the same
 * known-good cases without acting on words nobody named, so `score` can come
 * out higher than before for a pair-table résumé/JD match. That movement is
 * the false misses going away, not a re-weighting: `SKILL_WEIGHT`/
 * `NOUN_WEIGHT` are unchanged.
 */

import type { HeuristicParsedResume } from "../heuristics/types.ts";
import type { ExtractedTerm } from "./extract-jd-terms.ts";
import { getSkillIndex } from "./skills.ts";
import {
  ALIAS_BOUNDARY_PREFIX,
  ALIAS_BOUNDARY_SUFFIX,
  escapeRegex,
} from "./regex-utils.ts";

/** Per-source weights. Skill matches are stronger evidence than noun-phrase
 *  hits because the dictionary controls precision; noun phrases are a wider
 *  net. */
export const SKILL_WEIGHT = 1.0 as const;
export const NOUN_WEIGHT = 0.5 as const;

export interface CoverageResult {
  covered: ExtractedTerm[];
  missing: ExtractedTerm[];
  /** Weighted coverage in 0..100. Rounded to one integer. */
  score: number;
  /** Surfaces the per-source weights so UI copy can describe how the score
   *  was built without having to re-import the constants. */
  weights: { skill: number; noun: number };
}

/**
 * Run the coverage check against an already-built corpus.
 *
 * The corpus — one lowercased string, as `buildCorpus` produces — is the only
 * thing coverage matching ever reads. Splitting it out from `computeCoverage`
 * (#700) makes "the résumé, reduced to what matching actually reads" a value a
 * caller can hold, cache, or hand across a boundary WITHOUT holding a whole
 * `HeuristicParsedResume`. A consumer that has only the digest can now score
 * against it instead of forking a second coverage implementation, which is the
 * fastest route to two scores that disagree.
 *
 * `corpus` MUST already be lowercased: the skill mention patterns and the
 * phrase check below are matched case-insensitively against it on the
 * assumption `buildCorpus` did that normalization.
 */
export function computeCoverageFromCorpus(
  corpus: string,
  terms: readonly ExtractedTerm[],
): CoverageResult {
  const covered: ExtractedTerm[] = [];
  const missing: ExtractedTerm[] = [];

  for (const term of terms) {
    const hit =
      term.source === "skill"
        ? corpusMentionsSkill(corpus, term.id)
        : corpusMentionsPhrase(corpus, term.display);
    if (hit) covered.push(term);
    else missing.push(term);
  }

  let coveredWeight = 0;
  let totalWeight = 0;
  for (const term of terms) {
    const w = term.source === "skill" ? SKILL_WEIGHT : NOUN_WEIGHT;
    totalWeight += w;
    if (covered.includes(term)) coveredWeight += w;
  }
  const score =
    totalWeight === 0 ? 0 : Math.round((coveredWeight / totalWeight) * 100);

  return {
    covered,
    missing,
    score,
    weights: { skill: SKILL_WEIGHT, noun: NOUN_WEIGHT },
  };
}

/**
 * Run the coverage check against a parsed résumé.
 *
 * `parsed` is the cascade's HeuristicParsedResume — `skills: string[]`,
 * `experience[].description`, `summary?`, `education[]`. We tolerate any
 * field being missing. Education contributes its degree / field / institution
 * only: `ResumeEducation` carried a `description` that no producer ever wrote
 * (#883), so the read was dead and is gone along with the field.
 *
 * A thin wrapper over `computeCoverageFromCorpus`, kept at its original
 * signature so every existing caller is untouched. This is the ONLY place the
 * two are joined, so there is exactly one coverage implementation.
 */
export function computeCoverage(
  parsed: HeuristicParsedResume,
  terms: readonly ExtractedTerm[],
): CoverageResult {
  return computeCoverageFromCorpus(buildCorpus(parsed), terms);
}

/**
 * Flatten the parsed resume into a single newline-joined string — summary,
 * skills, and each experience/education entry's text fields, in document order.
 * Sections are joined with newlines so word boundaries between fields stay
 * intact (a skill at the end of one bullet doesn't fuse with the start of the
 * next). Case is preserved: this is the human-readable projection. `buildCorpus`
 * lowercases it for case-insensitive coverage matching; the WebLLM evidence
 * judge (#201) reuses it verbatim as a reference block, where case matters for
 * readable cited snippets.
 */
export function buildResumeProjection(parsed: HeuristicParsedResume): string {
  const parts: string[] = [];
  if (parsed.summary) parts.push(parsed.summary);
  if (parsed.skills && parsed.skills.length > 0) {
    parts.push(parsed.skills.join("\n"));
  }
  for (const exp of parsed.experience ?? []) {
    pushPresent(parts, exp.title, exp.company, exp.description);
  }
  for (const edu of parsed.education ?? []) {
    // `field` is the SUBJECT of study, and `degree` deliberately excludes it —
    // the extractor splits "Bachelor of Technology, Computer Science &
    // Engineering" into credential + field (`extract/education.ts`
    // `parseDegreeAndField`). Projecting only `degree` therefore drops the one
    // part of an education entry a JD ever asks for: measured on a real résumé,
    // a posting requiring "Computer Science" scored it MISSING against a CS
    // graduate purely because the field never reached the corpus.
    pushPresent(parts, edu.degree, edu.field, edu.institution);
  }
  return parts.join("\n");
}

/** Append each defined, non-empty field to `parts`, preserving argument order. */
function pushPresent(
  parts: string[],
  ...fields: Array<string | undefined>
): void {
  for (const field of fields) {
    if (field) parts.push(field);
  }
}

/**
 * Flatten the parsed resume into a single lowercased searchable string — the
 * projection above, lowercased for case-insensitive term coverage matching.
 */
export function buildCorpus(parsed: HeuristicParsedResume): string {
  return buildResumeProjection(parsed).toLowerCase();
}

function corpusMentionsSkill(corpus: string, canonicalId: string): boolean {
  const re = getSkillIndex().mentionPatterns.get(canonicalId);
  return re ? re.test(corpus) : false;
}

/**
 * Explicit singular ↔ plural pairs for noun-phrase head words that are known
 * to cost a false "Missing" on inflection alone (#847). Written out, not
 * derived from a suffix rule: `responsibility`/`responsibilities` is a
 * `y`→`ies` change, and a generic `-s`/`-es` rule is exactly what reintroduced
 * false misses (an all-caps résumé skipping a stemmer) and false matches
 * (`endsWith("s")` turning "bias"/"lens" into "bia"/"len") in an earlier,
 * withdrawn version of this fix. An allowlist can't break what it doesn't
 * name — a phrase whose head isn't in this table gets no swap, and behaves
 * exactly as the literal match on `main` did.
 *
 * Every entry here is a head noun the JD extractor demonstrably emits, not an
 * invented plural — the comment on each pair names the JD phrase from
 * `extract-jd-terms.test.ts` it was taken from, so a future trim or addition
 * can be checked against the same source instead of taken on faith.
 * `coverage.test.ts` pins this exact set against the list #847 seeds.
 */
export const PHRASE_HEAD_INFLECTION_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["system", "systems"], // "Distributed System(s)"
  ["bias", "biases"],
  ["lens", "lenses"],
  ["responsibility", "responsibilities"], // "Key Responsibilities"
  ["service", "services"], // "Backend Services"
  ["function", "functions"], // "Essential Functions" / "Cloud Functions"
  ["qualification", "qualifications"], // "Basic/Minimum/Preferred Qualifications"
  ["demand", "demands"], // "Physical Demands"
  ["app", "apps"], // "Info Apps" / "beloved apps"
  ["team", "teams"], // "Info Apps team" / "engineering team"
  ["keyword", "keywords"], // "missing keywords" (#156 structural-heading comment)
];

/** Bidirectional lookup built from the pair table above — singular maps to
 *  plural and plural maps to singular, so a swap works whichever direction
 *  the JD phrase and the résumé wording happen to disagree in (#847). */
const PHRASE_HEAD_PAIRS: ReadonlyMap<string, string> = (() => {
  const pairs = new Map<string, string>();
  for (const [singular, plural] of PHRASE_HEAD_INFLECTION_PAIRS) {
    pairs.set(singular, plural);
    pairs.set(plural, singular);
  }
  return pairs;
})();

/**
 * Swap `phrase`'s final word for its counterpart in `PHRASE_HEAD_PAIRS`, or
 * return `null` if the final word isn't in the table. Only the last word
 * (the phrase's head noun) is ever swapped — never a middle word — so this
 * cannot merge two phrases that differ anywhere but their final word.
 */
function swapFinalTokenInflection(phrase: string): string | null {
  const match = /^(.*?)([A-Za-z0-9]+)$/.exec(phrase);
  if (!match) return null;
  const [, prefix, lastWord] = match;
  const swapped = PHRASE_HEAD_PAIRS.get(lastWord.toLowerCase());
  return swapped === undefined ? null : `${prefix}${swapped}`;
}

/** Literal, word-boundary-aware phrase match — the same check `main` has
 *  always used for the noun pass. */
function literalPhraseMatches(corpus: string, phrase: string): boolean {
  const re = new RegExp(
    `${ALIAS_BOUNDARY_PREFIX}${escapeRegex(phrase.toLowerCase())}${ALIAS_BOUNDARY_SUFFIX}`,
    "i",
  );
  return re.test(corpus);
}

/**
 * A noun-pass phrase is "covered" when it appears in the corpus literally,
 * OR — only when the literal check misses — when it appears after swapping
 * its final word for the counterpart `PHRASE_HEAD_PAIRS` names (#847). This
 * credits a résumé's "distributed systems" for a JD's "distributed system",
 * and the reverse, without touching any word the table doesn't name: "on-call
 * rotation" still misses against a résumé that only says "production support
 * rotation" — the earlier words differ and no swap bridges that, nor is it
 * meant to (#156 is the semantic path for genuinely different wording).
 */
function corpusMentionsPhrase(corpus: string, phrase: string): boolean {
  if (literalPhraseMatches(corpus, phrase)) return true;
  const swapped = swapFinalTokenInflection(phrase);
  return swapped !== null && literalPhraseMatches(corpus, swapped);
}
