// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * skills-order — heuristic skills-ordering coaching (issue #544).
 *
 * A résumé's Skills section is usually ordered by habit, not by relevance —
 * readers and ATS keyword scans both weight earlier items more, so a
 * high-signal skill buried mid-list undersells the candidate. This module is
 * the "start simple" heuristic the issue asks for: title/target relevance
 * (word-overlap against the candidate's derived titles) plus canonical-index
 * weighting (a stable tie-break on the skill's ORIGINAL position, so the
 * suggested order never reshuffles two equally-relevant skills for no
 * reason). Layering the on-device LLM on top is explicitly deferred — see the
 * issue's "Notes".
 *
 * Pure, dependency-free, no React/engine/I-O — mirrors `disagreement.ts` and
 * `skills-categories.ts`. Consumed by `useSkillsReorder` (the confirm/undo
 * controller) and rendered by `SkillsOrderFinding.tsx` inside
 * `SkillTermGuidance` — the résumé lane's existing heuristic skills advisory,
 * not a parallel surface, and not the WebGPU-gated critique panel (see that
 * component's docblock for why the row is not hosted there).
 */

// ── Tokenizing + scoring ───────────────────────────────────────────────────

/** Role-seniority qualifiers that would otherwise dominate every title's
 *  token set without naming a discipline — dropping them keeps the overlap
 *  test about WHAT the role does, not its level. */
const STOPWORDS = new Set([
  "senior",
  "sr",
  "junior",
  "jr",
  "staff",
  "principal",
  "lead",
  "chief",
  "head",
  "vp",
  "vice",
  "president",
  "director",
  "manager",
  "and",
  "the",
  "of",
  "for",
  "with",
]);

/** Lower-case word tokens, dropping seniority stopwords and anything shorter
 *  than 2 chars (punctuation remnants). `+`/`#` survive the split so "C++" /
 *  "C#" tokenize as themselves rather than the bare letter. */
function tokenize(text: string): Set<string> {
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9+#]+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
  return new Set(tokens);
}

/** Longest shared prefix, e.g. "developer"/"development" -> 7 ("develop"). */
function commonPrefixLength(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

/** Two tokens diverging by at most 4 chars on EITHER side of their shared
 *  stem, requiring a stem of at least 4 chars — a cheap stand-in for
 *  stemming. This is a common-prefix bound, not a "one is a prefix of the
 *  other" bound: that narrower shape (tried first) matched
 *  "engineer"/"engineering" but missed real stem pairs that diverge on BOTH
 *  sides of the shared root, like "developer"/"development" (stem "develop",
 *  +2/+4) and "analytics"/"analytical" (stem "analytic", +1/+2) — neither
 *  token is a prefix of the other. It still rejects "java"/"javascript": the
 *  stem is the whole 4-char "java", but "javascript" diverges by +6, over
 *  the cap. Both tokens must clear the 4-char stem floor so short words
 *  ("ai", "ml", "go") only match exactly, never by accidental prefix. */
function looselyMatches(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length < 4 || b.length < 4) return false;
  const stem = commonPrefixLength(a, b);
  return stem >= 4 && a.length - stem <= 4 && b.length - stem <= 4;
}

/** Relevance of one skill to the target: count of skill tokens that match a
 *  title token, exact matches counting double a loose (prefix) match — so
 *  "Engineering Leadership" against "Engineering Manager" scores higher than
 *  a skill that only loosely echoes the title. */
function relevanceScore(skill: string, titleTokens: Set<string>): number {
  let score = 0;
  for (const token of tokenize(skill)) {
    if (titleTokens.has(token)) {
      score += 2;
      continue;
    }
    for (const titleToken of titleTokens) {
      if (looselyMatches(token, titleToken)) {
        score += 1;
        break;
      }
    }
  }
  return score;
}

// ── Public shape ─────────────────────────────────────────────────────────

export interface SkillsOrderFinding {
  /** High-signal skills (relative to the target) sitting outside the "front"
   *  of the list, in their current document order. Coaching copy names these. */
  buried: string[];
  /** `skills` re-ordered relevance-desc, ties broken by original index (the
   *  canonical-index weighting) — what an Apply action would write. Always a
   *  permutation of the input `skills` array. */
  suggestedOrder: string[];
}

/** Below this many skills, "ordering" barely matters — a short list is read
 *  in full regardless of sequence, so no finding fires. */
const MIN_SKILLS_FOR_FINDING = 5;

/** The "front" of the list is the first 30% (never fewer than 3 skills) — a
 *  high-signal skill inside that window is already well-placed. */
const MIN_FRONT_WINDOW = 3;
const FRONT_FRACTION = 0.3;

/**
 * Compute the skills-ordering coaching finding, or `undefined` when nothing
 * is worth flagging: too few skills, no usable title/target signal, or no
 * skill scores above zero against it, or every top-scoring skill already
 * sits in the front window.
 *
 * `titles` is the candidate's derived target titles (`deriveTitles` from
 * `job-search/query-builder.ts`), passed in by the caller rather than
 * imported here — keeps this module dependency-free, matching the house
 * style for pure heuristics (`skills-categories.ts`).
 */
export function computeSkillsOrderFinding(
  skills: readonly string[],
  titles: readonly string[],
): SkillsOrderFinding | undefined {
  if (skills.length < MIN_SKILLS_FOR_FINDING) return undefined;

  const titleTokens = tokenize(titles.join(" "));
  if (titleTokens.size === 0) return undefined;

  const scored = skills.map((skill, index) => ({
    skill,
    index,
    score: relevanceScore(skill, titleTokens),
  }));

  const maxScore = Math.max(...scored.map((s) => s.score));
  if (maxScore <= 0) return undefined;

  const frontWindow = Math.max(
    MIN_FRONT_WINDOW,
    Math.ceil(skills.length * FRONT_FRACTION),
  );

  // High-signal = tied for the résumé's own top relevance score — a
  // conservative bar so the finding only fires on the skills a reader would
  // most regret missing, not on every skill with any overlap at all.
  const buried = scored
    .filter((s) => s.index >= frontWindow && s.score === maxScore)
    .map((s) => s.skill);

  if (buried.length === 0) return undefined;

  const suggestedOrder = [...scored]
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((s) => s.skill);

  return { buried, suggestedOrder };
}
