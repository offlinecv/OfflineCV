// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Pagination — numbered page control for a long, already-materialised list.
 *
 * Domain-agnostic and display-only: it owns no page state. The caller holds
 * `page` and slices its own data, so the same control drives a client-side
 * slice (job search) or, later, a fetch-per-page list without changing shape.
 *
 * Lives in `shared/` rather than a feature folder because "cut a list into
 * pages" is not job-search-specific, and the repo's rule is one component per
 * concern — a second hand-rolled Prev/Next row in another feature would be the
 * duplication CLAUDE.md's Golden Rule forbids.
 *
 * Windowing: the number strip is bounded to `WINDOW` slots so a 40-page set
 * doesn't render 40 buttons. First and last are always reachable; an elided
 * run renders as a non-interactive ellipsis (`aria-hidden`, since the adjacent
 * numbers already describe the jump). Screen readers get the authoritative
 * "Page N of M" from the nav's own label, not from the ellipsis.
 *
 * Pages are 1-indexed here — it is user-facing text as much as an index, and
 * a 0-indexed `page` that renders as `page + 1` invites the off-by-one at
 * every callsite.
 */

import { Button } from "../primitives/Button.tsx";

/** Numbered slots rendered at once, excluding Prev/Next. Odd, so the current
 *  page sits centred when it is not near either end. */
const WINDOW = 5;

/**
 * The page numbers to render, in order, with `null` marking an elided run.
 * Exported for direct unit testing — the windowing is the only logic here and
 * asserting it through the DOM would test React, not the algorithm.
 */
export function pageWindow(page: number, pageCount: number): (number | null)[] {
  if (pageCount <= WINDOW + 2) {
    return Array.from({ length: pageCount }, (_, i) => i + 1);
  }
  // Centre the window on `page`, then clamp it inside [2, pageCount - 1] so
  // first/last always render as their own explicit slots.
  const half = Math.floor(WINDOW / 2);
  let start = Math.max(2, page - half);
  let end = Math.min(pageCount - 1, start + WINDOW - 1);
  start = Math.max(2, end - WINDOW + 1);
  if (end < start) end = start;

  const slots: (number | null)[] = [1];
  if (start > 2) slots.push(null);
  for (let p = start; p <= end; p += 1) slots.push(p);
  if (end < pageCount - 1) slots.push(null);
  slots.push(pageCount);
  return slots;
}

export function Pagination({
  page,
  pageCount,
  onPageChange,
  label = "Results",
}: {
  /** Current page, 1-indexed. */
  page: number;
  /** Total pages. The control renders nothing when this is 1 or less. */
  pageCount: number;
  onPageChange: (page: number) => void;
  /** Names what is being paged, for the nav's accessible label. */
  label?: string;
}) {
  if (pageCount <= 1) return null;

  return (
    <nav
      aria-label={`${label} pagination — page ${page} of ${pageCount}`}
      className="flex flex-wrap items-center gap-1"
    >
      <Button
        variant="ghost"
        size="sm"
        disabled={page <= 1}
        onClick={() => onPageChange(page - 1)}
      >
        <span aria-hidden="true">‹</span> Prev
      </Button>
      {pageWindow(page, pageCount).map((slot, i) =>
        slot === null ? (
          <span
            // Slot index is the only stable key for an ellipsis — there can be
            // one on each side and neither carries a page number.
            key={`gap-${i}`}
            aria-hidden="true"
            className="px-1 text-xs text-content-muted"
          >
            …
          </span>
        ) : (
          <Button
            key={slot}
            variant={slot === page ? "primary" : "ghost"}
            size="sm"
            aria-label={`Page ${slot}`}
            aria-current={slot === page ? "page" : undefined}
            onClick={() => onPageChange(slot)}
          >
            {slot}
          </Button>
        ),
      )}
      <Button
        variant="ghost"
        size="sm"
        disabled={page >= pageCount}
        onClick={() => onPageChange(page + 1)}
      >
        Next <span aria-hidden="true">›</span>
      </Button>
    </nav>
  );
}
