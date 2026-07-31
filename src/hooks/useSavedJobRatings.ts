// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * useSavedJobRatings — the saved job library's fitness ratings, recomputed on
 * view (#700).
 *
 * Two constraints shape this hook, and neither is visible in the call site:
 *
 * **It must not drag the rating chain into the `/jobs/` entry chunk.** The
 * tracker renders eagerly on `/jobs/`, and `refine.ts` deliberately holds
 * `rank.ts` behind `await import("./rank.ts")` so a search pays for that graph
 * and a page load does not. A static import here would undo it for every
 * visitor who never opens the library. Measured, not assumed: `skills.ts` is
 * ALREADY eager on this entry (`FindJobsPanel` → `query-builder.ts` imports
 * `getSkillIndex`), so what the dynamic import actually keeps out is `rank.ts`,
 * `coverage.ts` and `extract-jd-terms.ts` (~20 KB) — real, but not the whole
 * dictionary. So `rate-saved-jobs.ts` is dynamic-imported, every other import in
 * this file is `import type`, and the result is state rather than a `useMemo`.
 *
 * **Nothing is cached against a record.** The rating is a function of the
 * résumé, so any value written to a `JobRecord` would go stale the moment the
 * user edits their résumé on `/` with nothing to invalidate it. Recomputing is
 * cheap, so the ratings live here for the life of the mount and nowhere else.
 *
 * Returns `null` while there is no rating to show — no résumé in this tab, or a
 * pass in flight for the current inputs — so the caller renders no fitness block
 * rather than a stale or zeroed one. A returned map is complete for the current
 * inputs; a job id ABSENT from it carries no job description and must render as
 * "not rated", never as zero stars.
 *
 * `parsed` must be referentially stable across renders — `JobsApp` holds it in
 * `useState`, which is the contract. It is a direct effect dependency (a new
 * résumé must re-rate), so a caller that rebuilt the object every render would
 * re-fire the effect every render.
 */

import { useEffect, useMemo, useState } from "react";
import type { HeuristicParsedResume } from "../lib/heuristics/types.ts";
import type { JobRating } from "../lib/job-search/rating.ts";
import type { RatableSavedJob } from "../lib/job-search/rate-saved-jobs.ts";

/** Field separator / record separator for the input signature. Control
 *  characters, so no title or JD body can forge a boundary. */
const FIELD_SEP = "\u001f";
const RECORD_SEP = "\u001e";

export function useSavedJobRatings(
  jobs: readonly RatableSavedJob[],
  parsed: HeuristicParsedResume | undefined,
): ReadonlyMap<string, JobRating> | null {
  // Every field `rateSavedJobs` reads, in order. `useJobTracker` hands back a
  // fresh array after EVERY mutation, so keying the effect on `jobs` identity
  // would re-rate the whole library on a notes keystroke commit or a status
  // change. Keying on the content that actually feeds a rating means an edit to
  // any other field is free — and, because the signature covers every field
  // read, the `jobs` array closed over below can never be stale in a way that
  // changes the result.
  const signature = useMemo(
    () =>
      jobs
        .map((job) => `${job.id}${FIELD_SEP}${job.title}${FIELD_SEP}${job.jdText ?? ""}`)
        .join(RECORD_SEP),
    [jobs],
  );

  const [computed, setComputed] = useState<{
    signature: string;
    parsed: HeuristicParsedResume;
    byId: ReadonlyMap<string, JobRating>;
  } | null>(null);

  useEffect(() => {
    if (parsed === undefined) return;
    let cancelled = false;
    void import("../lib/job-search/rate-saved-jobs.ts")
      .then(({ rateSavedJobs }) => {
        // A superseded pass (or an unmount) must not overwrite a newer result:
        // the import resolves out of band, so ordering is not guaranteed.
        if (cancelled) return;
        setComputed({ signature, parsed, byId: rateSavedJobs(jobs, parsed) });
      })
      .catch((err: unknown) => {
        // The chunk can fail to load for real — a stale index after a deploy is
        // the common one. Without this the rejection is unhandled AND invisible:
        // `computed` stays null, and because `parsed` is defined the tracker
        // also suppresses the line explaining why no ratings are shown, so the
        // library silently renders nothing forever. Leaving `computed` null is
        // the right end state (no rating is better than a wrong one); the point
        // is that the reason reaches the console.
        console.error("[useSavedJobRatings] rating pass failed:", err);
      });
    return () => {
      cancelled = true;
    };
    // Deps hand-audited (`exhaustive-deps` is not enforced here — CLAUDE.md):
    // `signature` and `parsed` are the complete set of inputs the result depends
    // on. `jobs` is read but deliberately omitted — see the signature comment;
    // adding it would re-fire on every unrelated tracker mutation. `setComputed`
    // is stable.
  }, [signature, parsed]);

  if (parsed === undefined) return null;
  // Only surface a result computed from exactly the inputs we hold now. During
  // a recompute the previous map describes a different library, so it is
  // withheld rather than shown against the wrong rows.
  return computed !== null && computed.signature === signature && computed.parsed === parsed
    ? computed.byId
    : null;
}
