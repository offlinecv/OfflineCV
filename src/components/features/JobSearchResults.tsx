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
 */

import { Button, ErrorState, StatusBadge } from "@design-system";
import { JobResultCard } from "./JobResultCard.tsx";
import type { JobSearchResult } from "../../lib/job-search/search.ts";

/** Cap on rendered cards — the sample is a taster, not a firehose (spec §4). */
const RENDER_CAP = 20;

export type SearchPhase =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "loaded"; result: JobSearchResult }
  | { kind: "failed" };

const SAMPLE_LABEL =
  "These come from a few free, keyless job feeds that skew remote and tech — " +
  "a sample, not every job. Use the external board links above for broader coverage.";

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
      <p className="text-xs text-content-tertiary">
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
  const { jobs, degradedProviders, providerCount } = result;

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
        No matching postings on the feeds we can search. Broaden the query above
        or try the external board links.
      </ErrorState>
    );
  }

  const shown = jobs.slice(0, RENDER_CAP);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge tone="info">sample</StatusBadge>
          <span className="text-xs text-content-tertiary">
            {jobs.length} match{jobs.length === 1 ? "" : "es"} ranked by fit
          </span>
        </div>
        <p className="max-w-prose text-xs text-content-tertiary">{SAMPLE_LABEL}</p>
        {degradedProviders.length > 0 && (
          <p className="text-xs text-content-tertiary">
            Couldn&apos;t reach {degradedProviders.join(", ")} — showing results
            from the other feeds.
          </p>
        )}
      </div>

      <div className="flex flex-col gap-2">
        {shown.map((job) => (
          <JobResultCard key={job.posting.id} job={job} />
        ))}
      </div>

      {jobs.length > RENDER_CAP && (
        <p className="text-xs text-content-muted">
          Showing the top {RENDER_CAP} of {jobs.length} matches. Narrow the query
          above for a tighter set.
        </p>
      )}
    </div>
  );
}
