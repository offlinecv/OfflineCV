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
 * Zero-dep and pure, so nothing that imports it pays for a tier it wasn't
 * already loading.
 */

const REMOTE_PATTERN = /\b(remote|worldwide|anywhere|wfh)\b/i;

/** True for a posting location that reads as remote/location-agnostic — a remote
 *  posting fits any candidate location, so it always counts as a match. */
export function isRemotePosting(location: string): boolean {
  return REMOTE_PATTERN.test(location);
}

/** "Austin, TX, USA" → ["austin", "tx", "usa"]. Empty segments are dropped so a
 *  stray comma can't produce an empty city that matches everything below. */
function segments(location: string): string[] {
  return location
    .toLowerCase()
    .split(",")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

/** Whole words of a city segment — the unit the fallback compares, because raw
 *  substrings are what let a bare "IN" posting survive an "Austin, TX" filter. */
function words(city: string): string[] {
  return city.split(/\s+/).filter((word) => word.length > 0);
}

/** The state/country behind the city must not CONTRADICT the one asked for.
 *  Either side may omit it (a feed's "Austin" against a query's "Austin, TX"),
 *  but "Portland, OR" and "Portland, ME" are exactly the pair a location filter
 *  exists to separate, so two stated qualifiers that differ are a mismatch. */
function qualifiersAgree(a: string | undefined, b: string | undefined): boolean {
  return a === undefined || b === undefined || a === b;
}

/** True when every word of `inner` appears in `outer` — "new york" inside
 *  "new york city", never "in" inside "austin". */
function containsAllWords(outer: readonly string[], inner: readonly string[]): boolean {
  const haystack = new Set(outer);
  return inner.length > 0 && inner.every((word) => haystack.has(word));
}

/**
 * True when `postingLocation` should count as a match for `queryLocation`.
 *
 * Compares the city segment (text before the first comma) and requires the
 * qualifier behind it not to conflict, so "Austin, TX" matches a feed's
 * "Austin, TX, USA" without an exact string match while "Portland, OR" does
 * NOT match "Portland, ME". When the city segments differ, it falls back to
 * WHOLE-WORD containment either direction, which admits "New York, NY" against
 * "New York City, NY" without admitting a bare "IN" posting against "Austin,
 * TX" the way a raw substring test did (#905 review).
 *
 * Known limits, both needing data this module deliberately doesn't carry: an
 * alias table would be required for "SF Bay Area" vs "San Francisco, CA", and a
 * gazetteer to tell a city refinement from a company name in "Boston Consulting
 * Group, London". Both fail toward the soft axis, and the never-fail-closed
 * floor below is what keeps either from emptying the panel.
 *
 * An EMPTY posting location returns false — a feed that told us nothing about
 * where the job is has not told us it is near you. That is the conservative
 * read for the RATING axis (no evidence, no credit); the hard filter takes the
 * opposite read on the same fact, see `filterPostingsByLocation`.
 */
export function locationMatches(queryLocation: string, postingLocation: string): boolean {
  if (isRemotePosting(postingLocation)) return true;
  const posting = segments(postingLocation);
  const query = segments(queryLocation);
  if (posting.length === 0 || query.length === 0) return false;
  if (!qualifiersAgree(posting[1], query[1])) return false;
  if (posting[0] === query[0]) return true;
  const postingWords = words(posting[0]);
  const queryWords = words(query[0]);
  return (
    containsAllWords(postingWords, queryWords) || containsAllWords(queryWords, postingWords)
  );
}

/**
 * Keep only the postings that sit at `queryLocation` (or are remote) — the hard
 * arm of the location axis, applied ONLY when the user turns on `locationOnly`
 * (#809). Returns the input untouched when there is no location to filter on,
 * so an unset location is byte-identical to pre-#809 behavior.
 *
 * UNKNOWN IS NOT FAR. A posting whose feed omitted `location` (documented as
 * `""` on `JobPosting`, and the keyless aggregator feeds are inconsistent about
 * filling it at all) PASSES this filter, the same way a remote posting does.
 * `locationMatches` reads the same blank as a non-match because it is scoring a
 * rating and has no evidence to credit; a remover cannot borrow that read
 * without telling the user it hid a posting "as too far away" when it has no
 * idea where the posting is (#905 review). So the two readers of the blank
 * differ on purpose, and `locationFilteredOut` counts only postings that stated
 * a location somewhere else.
 *
 * NEVER FAIL CLOSED, the same floor `filterPostingsByExcludeTerms` and the
 * #566 role filter already apply: when the filter would reduce a NON-EMPTY set
 * to EMPTY, the input is kept and `suppressed` is set for the panel's notice.
 * A blank screen the user cannot diagnose is worse than an unfiltered one, and
 * the notice points them back at the toggle.
 */
export function filterPostingsByLocation<T extends { location: string }>(
  postings: readonly T[],
  queryLocation: string | undefined,
): { postings: T[]; suppressed: boolean } {
  const query = queryLocation?.trim();
  if (!query) return { postings: [...postings], suppressed: false };
  const kept = postings.filter(
    (posting) =>
      posting.location.trim().length === 0 || locationMatches(query, posting.location),
  );
  if (kept.length === 0 && postings.length > 0) {
    return { postings: [...postings], suppressed: true };
  }
  return { postings: kept, suppressed: false };
}
