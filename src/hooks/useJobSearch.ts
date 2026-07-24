// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Owns the Find Jobs fetch lifecycle AND the #568 live re-rank, so
 * `FindJobsPanel` stays a layout shell. Cross-cutting interaction state per
 * CLAUDE.md's "hooks own modals/drop zones/locks" rule — this is the same
 * shape (a fetch + a derived recompute), just for the search panel.
 *
 * TWO responsibilities, one hook, because they share state a split would
 * have to duplicate (the abort controller, the raw-postings snapshot):
 *
 * 1. `runSearch` — the ONLY thing that fetches. Never fires on mount, drop,
 *    tab open, or a query edit — only an explicit caller invocation (the
 *    panel's Search button). `searchJobs` dynamic-imports the provider/rank
 *    tiers, so nothing job-fetch-related sits in the entry chunk.
 * 2. The live re-rank effect (#568) — re-runs `refineSearchResult` (the SAME
 *    role/exclude filter + rank pipeline `searchJobs` used) over the last
 *    fetch's raw postings whenever a refinement control changes, with NO new
 *    fetch — that's what lets `FindJobsPanel` re-rank live without breaking
 *    responsibility 1's invariant. Scoped to exactly the controls #568
 *    wires (role families, target level, exclude terms, comp floor,
 *    location); a titles/skills edit still requires a fresh Search, since
 *    `matchesQuery` already ran against the OLD titles/skills when the
 *    snapshot was taken.
 */

import { useEffect, useRef, useState } from "react";
import type { HeuristicParsedResume } from "../lib/heuristics/types.ts";
import type { JobQuery } from "../lib/job-search/query-builder.ts";
import type { JobPosting } from "../lib/job-search/types.ts";
import type { CompanyEntry } from "../lib/job-search/company-registry.ts";
import { refineSearchResult } from "../lib/job-search/refine.ts";
import type { SearchPhase } from "../components/features/JobSearchResults.tsx";

interface RawFetchSnapshot {
  raw: JobPosting[];
  degradedProviders: string[];
  providerCount: number;
}

export function useJobSearch(
  query: JobQuery,
  parsed: HeuristicParsedResume,
  selectedCompanies: readonly CompanyEntry[],
) {
  const [phase, setPhase] = useState<SearchPhase>({ kind: "idle" });
  const abortRef = useRef<AbortController | null>(null);
  // Snapshot of the last fetch's raw (deduped, matchesQuery-filtered but not
  // yet role/exclude-filtered or ranked) postings — kept OUTSIDE `phase` so
  // the re-rank effect below doesn't feed back into its own trigger.
  // `undefined` until the first successful search; the effect is a no-op
  // until then.
  const rawFetchRef = useRef<RawFetchSnapshot | undefined>(undefined);

  // Abort any in-flight search on unmount so a late response can't try to
  // update state on an unmounted component.
  useEffect(() => () => abortRef.current?.abort(), []);

  const runSearch = () => {
    // Supersede any in-flight search so its results can't land after this one.
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setPhase({ kind: "loading" });
    void (async () => {
      try {
        const { searchJobs } = await import("../lib/job-search/search.ts");
        const result = await searchJobs(query, parsed, ctrl.signal, selectedCompanies);
        if (ctrl.signal.aborted) return;
        rawFetchRef.current = {
          raw: result.rawPostings,
          degradedProviders: result.degradedProviders,
          providerCount: result.providerCount,
        };
        setPhase({ kind: "loaded", result });
      } catch {
        if (ctrl.signal.aborted) return;
        setPhase({ kind: "failed" });
      }
    })();
  };

  useEffect(() => {
    const snapshot = rawFetchRef.current;
    if (!snapshot) return;
    let cancelled = false;
    void (async () => {
      const result = await refineSearchResult(
        snapshot.raw,
        parsed,
        query,
        snapshot.degradedProviders,
        snapshot.providerCount,
      );
      if (!cancelled) setPhase({ kind: "loaded", result });
    })();
    return () => {
      cancelled = true;
    };
    // `exhaustive-deps` is NOT lint-enforced here (no react-hooks plugin) —
    // this array is deliberately scoped to the five refinement knobs #568
    // wires, not titles/skills (see the file docblock) and not `parsed`
    // (stable per panel mount — the résumé isn't edited from here).
  }, [query.families, query.excludeTerms, query.seniority, query.compFloor, query.location]);

  return { phase, runSearch, isLoading: phase.kind === "loading" };
}
