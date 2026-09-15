// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Owns the Find Jobs fetch lifecycle AND the #568 live re-rank, so
 * `FindJobsPanel` stays a layout shell. Cross-cutting interaction state per
 * CLAUDE.md's "hooks own modals/drop zones/locks" rule — this is the same
 * shape (a fetch + a derived recompute), just for the search panel.
 *
 * THREE responsibilities, one hook, because they share state a split would
 * have to duplicate (the abort controller, the raw-postings snapshot):
 *
 * 1. `runSearch` — the full fan-out. Never fires on mount, drop, tab open, or a
 *    query edit — only an explicit caller invocation (the panel's Search
 *    button). `searchJobs` dynamic-imports the provider/rank tiers, so nothing
 *    job-fetch-related sits in the entry chunk.
 * 2. The live re-rank effect (#568) — re-runs `refineSearchResult` (the SAME
 *    role/exclude filter + rank pipeline `searchJobs` used) over the last
 *    fetch's raw postings whenever a refinement control changes, with NO new
 *    fetch — that's what lets `FindJobsPanel` re-rank live without breaking
 *    responsibility 1's invariant. Scoped to exactly the controls #568
 *    wires (role families, target level, exclude terms, comp floor,
 *    location) plus #809's local-only toggle; a titles/skills edit still
 *    requires a fresh Search, since
 *    `matchesQuery` already ran against the OLD titles/skills when the
 *    snapshot was taken.
 * 3. The company selection, which is deliberately ASYMMETRIC because the two
 *    directions are not the same kind of operation:
 *
 *     - **Deselecting** is local set arithmetic over the snapshot
 *       (`dropCompanyPostings`) and re-ranks live, no fetch, no button. Making
 *       the user click Search to remove rows we can already identify would be
 *       asking them to pay for nothing.
 *     - **Selecting** a company that wasn't in the last fetch cannot be served
 *       locally — the snapshot contains none of its postings. Rather than
 *       silently refetching (the panel promises keywords leave "only when you
 *       click Search", and a checkbox is not that click), the addition is
 *       reported as `pendingCompanies` for the UI to offer, and
 *       `searchPendingCompanies` fetches JUST those boards and merges them in.
 *       One board, usually an IndexedDB cache hit — not the whole fan-out.
 *
 *    `fetchedCompanyKeys` is state, not a ref, precisely because the pending
 *    count is rendered.
 */

import { useEffect, useRef, useState } from "react";
import type { HeuristicParsedResume } from "../lib/heuristics/types.ts";
import type { JobQuery } from "../lib/job-search/query-builder.ts";
import type { JobPosting } from "../lib/job-search/types.ts";
import type { CompanyEntry } from "../lib/job-search/company-registry.ts";
import { refineSearchResult } from "../lib/job-search/refine.ts";
import {
  dropCompanyPostings,
  mergeRawPostings,
} from "../lib/job-search/raw-postings.ts";
import { companyKey } from "./useCompanyTargets.ts";
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
  /**
   * A SEARCH came back (#826). Fired from `runSearch`'s success alone — not
   * from the company merge or either local re-rank, which also land on
   * `loaded` but are refinements of a search the user already ran. The one
   * consumer records the journey's `Match jobs` stage, and "you searched"
   * happens once per search, not once per re-rank.
   */
  onSearchLoaded?: () => void,
) {
  const [phase, setPhase] = useState<SearchPhase>({ kind: "idle" });
  const [isUpdating, setIsUpdating] = useState(false);
  /** Company keys whose boards are IN the current snapshot. */
  const [fetchedCompanyKeys, setFetchedCompanyKeys] = useState<readonly string[]>(
    [],
  );
  const abortRef = useRef<AbortController | null>(null);
  // Snapshot of the last fetch's raw (deduped, matchesQuery-filtered but not
  // yet role/exclude-filtered or ranked) postings — kept OUTSIDE `phase` so
  // the re-rank effect below doesn't feed back into its own trigger.
  // `undefined` until the first successful search; the effects are a no-op
  // until then.
  const rawFetchRef = useRef<RawFetchSnapshot | undefined>(undefined);
  // Latest query/parsed for the deselect effect, which is keyed on the company
  // selection alone and would otherwise re-rank against a stale query.
  const queryRef = useRef(query);
  queryRef.current = query;
  const parsedRef = useRef(parsed);
  parsedRef.current = parsed;

  // Abort any in-flight search on unmount so a late response can't try to
  // update state on an unmounted component.
  useEffect(() => () => abortRef.current?.abort(), []);

  const runSearch = () => {
    // Supersede any in-flight search so its results can't land after this one.
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setPhase({ kind: "loading" });
    setIsUpdating(false);
    const companyKeys = selectedCompanies.map(companyKey);
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
        setFetchedCompanyKeys(companyKeys);
        setPhase({ kind: "loaded", result });
        // `runSearch` is re-created every render, so this closure always holds
        // the current callback — no ref needed, unlike the listener-based hooks.
        onSearchLoaded?.();
      } catch {
        if (ctrl.signal.aborted) return;
        setPhase({ kind: "failed" });
      }
    })();
  };

  /** Selected companies whose boards are NOT in the snapshot yet. */
  const pendingCompanies = selectedCompanies.filter(
    (entry) => !fetchedCompanyKeys.includes(companyKey(entry)),
  );

  /**
   * Fetch only `pendingCompanies` and merge them into the snapshot. Keeps the
   * current results on screen while it runs (`isUpdating`) rather than dropping
   * to the loading skeleton — this adds to a result set the user is reading, so
   * blanking it would be a bigger interruption than the wait.
   */
  const searchPendingCompanies = () => {
    const snapshot = rawFetchRef.current;
    if (!snapshot || pendingCompanies.length === 0) return;
    const additions = pendingCompanies;
    const addedKeys = additions.map(companyKey);
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setIsUpdating(true);
    void (async () => {
      try {
        const { searchCompanyBoards } = await import("../lib/job-search/search.ts");
        const added = await searchCompanyBoards(
          queryRef.current,
          parsedRef.current,
          ctrl.signal,
          additions,
        );
        if (ctrl.signal.aborted) return;
        const next: RawFetchSnapshot = {
          raw: mergeRawPostings(snapshot.raw, added.postings),
          degradedProviders: [
            ...snapshot.degradedProviders,
            ...added.degradedProviders,
          ],
          providerCount: snapshot.providerCount + added.providerCount,
        };
        rawFetchRef.current = next;
        // Recorded even for a board that failed: the user asked for it and we
        // tried, so it must leave the pending list — otherwise the "not searched
        // yet" prompt reappears forever on a board that will keep failing. The
        // failure is already visible in the degraded-providers notice.
        setFetchedCompanyKeys((current) => [...current, ...addedKeys]);
        const result = await refineSearchResult(
          next.raw,
          parsedRef.current,
          queryRef.current,
          next.degradedProviders,
          next.providerCount,
        );
        if (ctrl.signal.aborted) return;
        setPhase({ kind: "loaded", result });
      } catch {
        // The incremental fetch is additive: on failure the existing results
        // stay exactly as they were, which is strictly better than replacing a
        // readable list with an error state.
      } finally {
        if (!ctrl.signal.aborted) setIsUpdating(false);
      }
    })();
  };

  // Deselection → drop that company's postings and re-rank locally. Keyed on a
  // joined key list rather than the array (a new array identity every render).
  // Additions are NOT handled here on purpose — they need a fetch, which is
  // `searchPendingCompanies`'s job.
  const selectedKeyList = selectedCompanies.map(companyKey).join("\u0000");
  useEffect(() => {
    const snapshot = rawFetchRef.current;
    if (!snapshot) return;
    const selected = new Set(
      selectedKeyList === "" ? [] : selectedKeyList.split("\u0000"),
    );
    const removed = fetchedCompanyKeys.filter((key) => !selected.has(key));
    if (removed.length === 0) return;
    // `providerCount` and `degradedProviders` are left alone: they are the
    // denominator and labels of what was ATTEMPTED, and a removed board was
    // still attempted. Shrinking the denominator here could flip a partially
    // degraded search into the "every provider failed" hard error.
    const next: RawFetchSnapshot = {
      ...snapshot,
      raw: dropCompanyPostings(snapshot.raw, removed),
    };
    rawFetchRef.current = next;
    setFetchedCompanyKeys((current) =>
      current.filter((key) => selected.has(key)),
    );
    let cancelled = false;
    void (async () => {
      const result = await refineSearchResult(
        next.raw,
        parsedRef.current,
        queryRef.current,
        next.degradedProviders,
        next.providerCount,
      );
      if (!cancelled) setPhase({ kind: "loaded", result });
    })();
    return () => {
      cancelled = true;
    };
    // `exhaustive-deps` is NOT lint-enforced here (no react-hooks plugin).
    // Deliberately keyed on the selection only: `fetchedCompanyKeys` is read,
    // not watched — this effect is the only thing that shrinks it, so adding it
    // would re-fire the effect on its own write for no new work.
  }, [selectedKeyList]);

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
    // #809 adds `locationOnly` — a HARD filter rather than an axis, but the
    // same class of knob: it changes `refineSearchResult`'s output over an
    // unchanged snapshot, so it re-ranks live with no fetch like the other five.
  }, [
    query.families,
    query.excludeTerms,
    query.seniority,
    query.compFloor,
    query.location,
    query.locationOnly,
  ]);

  return {
    phase,
    runSearch,
    isLoading: phase.kind === "loading",
    /** Selected companies not yet represented in the results, if any. */
    pendingCompanies,
    searchPendingCompanies,
    /** True while an incremental company fetch is in flight. */
    isUpdating,
  };
}
