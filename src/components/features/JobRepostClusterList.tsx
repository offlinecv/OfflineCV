// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * JobRepostClusterList — one line per role a company keeps re-listing (#754),
 * collapsed by default, over one bulk action.
 *
 * The affordance this replaces is the point of it. Six saved rows for one role
 * spread over 49 days used to render 30 **Merge into this one** buttons, each
 * one a destructive action that would have collapsed the churn into a single
 * record. This says the true thing instead — *reposted 6×, 49 days* — once per
 * cluster.
 *
 * ## Collapsed by default, and why that is not hiding it
 *
 * At 28 clusters the list was a full page of scroll standing between the user
 * and the pipeline it sits above — the same failure `JobTrackerStatusGroup`
 * exists to prevent one section down, so this borrows its shape: a `<Button>`
 * with `aria-expanded` over local state, a header that always prints the count,
 * and `{expanded && …}` so a closed section mounts no rows at all. Position and
 * disclosure are doing different jobs here: staying ABOVE the pipeline is what
 * makes the churn the first thing read, and starting CLOSED is what stops it
 * costing a page to get past. Nothing is hidden without saying how much.
 *
 * Open/closed is EPHEMERAL, for the reason `JobTrackerStatusGroup` gives: no
 * storage write on a UI toggle, in a surface whose claim is that it writes only
 * what the user asked it to.
 *
 * ## The one action, and the one still refused
 *
 * The trigger for `JobRepostArchiveDialog` sits in the header, reachable
 * without opening the list — the sweep is the whole reason most users will
 * look at this section, and burying it behind the disclosure would put a page
 * of scroll back in front of it. **Merge is still not offered**, and that is
 * not an oversight: see that dialog's docblock for why archiving is offerable
 * where merging was not.
 *
 * ## Why one list, and not a notice on each row
 *
 * A cluster's records are spread across STATUS buckets — the motivating group
 * was part `interested`, part `archived` — so no status section can hold the
 * statement, and repeating it on every member would be six statements for one
 * fact. Stating it once above the sections keeps the bucket counts honest
 * (`JobTrackerStatusGroup`'s header count stays the bucket's full length) and
 * leaves the individual records where the user filed them, reachable in their
 * own sections below rather than nested inside a second collapse.
 *
 * Reuse analysis: no new primitive and no new surface. `StatusBadge` from
 * `@design-system` carries the count, the disclosure is the house `<Button>` +
 * `aria-expanded` idiom (`JobTrackerStatusGroup`, `WeakMatchesSection`), and the
 * bulk action is a second instance of `JobArchiveSweepDialog`'s shape rather
 * than a parallel one. Deliberately NOT a `Card` or a bordered banner — it is a
 * `<section>` + `<h3>` + `<ul>` inside the tracker's existing card, the shape
 * `JobTrackerStatusGroup` uses, because a second panel above the pipeline would
 * compete with the pipeline.
 *
 * Split out of `JobTracker.tsx` rather than inlined: that file is already past
 * the ~200 LOC feature guideline.
 */

import { useState } from "react";
import { Button, StatusBadge } from "@design-system";
import { JobRepostArchiveDialog } from "./JobRepostArchiveDialog.tsx";
import type { JobRepostCluster } from "../../lib/job-repost-clusters.ts";
import type { JobRecord } from "../../lib/storage/index.ts";

/** Absolute, never "3 weeks ago". These are capture times spanning months and
 *  the span is the whole claim — a relative phrase against today's clock would
 *  drift out from under the number beside it. */
function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function JobRepostClusterList({
  clusters = [],
  jobs = [],
  archiveReposted,
}: {
  /** Every repost cluster in the library (`useJobRepostClusters`). Empty or
   *  omitted renders nothing — the common library has no re-listed role. */
  clusters?: readonly JobRepostCluster[];
  /** The tracker's current job list, handed straight to the sweep dialog so its
   *  preview count is computed over the same array the write reads. Omitted
   *  (with `archiveReposted`) renders the statement with no action, which is
   *  what a caller that only displays clusters should get. */
  jobs?: readonly JobRecord[];
  /** `useJobTracker`'s repost sweep. Omitted hides the bulk action. */
  archiveReposted?: (clusters: readonly JobRepostCluster[]) => Promise<number>;
}) {
  // Starts CLOSED — the opposite default from `JobTrackerStatusGroup`'s
  // non-terminal buckets, and for the opposite reason: those rows are the work,
  // these are a heads-up about it. Plain `useState` rather than that component's
  // `override ?? default` latch because this default is a constant, not a value
  // derived from the library that could change under an open section.
  const [expanded, setExpanded] = useState(false);

  if (clusters.length === 0) return null;

  return (
    <section className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {/* Same two-mechanism restoration of the heading look through a Button
            as `JobTrackerStatusGroup` — see that file for why the colour has to
            sit on an inner span rather than on the Button's className. */}
        <h3 className="uppercase tracking-wider">
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={expanded}
            // Cancels ghost's `px-2` so the label lines up with the rows.
            className="-ml-2 font-semibold"
            onClick={() => setExpanded(!expanded)}
          >
            <span className="inline-flex items-center gap-1 text-content-muted">
              <span aria-hidden="true">{expanded ? "▾" : "▸"}</span>
              Reposted roles · {clusters.length}
            </span>
          </Button>
        </h3>
        {archiveReposted !== undefined && (
          <JobRepostArchiveDialog
            jobs={jobs}
            clusters={clusters}
            archiveReposted={archiveReposted}
          />
        )}
      </div>
      {expanded && (
        <>
          <ul className="flex flex-col gap-2">
            {clusters.map((cluster) => (
              <li
                key={cluster.key}
                className="flex flex-col gap-1 rounded-md border border-border-light bg-surface-subtle p-2"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge tone="info">
                    Reposted {cluster.count}×
                  </StatusBadge>
                  <span className="text-sm text-content-primary">
                    {cluster.title || "Untitled job"}
                  </span>
                  <span className="text-sm text-content-secondary">
                    {cluster.company}
                  </span>
                </div>
                {/* `spanDays` is absent only when no member carries a readable
                capture time, and then the count is still true — so the line
                drops the span rather than printing an unreadable one. */}
                {cluster.spanDays !== undefined &&
                  cluster.firstSeen !== undefined &&
                  cluster.lastSeen !== undefined && (
                    <span className="text-xs text-content-muted">
                      {formatDate(cluster.firstSeen)} –{" "}
                      {formatDate(cluster.lastSeen)} · {cluster.spanDays} days
                      apart
                    </span>
                  )}
              </li>
            ))}
          </ul>
          <p className="text-sm text-content-muted">
            Listed more than once over time — kept as separate records, so no
            merge is offered for them.
          </p>
        </>
      )}
    </section>
  );
}
