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
 * TWO DELIBERATE CHOICES:
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
 *    oversight.
 *
 * The registry and the sector taxonomy are dynamic-imported (the cascade-tier
 * pattern) so neither reaches the entry chunk — the panel renders before they
 * resolve, which is what `ready` is for.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { HeuristicParsedResume } from "../lib/heuristics/types.ts";
import type { CompanyEntry } from "../lib/job-search/company-registry.ts";
import type { Sector } from "../lib/job-search/sector.ts";

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
}

export function useCompanyTargets(parsed: HeuristicParsedResume): CompanyTargets {
  const [ready, setReady] = useState(false);
  const [sector, setSector] = useState<Sector | null>(null);
  const [runnerUp, setRunnerUp] = useState<Sector | null>(null);
  const [suggested, setSuggested] = useState<CompanyEntry[]>([]);
  const [keys, setKeys] = useState<ReadonlySet<string>>(() => new Set());

  // The lazily-imported registry lookup, kept so `switchToRunnerUp` can
  // re-query without a second dynamic import round-trip.
  const lookupRef = useRef<
    ((sector: Sector, limit: number) => CompanyEntry[]) | null
  >(null);
  const parsedRef = useRef(parsed);
  parsedRef.current = parsed;

  // Mount-only on purpose — see the docblock.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [{ classifySectorHeuristic }, { companiesForSector }] =
          await Promise.all([
            import("../lib/job-search/sector.ts"),
            import("../lib/job-search/company-registry.ts"),
          ]);
        if (cancelled) return;
        const guess = classifySectorHeuristic(parsedRef.current);
        const pool = companiesForSector(guess.sector, COMPANY_LIMIT);
        lookupRef.current = companiesForSector;
        setSector(guess.sector);
        setRunnerUp(guess.runnerUp ?? null);
        setSuggested(pool);
        setKeys(new Set(pool.map(companyKey)));
      } catch {
        // Chunk failed to load (offline first-load). Company targeting is
        // additive: leaving `suggested` empty degrades to the keyless-only
        // search rather than breaking the panel.
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
  };
}
