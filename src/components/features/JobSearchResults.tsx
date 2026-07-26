// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * JobSearchResults — the Results region of the Find Jobs panel (#319).
 *
 * Presentational: renders the five result states from the UX spec §2
 * (loading / results / degraded / empty / error) off a phase computed by
 * FindJobsPanel, which owns the fetch + abort. Split out to keep FindJobsPanel
 * under the ~200 LOC gate.
 *
 * The whole region is `aria-live="polite"` so a screen reader hears
 * "N jobs found" / "search failed" without stealing focus.
 *
 * Paging (not capping): `searchJobs` already returns the FULL ranked set, so
 * the old `RENDER_CAP` slice discarded results the user had already paid the
 * fetch for and told them to narrow the query instead — the wrong instruction,
 * since narrowing cannot surface match #21. The list is cut into pages of
 * `PAGE_SIZE` and every match is reachable. Nothing here fetches, so a page
 * change is pure render work.
 *
 * The page resets whenever the identity of the result set changes (a fresh
 * Search, or #568's live re-rank), otherwise page 3 of an old 80-match set
 * would silently show page 3 of a new 25-match one — or nothing at all.
 */

import { useEffect, useRef, useState } from "react";
import { Button, ErrorState, Pagination, StatusBadge } from "@design-system";
import { JobResultCard } from "./JobResultCard.tsx";
import { WeakMatchesSection } from "./WeakMatchesSection.tsx";
import { isWeakMatch } from "./weakMatchThreshold.ts";
import type { JobSearchResult } from "../../lib/job-search/search.ts";

/** Cards per page. Matches the pre-paging render cap, so a first screenful of
 *  results is unchanged — what changed is that page 2 now exists. */
const PAGE_SIZE = 20;

export type SearchPhase =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "loaded"; result: JobSearchResult }
  | { kind: "failed" };

const SAMPLE_LABEL =
  "These come from a few free, keyless job feeds that skew remote and tech — " +
  "a sample, not every job. Use the external board links in the search details " +
  "for broader coverage.";

export function JobSearchResults({
  phase,
  onRetry,
}: {
  phase: SearchPhase;
  onRetry: () => void;
}) {
  return (
    <div aria-live="polite" className="flex flex-col gap-3 empty:hidden">
      {phase.kind === "loading" && <LoadingState />}
      {phase.kind === "failed" && <HardError onRetry={onRetry} />}
      {phase.kind === "loaded" && <Loaded result={phase.result} onRetry={onRetry} />}
    </div>
  );
}

function LoadingState() {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-content-tertiary">
        Searching remote/tech boards…
      </p>
      <div className="flex flex-col gap-2">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="h-16 rounded-lg border border-border-light bg-surface-subtle motion-safe:animate-pulse"
          />
        ))}
      </div>
    </div>
  );
}

function HardError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex flex-col items-start gap-2">
      <ErrorState tone="error">
        Couldn&apos;t reach any of the job feeds. This is usually a transient
        network hiccup — try again in a moment.
      </ErrorState>
      <Button variant="ghost" size="sm" onClick={onRetry}>
        Retry search
      </Button>
    </div>
  );
}

