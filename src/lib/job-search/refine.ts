// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * refineSearchResult — apply the query's LOCAL refinement knobs (role
 * families #568, exclude terms #563) and rank (#545/#561/#562/#564) over an
 * already-fetched, already-deduped posting set.
 *
 * Pulled out of `searchJobs` (`search.ts`) so `FindJobsPanel` can re-run the
 * SAME pipeline on every edit to a refinement control (role family, target
 * level, exclude term, comp floor, location) WITHOUT a new fetch — that's the
 * #568 "changing any control re-ranks results live" requirement. Re-ranking
 * already-fetched postings is not a fetch, so this keeps `searchJobs`'s own
 * "fetch fires ONLY on the Search click" invariant (`FindJobsPanel`'s
 * docblock) intact — no new egress, `providers/keywords.ts` stays the sole
 * resume-derived egress helper either way.
 *
 * The only I/O this does is the dynamic import of `rank.ts` (the cascade-tier
 * pattern already used by `search.ts` — jd-match's skill dictionary stays out
 * of the entry chunk). `searchJobs` calls this once per fetch; `FindJobsPanel`
 * calls it again, locally, on every subsequent refinement-control edit.
 */

import type { HeuristicParsedResume } from "../heuristics/types.ts";
import type { JobPosting } from "./types.ts";
import type { JobQuery } from "./query-builder.ts";
import type { RoleFamily } from "./role-keywords.ts";
import {
  filterPostingsByRole,
  filterPostingsByExcludeTerms,
  roleFilterForFamilies,
} from "./role-keywords.ts";
import type { JobSearchResult } from "./search.ts";

export async function refineSearchResult(
  rawPostings: readonly JobPosting[],
  parsed: HeuristicParsedResume,
  query: JobQuery,
  degradedProviders: readonly string[],
  providerCount: number,
): Promise<JobSearchResult> {
  const { rankPostings } = await import("./rank.ts");

  // Role families (#568): `query.families` elements are `RoleFamily` labels —
  // FindJobsPanel only ever seeds this from `roleFilterForResume(...).families`
  // and lets the user REMOVE entries, never add arbitrary text, so the cast is
  // safe. `undefined` (never asserted — every pre-#568 caller) skips this
  // filter entirely, byte-identical to prior behavior.
  //
  // NEVER FAIL CLOSED (#566), the same floor `filterPostingsByExcludeTerms`
  // already applies: role keywords are narrow TITLE substrings while
  // `matchesQuery` admits a posting on title tokens + skills + description, so
  // a generically-titled keyless-feed posting ("Software Engineer") can pass
  // the query yet match no role keyword. On an all-generic merged set the role
  // filter would empty the panel and show only the misleading "broaden the
  // query" state. So: when a non-empty family filter would reduce a NON-EMPTY
  // merged set to EMPTY, skip it (keep the input) and flag `roleSuppressed` for
  // a notice — pointing the user at the Role chips. This wraps the decision at
  // the merged-set step only; the per-board role filter in `company-boards.ts`
  // keeps its fail-closed-to-empty contract (a single empty board is normal).
  let roleFiltered: JobPosting[];
  let roleSuppressed = false;
  if (query.families !== undefined) {
    const candidate = filterPostingsByRole(
      [...rawPostings],
      roleFilterForFamilies(query.families as RoleFamily[]),
    );
    if (candidate.length === 0 && rawPostings.length > 0) {
      roleFiltered = [...rawPostings];
      roleSuppressed = true;
    } else {
      roleFiltered = candidate;
    }
  } else {
    roleFiltered = [...rawPostings];
  }

  const { postings: filtered, suppressed: excludeSuppressed } =
    filterPostingsByExcludeTerms(roleFiltered, query.excludeTerms);

  return {
    jobs: rankPostings(parsed, filtered, query),
    degradedProviders: [...degradedProviders],
    providerCount,
    excludeSuppressed,
    roleSuppressed,
    rawPostings: [...rawPostings],
  };
}
