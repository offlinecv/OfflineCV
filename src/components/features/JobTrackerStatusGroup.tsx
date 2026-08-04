// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * JobTrackerStatusGroup — one status bucket of the job tracker (#740): a
 * disclosure header that always states the bucket's size, and the paged slice
 * of rows beneath it.
 *
 * Split off `JobTracker.tsx` because the per-section state (open/closed, page)
 * cannot live in the parent without one `useState` per bucket in a component
 * that does not know how many buckets there are — and because `JobTracker` was
 * already at the ~200 LOC gate. The name `JobTrackerSection` was taken by the
 * hook-owning wrapper in that file.
 *
 * Collapse is a REAL render saving, not a CSS hide: `{expanded && …}` means a
 * closed bucket mounts none of its `JobTrackerEntry` rows. At 444 saved jobs
 * that is the whole point. The header still prints `{label} · {count}`, so
 * nothing is hidden without saying how much — and the count is the bucket's
 * FULL length, never the paged slice, so the sum across sections still equals
 * the header total whatever is open.
 *
 * A collapsed bucket stays fully actionable once opened: the rows are the same
 * `JobTrackerEntry`s with the same status picker and remove affordance. This is
 * not an archive you can only look at.
 *
 * No `Disclosure` primitive: this follows the house idiom of a `<Button>` with
 * `aria-expanded` over local state (`WeakMatchesSection.tsx`,
 * `CompanyTargets.tsx`). Promoting that idiom to `@design-system` would be an
 * explicit review decision, not a side effect of this change.
 *
 * Open/closed is EPHEMERAL — no storage write on a UI toggle, in a surface
 * whose whole claim is that it writes only what the user asked it to.
 */

import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Button, Pagination } from "@design-system";
import { jobStatusLabel } from "./JobStatusPicker.tsx";
import type { JobRecord } from "../../lib/storage/index.ts";

/**
 * Rows an expanded bucket renders at once, and therefore the size above which
 * it pages. **25 is a guess, not a measurement** — it is roughly a screenful
 * and a half, chosen so the common bucket never pages at all. Nothing depends
 * on the exact value; raising it costs render time, lowering it costs clicks.
 */
export const SECTION_PAGE_SIZE = 25;

/**
 * Buckets that open closed. `rejected` and `archived` are where a job goes to
 * stop being work: the largest buckets in a mature library and the least
 * useful open. `offer` is deliberately NOT here — `JOB_STATUS_ORDER`'s docblock
 * calls it terminal, but it is terminal in the way a user wants to look at.
 *
 * Every other bucket opens expanded, INCLUDING one this build does not know
 * (a corrupt or future-version imported record `jobStatusBucket` could not
 * map): a bucket the app cannot explain is the one the user most needs to see.
 */
const COLLAPSED_BY_DEFAULT: readonly string[] = ["rejected", "archived"];

/** Whether this bucket opens closed. Takes the DISPLAY bucket key, not a stored
 *  status, so a status that maps into a terminal bucket (`withdrawn` →
 *  `rejected`, #744) collapses with it rather than opening on its own. Typed
 *  `string` rather than `JobStatus` because an unmapped status buckets as
 *  itself. */
export function isCollapsedByDefault(bucket: string): boolean {
  return COLLAPSED_BY_DEFAULT.includes(bucket);
}

