// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * JobRepostClusterList — one line per role a company keeps re-listing (#754).
 *
 * The affordance this replaces is the point of it. Six saved rows for one role
 * spread over 49 days used to render 30 **Merge into this one** buttons, each
 * one a destructive action that would have collapsed the churn into a single
 * record. This says the true thing instead — *reposted 6×, 49 days* — once per
 * cluster, and offers nothing: there is nothing here for a user to accept or
 * decline, so there is no button, no confirm, and no dismissal.
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
 * Reuse analysis: display-only, no state, no new primitive. `StatusBadge` from
 * `@design-system` carries the count; everything else is text on the same
 * semantic tokens the rows use. Deliberately NOT a `Card` or a bordered banner —
 * it is a `<section>` + `<h3>` + `<ul>` inside the tracker's existing card, the
 * shape `JobTrackerStatusGroup` uses, because a second panel above the pipeline
 * would compete with the pipeline.
 *
 * Split out of `JobTracker.tsx` rather than inlined: that file is already past
 * the ~200 LOC feature guideline.
 */

import { StatusBadge } from "@design-system";
import type { JobRepostCluster } from "../../lib/job-repost-clusters.ts";

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
}: {
  /** Every repost cluster in the library (`useJobRepostClusters`). Empty or
   *  omitted renders nothing — the common library has no re-listed role. */
  clusters?: readonly JobRepostCluster[];
}) {
  if (clusters.length === 0) return null;

  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold uppercase tracking-wider text-content-muted">
        Reposted roles · {clusters.length}
      </h3>
      <ul className="flex flex-col gap-2">
        {clusters.map((cluster) => (
          <li
            key={cluster.key}
            className="flex flex-col gap-1 rounded-md border border-border-light bg-surface-subtle p-2"
          >
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge tone="info">Reposted {cluster.count}×</StatusBadge>
              <span className="text-sm text-content-primary">
                {cluster.title || "Untitled job"}
              </span>
              <span className="text-sm text-content-secondary">{cluster.company}</span>
            </div>
            {/* `spanDays` is absent only when no member carries a readable
                capture time, and then the count is still true — so the line
                drops the span rather than printing an unreadable one. */}
            {cluster.spanDays !== undefined &&
              cluster.firstSeen !== undefined &&
              cluster.lastSeen !== undefined && (
                <span className="text-xs text-content-muted">
                  {formatDate(cluster.firstSeen)} – {formatDate(cluster.lastSeen)} ·{" "}
                  {cluster.spanDays} days apart
                </span>
              )}
          </li>
        ))}
      </ul>
      <p className="text-sm text-content-muted">
        Listed more than once over time — kept as separate records, so no merge is
        offered for them.
      </p>
    </section>
  );
}
