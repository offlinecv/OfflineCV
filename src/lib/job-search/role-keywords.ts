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
 * only *narrows and caps*; ranking is out of scope.
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

/** A sensible default per-company cap for callers (#533) that don't specify. */
export const DEFAULT_PER_COMPANY_CAP = 15;

/** Declaration-order index of a family, for the deterministic tie-break. */
const FAMILY_ORDER: ReadonlyMap<RoleFamily, number> = new Map(
  ROLE_FAMILIES.map((family, index) => [family, index]),
);

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