export function JobTrackerStatusGroup({
  bucket,
  jobs,
  defaultExpanded,
  renderRow,
}: {
  /** The DISPLAY bucket this section holds (#744) — a `JobStatus` for anything
   *  `jobStatusBucket` could map, otherwise the literal stored status. Never a
   *  value to write back: the rows inside may each carry a different stored
   *  status, and the header speaks for the bucket, not for any one of them. */
  bucket: string;
  /** Every job in the bucket, in the parent's order. Not sliced by the caller:
   *  the header count and the page arithmetic both need the full length. */
  jobs: readonly JobRecord[];
  /** Whether this bucket should open on its own. Followed in the OPENING
   *  direction for as long as the user has not toggled the section (see
   *  `override` below), so a bucket that becomes the only non-empty one after a
   *  delete still opens instead of stranding the user on a page of headers over
   *  no rows. Never followed back down — see `everOpenedItself`. */
  defaultExpanded: boolean;
  /** Renders one row. A callback rather than nine pass-through props: this
   *  component's concern is collapsing and paging a list, and it has no
   *  business knowing about ratings, letters or linked résumés. */
  renderRow: (job: JobRecord) => ReactNode;
}) {
  // `null` = the user has not touched this section, so the default below still
  // governs and keeps governing as the library changes under it. Storing a
  // plain `useState(defaultExpanded)` would freeze the mount-time value, so a
  // bucket that only becomes the last one standing after a delete would open
  // closed. The default governs only until the user first expresses an intent:
  // once they toggle, `override` is theirs and it sticks, so a section the user
  // explicitly collapsed stays collapsed — the labelled toggle is right there.
  const [override, setOverride] = useState<boolean | null>(null);
  const [page, setPage] = useState(1);

  // A one-way latch, because `defaultExpanded` is derived from the WHOLE
  // library: a terminal bucket that opened itself as the last one standing
  // would otherwise slam shut the moment a job lands in another bucket —
  // unmounting rows the user is reading, with no action of theirs. On `/jobs/`
  // that is reachable, not theoretical: `Tabs` keeps both panels mounted, so
  // saving a job from Search mutates the library under an open Saved-jobs
  // section. Latching also keeps this closer to the precedent it follows
  // (`WeakMatchesSection`'s `useState(defaultOpen)`), which simply never
  // re-reads the default. Writing a ref during render is safe here: the write
  // is idempotent, so a StrictMode double-invoke lands on the same value.
  const everOpenedItself = useRef(false);
  if (defaultExpanded) everOpenedItself.current = true;
  const expanded = override ?? everOpenedItself.current;

  // Page resets when this section's MEMBERSHIP changes — an add, a remove or a
  // status move, the three things that make a page index point at different
  // jobs. The key is a SET of ids, not an ordered list, precisely BECAUSE the
  // order is not stable: `listJobs()` re-sorts the whole library by `updatedAt`
  // descending on every read, and `updateJob()` bumps `updatedAt`
  // (`src/lib/job-tracker.ts`), so editing one note floats that job to the front
  // of its bucket. An order-sensitive key — or `jobs` identity, which the parent
  // rebuilds on any tracker write — would therefore yank the reader back to page
  // 1 mid-read on a mere inline edit. Ids join on a NUL no realistic id carries.
  // (An id here is whatever a backup carried, not necessarily a UUID, so the
  // separator is worth picking.) Memoised because the sort now runs over the
  // whole bucket — 444 ids in the motivating case. `.map()` already returns a
  // fresh array, so the `.sort()` never touches the readonly `jobs`.
  const membership = useMemo(
    () =>
      jobs
        .map((job) => job.id)
        .sort()
        .join("\u0000"),
    [jobs],
  );
  useEffect(() => {
    setPage(1);
  }, [membership]);

  // An empty bucket is a header apologising for itself. The parent never builds
  // one, but the guard keeps the page arithmetic below total.
  if (jobs.length === 0) return null;

  const pageCount = Math.ceil(jobs.length / SECTION_PAGE_SIZE);
  // Clamp rather than trust `page`: the reset effect runs AFTER the render in
  // which the bucket shrank, so for one commit `page` can point past the end.
  const current = Math.min(page, pageCount);
  const start = (current - 1) * SECTION_PAGE_SIZE;
  const shown = jobs.slice(start, start + SECTION_PAGE_SIZE);
  // `jobStatusLabel` still takes the raw string and falls back to it, so an
  // unmapped bucket heads its section with its literal status.
  const label = jobStatusLabel(bucket);

  return (
    <section className="flex flex-col gap-2">
      {/* Restoring the pre-#740 heading look through the Button takes two
          different mechanisms, because two different things are in the way.
          `uppercase`/`tracking-wider` INHERIT, so they sit on the `h3`.
          `font-semibold` does not inherit, but nothing at the same specificity
          emits after it, so it beats BASE's `font-medium` from `className`.
          Colour is the one that cannot be won that way: the repo has no
          `tailwind-merge`, `Button` just joins the strings, and Tailwind
          resolves same-layer/same-specificity conflicts by STYLESHEET order —
          where `text-content-secondary` (the ghost variant's) is emitted after
          `text-content-muted`, following the `@theme inline` declaration order
          in `styles/theme.css`. Class-attribute order is irrelevant. So the
          colour goes on an inner span, where the variant does not compete and
          no `!` is needed. The span re-declares the flex row because it is now
          the Button's single child, and BASE's `gap-1` would otherwise have
          nothing left to separate. */}
      <h3 className="uppercase tracking-wider">
        <Button
          variant="ghost"
          size="sm"
          aria-expanded={expanded}
          // Cancels ghost's `px-2` so the label lines up with the rows.
          className="-ml-2 font-semibold"
          onClick={() => setOverride(!expanded)}
        >
          <span className="inline-flex items-center gap-1 text-content-muted">
            <span aria-hidden="true">{expanded ? "▾" : "▸"}</span>
            {label} · {jobs.length}
          </span>
        </Button>
      </h3>

      {expanded && (
        <>
          <ul className="flex flex-col gap-2">
            {shown.map((job) => (
              <Fragment key={job.id}>{renderRow(job)}</Fragment>
            ))}
          </ul>
          {/* One guard over both, the shape `JobSearchResults` uses: the count
              line and the control are the same affordance, so an unpaged bucket
              renders neither rather than leaning on Pagination's internal null. */}
          {pageCount > 1 && (
            <div className="flex flex-col gap-2">
              <p className="text-sm text-content-muted">
                Showing {start + 1}–{start + shown.length} of {jobs.length}.
              </p>
              <Pagination
                page={current}
                pageCount={pageCount}
                onPageChange={setPage}
                label={`${label} jobs`}
              />
            </div>
          )}
        </>
      )}
    </section>
  );
}
