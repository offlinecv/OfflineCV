// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * WeakMatchesSection — the collapsed tail of below-threshold postings
 * beneath the strong results in `JobSearchResults.tsx` (issue 567).
 *
 * Split out to keep `JobSearchResults.tsx` under the ~200 LOC gate (mirrors
 * `JobResultCard.tsx`'s split off `FindJobsPanel.tsx`). Reuses the same
 * expand/collapse idiom `JobResultCard` already uses for "View match
 * detail" — a `<Button>` toggling local `open` state — rather than adding a
 * new disclosure primitive to the design system for one callsite.
 *
 * Never hard-drops a posting: every job passed in still renders, just
 * behind the toggle. `defaultOpen` lets the caller auto-expand when there
 * are zero strong matches, so an all-weak result set is never
 * empty-by-construction (see `JobSearchResults.tsx`).
 */

import { useState } from "react";
import { Button } from "@design-system";
import { JobResultCard } from "./JobResultCard.tsx";
import type { RankedJob } from "../../lib/job-search/rank.ts";
import { WEAK_MATCH_LABEL } from "./weakMatchThreshold.ts";

export function WeakMatchesSection({
  jobs,
  defaultOpen = false,
  onTailor,
}: {
  jobs: RankedJob[];
  defaultOpen?: boolean;
  /** Passes through to each card's tailor affordance (#576). */
  onTailor?: (jdContext: string) => void;
}) {
  const [open, setOpen] = useState(defaultOpen);

  if (jobs.length === 0) return null;

  return (
    <div className="flex flex-col gap-2 border-t border-border-light pt-3">
      <Button
        variant="ghost"
        size="sm"
        aria-expanded={open}
        className="self-start"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? "Hide" : "Show"} weak matches ({jobs.length}) — {WEAK_MATCH_LABEL}
      </Button>
      {open && (
        <div className="flex flex-col gap-2">
          {jobs.map((job) => (
            <JobResultCard key={job.posting.id} job={job} onTailor={onTailor} />
          ))}
        </div>
      )}
    </div>
  );
}
