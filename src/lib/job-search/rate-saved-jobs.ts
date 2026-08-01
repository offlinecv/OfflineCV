// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Rate the SAVED job library against the parsed résumé (#700).
 *
 * The search lane has always had a fitness rating; the library — the jobs the
 * user cared enough to keep — showed none, because the whole chain could only
 * be driven from inside `rankPostings`. Nothing about the algorithm blocked it:
 * `extractJdTerms` → `computeCoverageFromCorpus` → `ratingInputFor` → `rateJobs`
 * is pure, dependency-free and cheap. Only two seams did, and both have moved
 * (`computeCoverageFromCorpus` in #699/#703, `RatingSignalSource` here), so this
 * module is the wiring and nothing else — no second coverage implementation, no
 * second `RatingInput` mapping, no second star scale.
 *
 * Three properties this module exists to hold:
 *
 *  1. **A record with nothing to match against is NOT rated — it is not rated
 *     ZERO.** A 0 reads as "terrible fit"; the truth is "no description to
 *     match against", and the two must not render the same. Such records are
 *     simply absent from the returned map, so a caller cannot accidentally
 *     paint them 0 stars. "Nothing to match against" is decided AFTER term
 *     extraction, not from the presence of text: a capture that saved only
 *     "Apply on our website." (or any prose `extractJdTerms` finds no terms in
 *     — a non-English posting, a "-" placeholder) yields zero terms, and
 *     `computeCoverageFromCorpus` correctly returns score 0 for an empty
 *     requirement set, which would paint an empty 5-star widget labelled
 *     "Weak fit". Text is not a description.
 *  2. **Nothing is persisted.** The rating is derived from the résumé, which the
 *     user edits on `/`, and no write to a `JobRecord` would ever be invalidated
 *     by that edit. So the rating is recomputed on view and `JobRecord`'s shape
 *     is untouched — which also keeps the public capture contract
 *     (`job-record-contract.ts`, `docs/job-capture-contract.md`) out of it.
 *  3. **A record's rating depends only on THAT record and the résumé.** Saving
 *     or deleting another job may not move a saved job's stars. This property
 *     used to say the opposite — the library had to be rated as ONE set because
 *     `rateJobs`'s fitness axis was hybrid absolute + set-RELATIVE, so rating
 *     records one at a time put the library on a different scale from the search
 *     lane for the same posting. #716 made the axis absolute and that reason
 *     evaporated: the two are now identical by construction. The whole rateable
 *     set still goes into ONE `rateJobs` call, exactly as `rankPostings` pass 2
 *     does — but now for the shared-code reason (one computation site, so the
 *     library and the search lane cannot drift apart), not for a scale reason.
 *
 * Which axes are present: fitness only. There is no query behind the library —
 * no location, no seniority, no comp floor — so those three axes are absent,
 * drop out of the blend, and their weight redistributes onto fitness (the
 * "silence is neutral" rule in `rating.ts`). `describeRating` therefore yields
 * exactly one reason phrase per saved job, which is the honest amount to say.
 */

import type { HeuristicParsedResume } from "../heuristics/types.ts";
import {
  extractJdTerms,
  type ExtractedTerm,
} from "../jd-match/extract-jd-terms.ts";
import { buildCorpus, computeCoverageFromCorpus } from "../jd-match/coverage.ts";
import { ratingInputFor } from "./rank.ts";
import { rateJobs, type JobRating } from "./rating.ts";

/**
 * The slice of a `JobRecord` a fitness rating is derived from. Structural, so a
 * real `JobRecord` satisfies it and a test can pass a three-field literal —
 * this module has no reason to reach into the storage layer's types.
 */
export interface RatableSavedJob {
  id: string;
  title: string;
  /** The saved posting text. Absent, blank, or carrying no extractable terms
   *  all mean there is nothing to match against, and the record is left OUT of
   *  the returned map — see property 1. */
  jdText?: string;
}

/**
 * Rate every saved job that carries a job description, against `parsed`.
 *
 * Returns one entry per RATEABLE record, keyed by `JobRecord.id`. A record
 * whose `jdText` yields no requirement terms has no entry: absence is the "not
 * rated" signal, and the caller must render it as such rather than as a zero.
 */
export function rateSavedJobs(
  jobs: readonly RatableSavedJob[],
  parsed: HeuristicParsedResume,
): Map<string, JobRating> {
  // Extraction decides rateability, so it happens FIRST and exactly once per
  // record — the terms it produces are carried forward rather than recomputed.
  const rateable: { id: string; title: string; terms: ExtractedTerm[] }[] = [];
  for (const job of jobs) {
    const jdText = (job.jdText ?? "").trim();
    if (jdText === "") continue;
    // `postingTitle` keeps the job's own name and team out of its requirement
    // set — a posting cannot be evidence for itself (see `ExtractOptions`).
    const terms = extractJdTerms(jdText, { postingTitle: job.title }).all;
    // Zero terms is an empty requirement set, which coverage scores 0 — the
    // "terrible fit" reading property 1 forbids. Not rateable.
    if (terms.length === 0) continue;
    rateable.push({ id: job.id, title: job.title, terms });
  }
  if (rateable.length === 0) return new Map();

  // The résumé reduced to what matching actually reads — built once for the
  // whole library, not once per record.
  const corpus = buildCorpus(parsed);

  const inputs = rateable.map(({ title, terms }) => {
    const coverage = computeCoverageFromCorpus(corpus, terms);
    // `location` is a placeholder, never read: `ratingInputFor` only consults it
    // when a query location is passed, and the library has no query. Same for
    // `title` and the seniority rung. Assembling the input HERE rather than
    // hand-rolling a `RatingInput` is the point — see `ratingInputFor`.
    return ratingInputFor(
      {
        posting: { title, location: "" },
        score: coverage.score,
        jdMatch: { terms },
      },
      undefined,
      undefined,
      undefined,
    );
  });

  // ONE call, through the lane's single rating site — property 3. The set is not
  // needed for the arithmetic (every rating is per-record since #716); sharing
  // the call site is what keeps the library and the search lane identical.
  const ratings = rateJobs(inputs);
  return new Map(rateable.map(({ id }, i) => [id, ratings[i]]));
}
