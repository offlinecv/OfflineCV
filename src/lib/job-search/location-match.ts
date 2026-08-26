// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * The ONE "does this posting sit where the candidate asked" predicate (#809).
 *
 * It used to be two private helpers inside `rank.ts`, where location was only
 * ever a bounded soft axis — a flag feeding the star rating, never a reason to
 * drop a posting. #809 adds an explicit user-set `locationOnly` mode that HARD
 * filters on the same question, and a hard filter that disagreed with the soft
 * axis would be indefensible on screen: a posting the card renders with a
 * location tick would vanish when the toggle flips, or survive it while the
 * card says the location doesn't match. So the predicate moved here and both
 * readers import it — `rank.ts` for `RatingInput.locationMatch`, `refine.ts`
 * for the filter. Neither owns a second definition.
 *
 * The MODEL is a string comparison, not geography: there is no radius, no
 * geocoding, no distance. "Near me" in the #809 feedback is served by "the
 * posting names my city, my region, or is remote" — which is what a feed's
 * free-text `location` field can actually support. Anything finer needs a
 * geocoder, which is a network call this app does not get to make.
 *
 * Zero-dep and pure, so it stays out of the dynamic-import tiers: `refine.ts`
 * can filter before it has paid for `rank.ts`.
 */

const REMOTE_PATTERN = /\b(remote|worldwide|anywhere|wfh)\b/i;

/** True for a posting location that reads as remote/location-agnostic — a remote
 *  posting fits any candidate location, so it always counts as a match. */
export function isRemotePosting(location: string): boolean {
  return REMOTE_PATTERN.test(location);
}

/**
 * True when `postingLocation` should count as a match for `queryLocation`.
 * Compares the leading city/region token (text before the first comma) so
 * "Austin, TX" matches a feed's "Austin, TX, USA" without requiring an exact
 * string match, and falls back to a loose substring check either direction for
 * postings that don't follow the "City, ST" shape.
 *
 * An EMPTY posting location returns false — a feed that told us nothing about
 * where the job is has not told us it is near you. That is the conservative
 * read for the rating axis (no evidence, no credit) and, since #809, the reason
 * `locationOnly` needs its never-fail-closed floor: a feed whose postings all
 * carry an empty location would otherwise be filtered to nothing.
 */
export function locationMatches(queryLocation: string, postingLocation: string): boolean {
  if (isRemotePosting(postingLocation)) return true;
  const posting = postingLocation.trim().toLowerCase();
  const query = queryLocation.trim().toLowerCase();
  if (!posting || !query) return false;
  const postingCity = posting.split(",")[0].trim();
  const queryCity = query.split(",")[0].trim();
  return postingCity === queryCity || posting.includes(query) || query.includes(posting);
}

/**
 * Keep only the postings that sit at `queryLocation` (or are remote) — the hard
 * arm of the location axis, applied ONLY when the user turns on `locationOnly`
 * (#809). Returns the input untouched when there is no location to filter on,
 * so an unset location is byte-identical to pre-#809 behavior.
 *
 * NEVER FAIL CLOSED, the same floor `filterPostingsByExcludeTerms` and the
 * #566 role filter already apply: when the filter would reduce a NON-EMPTY set
 * to EMPTY, the input is kept and `suppressed` is set for the panel's notice.
 * The keyless aggregator feeds skew remote and are inconsistent about filling
 * `location` at all, so "local only" over a set that named no locations is a
 * blank screen the user cannot diagnose — the notice points them back at the
 * toggle instead.
 */
export function filterPostingsByLocation<T extends { location: string }>(
  postings: readonly T[],
  queryLocation: string | undefined,
): { postings: T[]; suppressed: boolean } {
  const query = queryLocation?.trim();
  if (!query) return { postings: [...postings], suppressed: false };
  const kept = postings.filter((posting) => locationMatches(query, posting.location));
  if (kept.length === 0 && postings.length > 0) {
    return { postings: [...postings], suppressed: true };
  }
  return { postings: kept, suppressed: false };
}
