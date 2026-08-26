// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Which companies the next job search targets (#533).
 *
 * Owns the sector guess and the user's add/remove edits over the registry's
 * suggestions, so `FindJobsPanel` stays a layout shell and `CompanyTargets`
 * stays a renderer. Selection state lives here rather than in either because
 * both need it: the panel passes `selected` to `searchJobs`, the component
 * toggles it.
 *
 * THREE DELIBERATE CHOICES:
 *
 * 1. HEURISTIC CLASSIFIER, NOT `classifySector`. `sector.ts` also exports the
 *    semantic `classifySector`, which loads a WebLLM model when WebGPU is
 *    present. Calling it here would kick off a multi-hundred-MB model download
 *    as a side effect of the panel merely rendering — a cost the user never
 *    asked for, on a surface whose whole value is being instant. The heuristic
 *    is synchronous, free, and supplies the same `runnerUp` the "not right?"
 *    affordance needs. Upgrading to the semantic guess belongs behind an
 *    explicit user action, not a mount.
 *
 * 2. SEEDED ONCE, ON MOUNT. `parsed` is a fresh object on many parent renders,
 *    so keying the effect on it would re-classify (and stomp the user's chip
 *    edits) on unrelated re-renders. This mirrors how the panel already seeds
 *    its `JobQuery` — "local scratch state seeded once from the parse".
 *    NOTE: `exhaustive-deps` is NOT enabled in this repo, so nothing would
 *    have flagged the alternative; the empty dep array is a decision, not an
 *    oversight. Since #864, the seed source itself branches on mount: the
 *    persisted watchlist (`watched-companies.ts`) wins over the sector guess
 *    when it is non-empty — see choice 3 below — but which source wins is
 *    still decided exactly once, at mount, for the same reason.
 *
 * 3. A PER-CHIP PIN, NOT THE SEARCH-SELECTION TOGGLE, IS THE SAVE AFFORDANCE
 *    (#864). Toggling a chip for THIS search (`toggle`/`isSelected`) and
 *    saving a company to the PERSISTED shortlist (`toggleWatched`/`isWatched`)
 *    are two different user intents and stay two different controls. A
 *    "save current selection" button was the other option considered and was
 *    rejected: it would silently DISCARD any previously pinned company that
 *    isn't in this session's sector-suggested pool (a user who pinned
 *    companies across two different sector guesses over two visits would have
 *    one visit's save button erase the other's picks). A per-chip pin has no
 *    such collision — pinning and unpinning compose one company at a time,
 *    regardless of which sector guess is currently on screen.
 *
 * The registry and the sector taxonomy are dynamic-imported (the cascade-tier
 * pattern) so neither reaches the entry chunk — the panel renders before they
 * resolve, which is what `ready` is for.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { HeuristicParsedResume } from "../lib/heuristics/types.ts";
import type { CompanyEntry } from "../lib/job-search/company-registry.ts";
import type { Sector } from "../lib/job-search/sector.ts";
import type { WatchedCompany } from "../lib/job-search/watched-companies.ts";

/** Signatures of the dynamically-imported save/remove functions, without a
 *  static import — the module itself is lazy-loaded (see the mount effect
 *  below), and `typeof import(...)` names its exports' types with no runtime
 *  cost. */
type WatchedCompaniesApi = {
  save: typeof import("../lib/job-search/watched-companies.ts").saveWatchedCompany;
  remove: typeof import("../lib/job-search/watched-companies.ts").removeWatchedCompany;
};

/**
 * The watchlist half of the mount seed, isolated from the sector half.
 *
 * A storage failure — IndexedDB blocked by private browsing, a content
 * blocker, or corporate policy, so `openDB()` throws — must cost ONLY the
 * watchlist. The sector heuristic and the company registry have no storage
 * dependency and worked regardless before #864; sharing one try block with
 * this read would let a blocked `openDB()` blank `sector`/`suggested` too and
 * degrade a working surface to the keyless-only search.
 *
 * The two failure modes are kept apart on purpose. A failed MODULE LOAD leaves
 * no api to call, so `toggleWatched` becomes a no-op. A failed READ still
 * hands back the api, so pinning saves and unpinning removes for the rest of
 * the session — the shortlist just didn't seed. Both answer with the same
 * empty list an untouched store gives, so the seeding path downstream cannot
 * tell "no storage" from "nothing saved yet", which is exactly right.
 */
async function loadWatchlist(): Promise<{
  api: WatchedCompaniesApi | null;
  watched: WatchedCompany[];
}> {
  let module: typeof import("../lib/job-search/watched-companies.ts");
  try {
    module = await import("../lib/job-search/watched-companies.ts");
  } catch {
    return { api: null, watched: [] };
  }
  const api = {
    save: module.saveWatchedCompany,
    remove: module.removeWatchedCompany,
  };
  try {
    return { api, watched: await module.getWatchedCompanies() };
  } catch {
    return { api, watched: [] };
  }
}

/**
 * How many companies a sector suggests (#542). Together with
 * `DEFAULT_PER_COMPANY_CAP` (8 by default, `role-keywords.ts`) this bounds the
 * company-board half of a search at 14 * 8 = 112 postings before ranking —
 * a real sample without a firehose, and comfortably under the ~120 ceiling
 * this pairing has always targeted. It is also the width of the board
 * fan-out, which the concurrency limiter then meters.
 *
 * 14 was picked because it is the largest per-sector count the curated
 * registry actually has (`fintech` and `devtools`, 14 entries each as of
 * #542) — raising the cap further would not surface any more companies for
 * ANY sector today, only widen a ceiling nothing fills. Several sectors still
 * bottom out well below 14 (`gaming`, `hardware-iot`, `logistics-mobility`,
 * `government-defense` at 6; `ecommerce`, `media-adtech` at 7) — that is a
 * registry-content gap, not a cap problem, and is explicit follow-up (#542
 * part (a): growing the registry with existence-audited companies).
 */
export const COMPANY_LIMIT = 14;

/** Stable identity for a registry entry. `slug` alone collides across vendors. */
export function companyKey(entry: CompanyEntry): string {
  return `${entry.ats}:${entry.slug}`;
}

/** Same identity as {@link companyKey}, read off a `WatchedCompany` — kept
 *  separate rather than routing a `WatchedCompany` through `companyKey`
 *  itself, since the two types diverge (a watched company has no `sectors`). */
function watchedCompanyToKey(entry: WatchedCompany): string {
  return `${entry.ats}:${entry.slug}`;
}

/** A watched company, reshaped as the `CompanyEntry` `suggested`/`selected`
 *  expect. `sectors: []` is a placeholder: nothing downstream of `suggested`/
 *  `selected` reads a `CompanyEntry`'s `sectors` field (verified via grep —
 *  the only reader is `companiesForSector` itself, which never sees a
 *  watched-derived entry), so an empty array costs nothing. */
function toCompanyEntry(entry: WatchedCompany): CompanyEntry {
  return { name: entry.displayName, ats: entry.ats, slug: entry.slug, sectors: [] };
}

/** Add/remove one key from a selection set, returning a new set. */
export function toggleKey(
  keys: ReadonlySet<string>,
  key: string,
): ReadonlySet<string> {
  const next = new Set(keys);
  if (!next.delete(key)) next.add(key);
  return next;
}

export interface CompanyTargets {
  /** False until the lazy registry/taxonomy chunks resolve (or fail). */
  ready: boolean;
  /** The classified sector, or null before `ready`. */
  sector: Sector | null;
  /** Second-best sector, when the classifier found one — powers the switch. */
  runnerUp: Sector | null;
  /** Every company the sector suggests, in registry order. */
  suggested: CompanyEntry[];
  /** The subset that will actually be searched, in `suggested` order. */
  selected: CompanyEntry[];
  isSelected(entry: CompanyEntry): boolean;
  toggle(entry: CompanyEntry): void;
  /** Re-suggest against `runnerUp`; no-op when there isn't one. */
  switchToRunnerUp(): void;
  /** True once this entry is on the persisted shortlist (independent of
   *  `isSelected` — see the hook's docblock, third deliberate choice). */
  isWatched(entry: CompanyEntry): boolean;
  /** Pin/unpin `entry` on the persisted shortlist. Does NOT change
   *  `isSelected`/`selected` for the current search. */
  toggleWatched(entry: CompanyEntry): void;
}

export function useCompanyTargets(parsed: HeuristicParsedResume): CompanyTargets {
  const [ready, setReady] = useState(false);
  const [sector, setSector] = useState<Sector | null>(null);
  const [runnerUp, setRunnerUp] = useState<Sector | null>(null);
  const [suggested, setSuggested] = useState<CompanyEntry[]>([]);
  const [keys, setKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [watchedKeys, setWatchedKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  // The lazily-imported registry lookup, kept so `switchToRunnerUp` can
  // re-query without a second dynamic import round-trip.
  const lookupRef = useRef<
    ((sector: Sector, limit: number) => CompanyEntry[]) | null
  >(null);
  const parsedRef = useRef(parsed);
  parsedRef.current = parsed;
  // The lazily-imported save/remove functions, kept so `toggleWatched` can
  // call them without a second dynamic import round-trip.
  const watchedApiRef = useRef<WatchedCompaniesApi | null>(null);
  // Mirrors `watchedKeys` so `toggleWatched` reads current state without a
  // stale closure — the same reason `parsedRef` mirrors `parsed`.
  const watchedKeysRef = useRef(watchedKeys);
  watchedKeysRef.current = watchedKeys;

  // Mount-only on purpose — see the docblock.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [
          { classifySectorHeuristic },
          { companiesForSector },
          watchlist,
        ] = await Promise.all([
          import("../lib/job-search/sector.ts"),
          import("../lib/job-search/company-registry.ts"),
          // Resolves rather than rejects on a storage failure, so a blocked
          // IndexedDB cannot take the two imports beside it down with it.
          loadWatchlist(),
        ]);
        if (cancelled) return;
        const guess = classifySectorHeuristic(parsedRef.current);
        const watched = watchlist.watched;

        // Every setter below fires together, after every await has settled —
        // a throw partway through (a chunk that never loads) must not leave
        // `sector` set while `suggested`/`keys` stay empty.
        watchedApiRef.current = watchlist.api;
        lookupRef.current = companiesForSector;
        setSector(guess.sector);
        setRunnerUp(guess.runnerUp ?? null);
        setWatchedKeys(new Set(watched.map(watchedCompanyToKey)));

        // A saved shortlist wins over the sector guess — see choice 2/3 in
        // the docblock. `sector`/`runnerUp` above are set regardless, for
        // the header text and the "try other sector" affordance; only the
        // POOL a fresh mount shows changes source.
        // Capped and ordered most-recently-pinned-first, same as the sector
        // branch caps at COMPANY_LIMIT — the watchlist otherwise grows past it
        // across visits/sectors with nothing to bound the board fan-out (#897
        // review). A bare slice would drop pins in storage-insertion order,
        // which has no relationship to what the user pinned most recently.
        const pool =
          watched.length > 0
            ? [...watched]
                .sort((a, b) => b.addedAt - a.addedAt)
                .slice(0, COMPANY_LIMIT)
                .map(toCompanyEntry)
            : companiesForSector(guess.sector, COMPANY_LIMIT);
        setSuggested(pool);
        setKeys(new Set(pool.map(companyKey)));
      } catch {
        // The sector/registry chunk failed to load (offline first-load) —
        // `loadWatchlist` never reaches here, by construction. Company
        // targeting is additive: leaving `suggested` empty degrades to the
        // keyless-only search rather than breaking the panel.
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const toggle = useCallback((entry: CompanyEntry) => {
    setKeys((current) => toggleKey(current, companyKey(entry)));
  }, []);

  const toggleWatched = useCallback((entry: CompanyEntry) => {
    const key = companyKey(entry);
    const wasWatched = watchedKeysRef.current.has(key);
    setWatchedKeys((current) => toggleKey(current, key));
    const api = watchedApiRef.current;
    if (!api) return;
    // Swallowed for the same reason `loadWatchlist` swallows the read: on a
    // profile where storage is blocked the write rejects on every pin, and an
    // unhandled rejection per click is the only thing that would come of
    // propagating it. The optimistic state above still shows the pin for this
    // session; nothing is silently lost that storage could have kept.
    void (wasWatched
      ? api.remove(entry.ats, entry.slug)
      : api.save(entry)
    ).catch(() => {});
  }, []);

  const switchToRunnerUp = useCallback(() => {
    const lookup = lookupRef.current;
    if (!lookup || !runnerUp) return;
    const pool = lookup(runnerUp, COMPANY_LIMIT);
    setSuggested(pool);
    setKeys(new Set(pool.map(companyKey)));
    // Swap the pair rather than clearing the runner-up, so the affordance is
    // reversible — one more click returns to the original guess.
    setSector(runnerUp);
    setRunnerUp(sector);
  }, [sector, runnerUp]);

  const selected = suggested.filter((entry) => keys.has(companyKey(entry)));

  return {
    ready,
    sector,
    runnerUp,
    suggested,
    selected,
    isSelected: (entry) => keys.has(companyKey(entry)),
    toggle,
    switchToRunnerUp,
    isWatched: (entry) => watchedKeys.has(companyKey(entry)),
    toggleWatched,
  };
}
