// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * role-keywords.ts — a curated role/function → title-synonym taxonomy plus the
 * board title-filter and per-company size caps (#534, slice of the
 * job-search-v2 epic #528).
 *
 * Company ATS boards have no server-side free-text search — a search pulls the
 * WHOLE board (100s–1000s of roles). This module is the layer that narrows a
 * board's light-index postings to the ones relevant to the candidate and caps
 * the count, before descriptions are hydrated and `rankPostings` ranks them. It
 * only *narrows and caps*; full ranking (coverage against a hydrated
 * description) is out of scope. `scoreByTitleAgainstQuery` (#565) is the one
 * exception: a CHEAP, title-only, no-I/O score used solely to pick WHICH
 * postings survive `capPerCompany`'s slice, not to rank the survivors that
 * reach `rankPostings`. `filterPostingsByExcludeTerms` (#563) is the sibling
 * negative filter — user-editable, title-only exclude terms, seeded (visibly
 * and removably) from the role-family classification via
 * `seedExcludeTermsForFamilies` — applied in `company-boards.ts` immediately
 * after `filterPostingsByRole` and strictly BEFORE `orderPostingsByTitleScore`
 * / `capPerCompany`, so an excluded posting never consumes a company's cap
 * slot.
 *
 * THREE LOAD-BEARING INVARIANTS:
 *
 * 1. TITLES, NOT SKILLS. `roleFilterForResume` classifies the candidate from
 *    their ROLE TITLES — `experience[].title` plus any standalone `headline` /
 *    `current_title` target-role signal — and NEVER from `skills`. Skills almost
 *    never appear in a job title (`Senior Frontend Engineer` names no library),
 *    so filtering board titles by resume skills (`React`, `Postgres`) mismatches
 *    the surfaces. A resume whose *skills* match a family but whose *titles* do
 *    not must NOT be classified into that family — this function does not read
 *    `parsed.skills*` at all, which is the mechanical guarantee of that.
 *
 * 2. NEVER FAIL CLOSED. An empty / degenerate / unrecognized resume yields a
 *    PERMISSIVE "all" filter (`families: []`, `keywords: []`) that keeps every
 *    posting. The feature degrades to "whole board, capped" — never to zero
 *    results. `filterPostingsByRole` returns its input unchanged for an "all"
 *    filter.
 *
 * 3. ZERO-EGRESS / DIFFERENT PRIVACY CLASS. This keyword set is a purely local
 *    title filter and is a DIFFERENT privacy class from `keywords.ts` (the
 *    audited egress string sent to the keyless job feeds). It never leaves the
 *    browser: it is not sent to any ATS board and MUST NOT be imported into,
 *    routed through, or built from `keywords.ts`. No network, no raw-PDF text —
 *    pure over the parsed resume model, mirroring `src/lib/score/score.ts`.
 *
 * `RoleFamily` (which roles WITHIN a board) is deliberately distinct from
 * #531's `Sector` (which COMPANIES to search); do not conflate them.
 *
 * ROLE_KEYWORDS sourcing: hand-curated from common software job-title phrasings
 * (each family's real title synonyms, including hyphen/space variants such as
 * `front-end` / `front end` / `frontend`), chosen for precision on titles — a
 * keyword is specific enough not to cross-match another family (bare "engineer"
 * would be useless). Staleness is tolerable: a missing synonym only filters
 * slightly narrower, never wrong. Curated on 2026-07-21.
 */

import type { HeuristicParsedResume } from "../heuristics/types.ts";
import type { JobPosting } from "./types.ts";
import type { JobQuery } from "./query-builder.ts";
import { parseSeniorityLabel } from "./query-builder.ts";
import { seniorityRungDistance } from "./seniority.ts";

/**
 * Fixed role-family taxonomy — the SINGLE SOURCE OF TRUTH for "which roles
 * within a board". Declaration order is also the deterministic tie-break order
 * when two families score equally in `roleFilterForResume`. Distinct from
 * #531's `Sector`; there is intentionally no `"other"` member — an
 * unclassifiable resume produces the permissive "all" filter instead.
 */
export const ROLE_FAMILIES = [
  "frontend",
  "backend",
  "fullstack",
  "mobile",
  "data",
  "ml",
  "sre-devops",
  "security",
  "qa",
  "design",
  "pm",
  "sales",
  "marketing",
  "support",
] as const;

export type RoleFamily = (typeof ROLE_FAMILIES)[number];

/**
 * Curated function → title-synonym map. Each family maps to lowercased
 * substrings that appear in real job titles for that family. Every substring is
 * matched case-insensitively against a posting's lowercased title (+ optional
 * departments). Keep entries specific enough not to cross-match a sibling
 * family. Curated on 2026-07-21 (see file docblock for sourcing).
 */
export const ROLE_KEYWORDS: Readonly<Record<RoleFamily, readonly string[]>> = {
  frontend: [
    "frontend",
    "front end",
    "front-end",
    "ui engineer",
    "ui developer",
    "web developer",
    "web engineer",
    "react developer",
    "javascript engineer",
  ],
  backend: [
    "backend",
    "back end",
    "back-end",
    "server-side",
    "server side",
    "api engineer",
    "distributed systems",
    "golang engineer",
  ],
  fullstack: ["fullstack", "full stack", "full-stack"],
  mobile: [
    "mobile engineer",
    "mobile developer",
    "ios engineer",
    "ios developer",
    "android engineer",
    "android developer",
    "react native",
    "flutter developer",
  ],
  data: [
    "data engineer",
    "data analyst",
    "analytics engineer",
    "business intelligence",
    "bi developer",
    "data platform",
    "data warehouse",
  ],
  ml: [
    "machine learning",
    "ml engineer",
    "ml scientist",
    "data scientist",
    "deep learning",
    "nlp engineer",
    "computer vision",
    "applied scientist",
    "research scientist",
    "ai engineer",
  ],
  "sre-devops": [
    "devops",
    "sre",
    "site reliability",
    "platform engineer",
    "infrastructure engineer",
    "cloud engineer",
    "reliability engineer",
    "systems engineer",
  ],
  security: [
    "security engineer",
    "security analyst",
    "security architect",
    "appsec",
    "application security",
    "infosec",
    "penetration tester",
    "cybersecurity",
  ],
  qa: [
    "qa engineer",
    "quality assurance",
    "test engineer",
    "sdet",
    "automation engineer",
    "quality engineer",
  ],
  design: [
    "designer",
    "ux researcher",
    "user experience",
    "design lead",
    "interaction design",
    "visual design",
  ],
  pm: [
    "product manager",
    "product management",
    "program manager",
    "project manager",
    "technical product manager",
    "group product manager",
  ],
  sales: [
    "account executive",
    "sales engineer",
    "sales representative",
    "business development",
    "account manager",
    "sales development",
    "solutions engineer",
  ],
  marketing: [
    "marketing manager",
    "growth marketing",
    "content marketing",
    "seo specialist",
    "demand generation",
    "brand manager",
    "product marketing",
    "social media manager",
  ],
  support: [
    "customer support",
    "customer success",
    "technical support",
    "support engineer",
  ],
};

/**
 * The candidate's inferred role filter. `families: []` (⟺ `keywords: []`) is
 * the permissive "all" filter — the never-fail-closed floor that keeps every
 * posting. `source` is `"heuristic"` today and reserves room for a future
 * semantic (WebLLM) upgrade, like #531's classifier.
 */
export interface RoleFilter {
  /** Inferred role families, dominant first (usually 1–2). Empty ⇒ "all". */
  families: RoleFamily[];
  /** Flattened, deduped, lowercased substrings to match titles against. */
  keywords: string[];
  source: "heuristic";
}

/** How many dominant families `roleFilterForResume` keeps. */
const MAX_FAMILIES = 2;

/**
 * Relative floor the runner-up family must clear to be kept alongside the
 * winner: at least half the winner's score. Without it, `score > 0` alone
 * admits any stray title — a career-switcher with eight backend titles and one
 * early-career "UX Designer" would get `["backend", "design"]`, and design's
 * very broad keywords ("designer", "user experience") then keep every Designer
 * posting on every board: precisely the roles the candidate left.
 */
const RUNNER_UP_SHARE = 2;

/**
 * A sensible default per-company cap for callers (#533) that don't specify.
 * Lowered from 15 to 8 alongside the #542 `COMPANY_LIMIT` raise (8 → 14) so
 * the pre-rank posting ceiling stays sane: 14 * 8 = 112, versus the previous
 * 8 * 15 = 120 — the pairing changed shape but not its order of magnitude.
 */
export const DEFAULT_PER_COMPANY_CAP = 8;

/** Declaration-order index of a family, for the deterministic tie-break. */
const FAMILY_ORDER: ReadonlyMap<RoleFamily, number> = new Map(
  ROLE_FAMILIES.map((family, index) => [family, index]),
);

/**
 * Families whose boards get flooded by adjacent customer-facing/GTM roles
 * that share every positive keyword an engineering résumé carries (#563) —
 * Solutions Architect, Forward Deployed Engineer, Developer Advocate, etc.
 * are a genuinely different job (GTM, not engineering ownership) that no
 * amount of positive-keyword tuning separates. `sales` / `marketing` /
 * `support` / `design` / `pm` are deliberately excluded: a sales-family
 * query must NOT seed engineering negatives against itself.
 */
const ENGINEERING_ADJACENT_FAMILIES: ReadonlySet<RoleFamily> = new Set([
  "frontend",
  "backend",
  "fullstack",
  "mobile",
  "data",
  "ml",
  "sre-devops",
  "security",
  "qa",
]);

/**
 * Default exclude-term seeds for an engineering-family query — the exact
 * adjacent-role list from #563's problem statement. Lowercased; matched as
 * case-insensitive title substrings by `filterPostingsByExcludeTerms`.
 */
const ENGINEERING_EXCLUDE_SEEDS: readonly string[] = [
  "solutions architect",
  "solution architect",
  "deployment architect",
  "field architect",
  "forward deployed engineer",
  "sales engineer",
  "solutions engineer",
  "developer advocate",
  "developer relations",
  "evangelist",
  "customer success",
  "partner engineering",
  "account executive",
];

/**
 * Seed removable exclude-term chips from the resume's classified role
 * families (#563) — the caller (`FindJobsPanel`, via `buildJobQuery`) renders
 * these as ordinary removable chips, never applies them invisibly. An
 * engineering-adjacent family seeds the curated GTM/field-role negatives; any
 * other family (sales/marketing/support/design/pm) or the permissive "all"
 * filter (`families: []`) seeds nothing — there is no engineering-negatives
 * list to seed against a non-engineering search.
 */
export function seedExcludeTermsForFamilies(
  families: readonly RoleFamily[],
): string[] {
  const isEngineeringAdjacent = families.some((family) =>
    ENGINEERING_ADJACENT_FAMILIES.has(family),
  );
  return isEngineeringAdjacent ? [...ENGINEERING_EXCLUDE_SEEDS] : [];
}

/**
 * Collect the lowercased, non-empty TITLE strings the filter reads: every
 * `experience[].title`, plus the standalone `headline` and `current_title`
 * target-role signals when the parsed model carries them. Deliberately does NOT
 * touch `skills` — that is the titles-not-skills invariant, enforced by
 * omission.
 */
function collectTitles(parsed: HeuristicParsedResume): string[] {
  const titles: string[] = [];
  for (const exp of parsed.experience ?? []) {
    if (exp.title) titles.push(exp.title.toLowerCase());
  }
  if (parsed.headline) titles.push(parsed.headline.toLowerCase());
  if (parsed.current_title) titles.push(parsed.current_title.toLowerCase());
  return titles;
}

/** Dedupe while preserving first-seen order (deterministic keyword list). */
function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/**
 * Derive the role filter from the parsed resume's TITLES (never its skills).
 * Scores every family by how many title strings match one of its keywords,
 * keeps the dominant family plus a runner-up that clears `RUNNER_UP_SHARE`
 * (deterministic tie-break by taxonomy order),
 * and flattens their keywords. A resume that matches no family yields the
 * permissive "all" filter — never zero results.
 */
export function roleFilterForResume(parsed: HeuristicParsedResume): RoleFilter {
  const titles = collectTitles(parsed);

  const scored = ROLE_FAMILIES.map((family) => {
    const keywords = ROLE_KEYWORDS[family];
    const score = titles.reduce(
      (count, title) =>
        count + (keywords.some((kw) => title.includes(kw)) ? 1 : 0),
      0,
    );
    return { family, score };
  }).filter((entry) => entry.score > 0);

  if (scored.length === 0) {
    // Never fail closed: unrecognized/empty resume → permissive "all".
    return { families: [], keywords: [], source: "heuristic" };
  }

  scored.sort(
    (a, b) =>
      b.score - a.score ||
      (FAMILY_ORDER.get(a.family) ?? 0) - (FAMILY_ORDER.get(b.family) ?? 0),
  );

  const [winner, ...rest] = scored;
  const families = [winner, ...rest.filter((e) => e.score * RUNNER_UP_SHARE >= winner.score)]
    .slice(0, MAX_FAMILIES)
    .map((entry) => entry.family);
  const keywords = dedupe(families.flatMap((family) => [...ROLE_KEYWORDS[family]]));

  return { families, keywords, source: "heuristic" };
}

/**
 * Build a `RoleFilter` from an EXPLICIT family list rather than deriving one
 * from the résumé (#568) — the counterpart to `roleFilterForResume` for the
 * "target level"-style refinement controls: `FindJobsPanel` seeds
 * `JobQuery.families` from `roleFilterForResume(parsed).families` and lets
 * the user remove chips from it, and every downstream reader that has an
 * asserted `query.families` rebuilds its filter from THIS function instead of
 * re-deriving from the résumé, so a removed chip actually narrows the search.
 *
 * NEVER FAIL CLOSED, the same floor `roleFilterForResume` guarantees: an
 * empty `families` (every seeded chip removed) returns the permissive "all"
 * filter (`families: []`, `keywords: []`), not a filter that matches nothing.
 */
export function roleFilterForFamilies(families: readonly RoleFamily[]): RoleFilter {
  if (families.length === 0) {
    return { families: [], keywords: [], source: "heuristic" };
  }
  const keywords = dedupe(families.flatMap((family) => [...ROLE_KEYWORDS[family]]));
  return { families: [...families], keywords, source: "heuristic" };
}

/** Lowercased haystack a posting is matched against: title + any departments. */
function postingHaystack(posting: JobPosting): string {
  const departments = posting.departments ?? [];
  return `${posting.title} ${departments.join(" ")}`.toLowerCase();
}

/**
 * Keep a posting when any filter keyword is a case-insensitive substring of its
 * title (or one of its departments). Input order is preserved. An "all" filter
 * (empty keyword set) returns the input array UNCHANGED — the never-fail-closed
 * floor — so the caller shows the whole (capped) board rather than nothing.
 */
export function filterPostingsByRole(
  postings: JobPosting[],
  filter: RoleFilter,
): JobPosting[] {
  if (filter.keywords.length === 0) return postings;
  return postings.filter((posting) => {
    const haystack = postingHaystack(posting);
    return filter.keywords.some((kw) => haystack.includes(kw));
  });
}

/** Result of `filterPostingsByExcludeTerms` — `suppressed: true` means the
 *  exclusion was SKIPPED (input returned unchanged) because applying it would
 *  have emptied a non-empty input; the caller surfaces that as a notice. */
export interface ExcludeFilterResult {
  postings: JobPosting[];
  suppressed: boolean;
}

/**
 * Drop a posting whose TITLE — never its description — contains one of
 * `excludeTerms` as a case-insensitive substring (#563). Deliberately
 * title-only: a posting whose description merely mentions "customer success"
 * is not the same job as one titled that, and description-side exclusion
 * would over-fire (see the issue's problem statement).
 *
 * NEVER FAIL CLOSED, same floor as `filterPostingsByRole`: an empty
 * `excludeTerms` (or one with only blank entries) returns the input
 * unchanged (`suppressed: false`). And if applying real exclude terms would
 * drop EVERY posting in a non-empty input, the exclusion is skipped
 * entirely — the input comes back unchanged with `suppressed: true` — rather
 * than silently handing the caller an empty result. The caller is expected to
 * render that as a notice (see `JobSearchResults`), never as a blank panel.
 */
export function filterPostingsByExcludeTerms(
  postings: readonly JobPosting[],
  excludeTerms: readonly string[] | undefined,
): ExcludeFilterResult {
  const terms = (excludeTerms ?? [])
    .map((term) => term.trim().toLowerCase())
    .filter((term) => term.length > 0);

  if (terms.length === 0 || postings.length === 0) {
    return { postings: [...postings], suppressed: false };
  }

  const filtered = postings.filter((posting) => {
    const title = posting.title.toLowerCase();
    return !terms.some((term) => title.includes(term));
  });

  if (filtered.length === 0) {
    // Never fail closed: skip the exclusion rather than empty the panel.
    return { postings: [...postings], suppressed: true };
  }

  return { postings: filtered, suppressed: false };
}

/**
 * Bound the kept set to at most `limit` postings per company so hydration and
 * ranking stay cheap. Preserves input order and keeps the first `limit`
 * postings of each company (companies compared case-insensitively, trimmed).
 * `limit <= 0` keeps none.
 */
export function capPerCompany(
  postings: JobPosting[],
  limit: number,
): JobPosting[] {
  if (limit <= 0) return [];
  const counts = new Map<string, number>();
  const kept: JobPosting[] = [];
  for (const posting of postings) {
    const key = posting.company.trim().toLowerCase();
    const seen = counts.get(key) ?? 0;
    if (seen >= limit) continue;
    counts.set(key, seen + 1);
    kept.push(posting);
  }
  return kept;
}

/** Split a lowercased string into significant (length > 2) word tokens. */
const WORD_SPLIT = /[\s/,&()-]+/;
function tokenizeWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(WORD_SPLIT)
      .filter((word) => word.length > 2),
  );
}

/** Points added per query-title word that also appears in the posting's
 *  title/departments haystack — see `scoreByTitleAgainstQuery`. */
const TITLE_WORD_OVERLAP_WEIGHT = 10;

/**
 * Points added when the posting title's parsed seniority level sits at the
 * SAME rung as `query.seniority`, decaying by rung distance to 0. Sized well
 * below a single word-overlap hit (`TITLE_WORD_OVERLAP_WEIGHT`) so seniority
 * only breaks a close race between otherwise similarly-titled postings — it
 * never lets a level match outrank a genuine title mismatch.
 */
const SENIORITY_MATCH_MAX_BONUS = 4;

/**
 * Cheap, title-only, no-I/O relevance score for one posting against the
 * query BEFORE `capPerCompany` slices (#565) — the light-index posting
 * already carries everything this reads (`title` + optional `departments`),
 * so no hydration or extra fetch is needed to compute it.
 *
 * Word-overlap against `query.titles`: every distinct word (length ≥ 3
 * chars) shared between the posting's title/departments haystack and any of
 * the candidate's résumé titles adds `TITLE_WORD_OVERLAP_WEIGHT`. Optionally
 * nudged by `query.seniority` (#562): when both the query and the posting
 * title carry a recognizable level, the score gets a small bonus that decays
 * with rung distance — an exact-level match nudges ahead of an
 * otherwise-tied adjacent-level posting, but never dominates the word-overlap
 * signal.
 *
 * Returns 0 when `query.titles` is empty (a skills-only/degenerate query has
 * no title signal to score against) or when nothing overlaps — a uniform 0
 * across a whole board is harmless: `orderPostingsByTitleScore` keeps ties in
 * their original (board) order, so the never-fail-closed floor holds.
 */
export function scoreByTitleAgainstQuery(
  posting: JobPosting,
  query: Pick<JobQuery, "titles" | "seniority">,
): number {
  if (query.titles.length === 0) return 0;

  const queryWords = new Set<string>();
  for (const title of query.titles) {
    for (const word of tokenizeWords(title)) queryWords.add(word);
  }

  let overlap = 0;
  for (const word of tokenizeWords(postingHaystack(posting))) {
    if (queryWords.has(word)) overlap += 1;
  }

  const seniorityDistance = seniorityRungDistance(
    query.seniority,
    parseSeniorityLabel(posting.title),
  );
  const seniorityBonus =
    seniorityDistance === undefined
      ? 0
      : Math.max(0, SENIORITY_MATCH_MAX_BONUS - seniorityDistance);

  return overlap * TITLE_WORD_OVERLAP_WEIGHT + seniorityBonus;
}

/**
 * Reorder `postings` by `scoreByTitleAgainstQuery` descending so the survivors
 * `capPerCompany` keeps are the best-matching per company, not the first in
 * board order (#565). Ties (including the all-zero case — no title signal, or
 * an empty `query.titles`) keep their original relative order, an explicit
 * stable sort rather than relying on engine sort stability: the
 * never-fail-closed floor is that a degenerate query reduces to today's
 * board-order behavior, never to an empty or reshuffled-for-no-reason result.
 * Runs strictly BEFORE `capPerCompany` — it reorders the full filtered set,
 * never trims it, so `capPerCompany`'s own contract (per-company counting,
 * case-insensitive company key, `limit <= 0` keeps none) is untouched.
 */
export function orderPostingsByTitleScore(
  postings: readonly JobPosting[],
  query: Pick<JobQuery, "titles" | "seniority">,
): JobPosting[] {
  return postings
    .map((posting, index) => ({
      posting,
      index,
      score: scoreByTitleAgainstQuery(posting, query),
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.posting);
}