function Loaded({
  result,
  onRetry,
}: {
  result: JobSearchResult;
  onRetry: () => void;
}) {
  const { jobs, degradedProviders, providerCount, excludeSuppressed, roleSuppressed } = result;
  const [page, setPage] = useState(1);
  // Anchor for the scroll-to-top on a page change. A numbered jump replaces the
  // whole list under a scroll position that was meaningful for the old page, so
  // without this the user lands mid-page-4 with no idea the content moved.
  const topRef = useRef<HTMLDivElement | null>(null);
  const jumpedRef = useRef(false);

  // A new result set (fresh fetch or live re-rank) invalidates the page index.
  // Keyed on the array identity — `refineSearchResult` returns a new array on
  // every re-rank, which is exactly when the ordering changed.
  useEffect(() => {
    setPage(1);
  }, [jobs]);

  // Scroll only for a user-driven page change, never for the reset above or the
  // first render — yanking the viewport on a fresh Search would fight the
  // user's own scroll into the results.
  useEffect(() => {
    if (!jumpedRef.current) return;
    jumpedRef.current = false;
    // Optional call: jsdom (and any non-browser host) does not implement
    // scrollIntoView, and a page change must not throw in a test.
    topRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" });
  }, [page]);

  const goToPage = (next: number) => {
    jumpedRef.current = true;
    setPage(next);
  };

  // Every provider rejected → hard error (with retry). Guarded on a non-zero
  // provider count so an empty registry (possible once #320 makes the set
  // variable) reads as "no matches", not a network failure.
  if (providerCount > 0 && degradedProviders.length === providerCount) {
    return <HardError onRetry={onRetry} />;
  }

  // Some providers succeeded but nothing matched.
  if (jobs.length === 0) {
    return (
      <ErrorState tone="warning">
        No matching postings on the feeds we can search. Open Edit search to
        broaden the query, or try the external board links.
      </ErrorState>
    );
  }

  const pageCount = Math.ceil(jobs.length / PAGE_SIZE);
  // Clamp rather than trust `page`: the reset effect above runs AFTER this
  // render when the result set shrinks, so for one commit `page` can point past
  // the end and an unclamped slice would render an empty results region.
  const current = Math.min(page, pageCount);
  const start = (current - 1) * PAGE_SIZE;
  const shown = jobs.slice(start, start + PAGE_SIZE);
  // Split WITHIN the page, not across the ranking — #561's star rating is the
  // only fit number, this just partitions the already-ranked page on it.
  // Never-empty-by-construction (issue 567): if every posting on this page is
  // weak, the strong list renders nothing, so the weak section is auto-expanded
  // instead of leaving the page looking result-free behind a click.
  const strong = shown.filter((job) => !isWeakMatch(job.rating));
  const weak = shown.filter((job) => isWeakMatch(job.rating));
  return (
    <div className="flex flex-col gap-3">
      <div ref={topRef} className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge tone="info">sample</StatusBadge>
          <span className="text-sm text-content-tertiary">
            {jobs.length} match{jobs.length === 1 ? "" : "es"} ranked by fit
          </span>
        </div>
        <p className="max-w-prose text-sm text-content-tertiary">{SAMPLE_LABEL}</p>
        {degradedProviders.length > 0 && (
          <p className="text-sm text-content-tertiary">
            Couldn&apos;t reach {degradedProviders.join(", ")} — showing results
            from the other feeds.
          </p>
        )}
        {excludeSuppressed && (
          <p className="text-sm text-content-tertiary">
            Your exclude terms would have removed every match, so we skipped
            them for this search — open Edit search to remove or narrow a term
            and apply exclusion again.
          </p>
        )}
        {roleSuppressed && (
          <p className="text-sm text-content-tertiary">
            Role filter skipped — it would have hidden every result, so we kept
            them all for this search. Open Edit search to adjust the Role chips
            and apply role filtering again.
          </p>
        )}
      </div>

      {strong.length > 0 && (
        <div className="flex flex-col gap-2">
          {strong.map((job) => (
            <JobResultCard key={job.posting.id} job={job} />
          ))}
        </div>
      )}

      <WeakMatchesSection jobs={weak} defaultOpen={strong.length === 0} />

      {pageCount > 1 && (
        <div className="flex flex-col gap-2 border-t border-border-light pt-3">
          <p className="text-sm text-content-muted">
            Showing {start + 1}–{Math.min(start + PAGE_SIZE, jobs.length)} of{" "}
            {jobs.length} matches, ranked by fit.
          </p>
          <Pagination
            page={current}
            pageCount={pageCount}
            onPageChange={goToPage}
            label="Job matches"
          />
        </div>
      )}
    </div>
  );
}
