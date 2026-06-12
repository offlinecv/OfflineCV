// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Resume ↔ JD coverage check.
 *
 * Inputs: the cascade's `parsed` shape plus the extracted JD terms.
 * Output: which terms are covered, which are missing, plus a weighted score.
 *
 * Coverage rules:
 *   - Build a flat lowercased corpus from the resume — summary, skills array,
 *     experience titles + descriptions, education degree + institution +
 *     description.
 *   - For each JD term:
 *       · `skill` source: check any alias of that canonical ID against the
 *         corpus, word-boundary-aware via the same regex shape as the JD
 *         extractor.
 *       · `noun` source: check the literal phrase (lowercased) against the
 *         corpus, word-boundary-aware.
 *   - Weight: skill = 1.0, noun = 0.5. Score is weighted coverage as a
 *     percentage: `sum(coveredWeights) / sum(totalWeights) * 100`.
 *
 * The score is intentionally a single number — the UI does not show it as
 * "X% match" (see CONTRIBUTING.md / copy discipline). The copy is built
 * around the covered/missing counts; the score is the supporting headline.
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
 * Run the coverage check.
 *
 * `parsed` is the cascade's HeuristicParsedResume — `skills: string[]`,
 * `experience[].description`, `summary?`, `education[]`. We tolerate any
 * field being missing.
 */
export function computeCoverage(
  parsed: HeuristicParsedResume,
  terms: readonly ExtractedTerm[],
): CoverageResult {
  const corpus = buildCorpus(parsed);
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
 * Flatten the parsed resume into a single lowercased searchable string.
 * Sections are joined with newlines so word boundaries between fields stay
 * intact (a skill at the end of one bullet doesn't fuse with the start of
 * the next).
 */
export function buildCorpus(parsed: HeuristicParsedResume): string {
  const parts: string[] = [];
  if (parsed.summary) parts.push(parsed.summary);
  if (parsed.skills && parsed.skills.length > 0) {
    parts.push(parsed.skills.join("\n"));
  }
  for (const exp of parsed.experience ?? []) {
    if (exp.title) parts.push(exp.title);
    if (exp.company) parts.push(exp.company);
    if (exp.description) parts.push(exp.description);
  }
  for (const edu of parsed.education ?? []) {
    if (edu.degree) parts.push(edu.degree);
    if (edu.institution) parts.push(edu.institution);
    if (edu.description) parts.push(edu.description);
  }
  return parts.join("\n").toLowerCase();
}

function corpusMentionsSkill(corpus: string, canonicalId: string): boolean {
  const re = getSkillIndex().mentionPatterns.get(canonicalId);
  return re ? re.test(corpus) : false;
}

function corpusMentionsPhrase(corpus: string, phrase: string): boolean {
  const re = new RegExp(
    `${ALIAS_BOUNDARY_PREFIX}${escapeRegex(phrase.toLowerCase())}${ALIAS_BOUNDARY_SUFFIX}`,
    "i",
  );
  return re.test(corpus);
}
