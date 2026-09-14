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
 * posting names my city, or names only a region I sit in, or is remote" —
 * which is what a feed's free-text `location` field can actually support.
 * Anything finer needs a geocoder, which is a network call this app does not
 * get to make.
 *
 * The one piece of DATA it carries is borrowed, not owned: `country-registry`
 * (#429) already folds "TX" / "Texas" onto one state and "USA" / "United
 * States" onto one country, and without that fold a feed's "Austin, Texas"
 * reads as a different place from a résumé's "Austin, TX" (#905 review). That
 * is the whole vocabulary — US states and the registry's country names. There
 * is no gazetteer: it does not know that Telangana is in India, that "SF Bay
 * Area" is San Francisco, or that Berlin is in Europe, and every limit listed
 * on `locationMatches` is one of those.
 *
 * Pure, and the registry it imports is pure too, so nothing that imports this
 * pays for a tier it wasn't already loading.
 */

import {
  countryCodeForToken,
  countryDisplayName,
  usStateName,
} from "../pdf/country-registry.ts";

const REMOTE_PATTERN = /\b(remote|worldwide|anywhere|wfh)\b/i;

/** True for a posting location that reads as remote/location-agnostic — a remote
 *  posting fits any candidate location, so it always counts as a match. */
export function isRemotePosting(location: string): boolean {
  return REMOTE_PATTERN.test(location);
}

/** "Austin, TX, USA" → ["austin", "tx", "usa"]. Empty segments are dropped so a
 *  stray comma can't produce an empty city that matches everything below. A
 *  multi-office list ("San Francisco, CA; New York, NY") never reaches here —
 *  `locationMatches` splits it into alternatives first. */
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

// Canonical region keys. A US state and a country get a TAGGED key so a
// spelled-out "India" (country:IN) and a spelled-out "Indiana" (state:indiana)
// can never meet, and anything the registry doesn't know keeps its literal
// text, so a feed's "Telangana" still meets a query's "Telangana". A BARE
// two-letter segment is decided before any tag is applied, and the US state
// wins — the registry's own precedence (#429) — so "DE", "IN", "IL" and "CA"
// are Delaware, Indiana, Illinois and California, never Germany, India, Israel
// or Canada. That is a known limit, listed on `locationMatches`.
const STATE = "state:";
const COUNTRY = "country:";
const UNITED_STATES = `${COUNTRY}US`;

function canonicalRegion(segment: string): string {
  const state = usStateName(segment);
  if (state !== undefined) return STATE + state;
  const country = countryCodeForToken(segment);
  if (country !== undefined) return COUNTRY + country;
  // A feed that writes the ISO code itself ("Paris, FR") names the same
  // country as one that writes the name, so it gets the same key (#905 review).
  if (segment.length === 2 && countryDisplayName(segment) !== undefined) {
    return COUNTRY + segment.toUpperCase();
  }
  return segment;
}

function isUsState(region: string): boolean {
  return region.startsWith(STATE);
}

/** One location string in comparable form. */
interface Place {
  /** The leading segment — the city on a "City, ST" string. */
  city: string;
  /** Every segment after the city, canonicalised. */
  qualifiers: string[];
  /**
   * Every segment canonicalised, for a string that may name NO city: a single
   * segment ("USA", "Texas", "Berlin" — undecidable without a gazetteer, so
   * both readings are tried) or a country-led list, which is the shape a
   * remote-only board's eligibility field takes ("USA, Canada", Remotive's
   * `candidate_required_location`). Undefined for a "City, …" string, which
   * only ever gets the city reading.
   */
  regions?: string[];
}

function place(location: string): Place | undefined {
  const parts = segments(location);
  if (parts.length === 0) return undefined;
  const canonical = parts.map(canonicalRegion);
  const regionOnly = parts.length === 1 || canonical[0].startsWith(COUNTRY);
  return {
    city: parts[0],
    qualifiers: canonical.slice(1),
    regions: regionOnly ? canonical : undefined,
  };
}

/**
 * True when two region lists name a common place. A US state on both sides
 * must be the SAME state — "Portland, OR" and "Portland, ME" are exactly the
 * pair a location filter exists to separate, and the "USA" they both imply
 * must not rescue them. Otherwise any shared key does it, and a side that
 * names a US state implicitly names the United States, so "Austin, TX" sits
 * inside a feed's "Austin, United States" and inside Remotive's "USA".
 */
function regionsOverlap(a: readonly string[], b: readonly string[]): boolean {
  const stateA = a.find(isUsState);
  const stateB = b.find(isUsState);
  if (stateA !== undefined && stateB !== undefined) return stateA === stateB;
  const withCountry = (regions: readonly string[], state: string | undefined) =>
    state === undefined ? regions : [...regions, UNITED_STATES];
  const haystack = new Set(withCountry(b, stateB));
  return withCountry(a, stateA).some((region) => haystack.has(region));
}

/** The state/country behind the city must not CONTRADICT the one asked for.
 *  Either side may omit it (a feed's "Austin" against a query's "Austin, TX"),
 *  but two stated qualifiers that name no common place are a mismatch. */
function qualifiersAgree(a: readonly string[], b: readonly string[]): boolean {
  return a.length === 0 || b.length === 0 || regionsOverlap(a, b);
}

/** True when every word of `inner` appears in `outer` — "new york" inside
 *  "new york city", never "in" inside "austin". */
function containsAllWords(outer: readonly string[], inner: readonly string[]): boolean {
  const haystack = new Set(outer);
  return inner.length > 0 && inner.every((word) => haystack.has(word));
}

/** The separators a company board uses between the offices of a multi-site
 *  role ("San Francisco, CA; New York, NY", "Austin, TX | Dallas, TX"). Commas
 *  are not among them — a comma separates city from qualifier. */
const OFFICE_LIST_SEPARATOR = /[;|]/;

/**
 * True when `postingLocation` should count as a match for `queryLocation`.
 *
 * A posting that lists several offices matches when ANY of them does: the
 * company-board adapters pass `location` through as free text, and a multi-site
 * role's field is a list, so judging only the first office would make the
 * answer depend on the order the company typed them in (#905 review).
 *
 * For one location, two readings, either of which admits the posting:
 *
 * REGION. When either side names no city — a single segment, or a country-led
 * list — it matches if its regions overlap the other side's qualifiers (or
 * regions). This is what places a remote-only board's eligibility field
 * ("USA", "United States", "USA, Canada") for a candidate in Austin, TX, and
 * what lets a region-only query ("California", "CA", "Telangana") keep every
 * posting whose qualifiers name it (#905 review). The overlap is exact after
 * canonicalisation, so a bare "Europe" stays a mismatch for a Berlin, Germany
 * candidate: nothing here knows one contains the other.
 *
 * CITY. Otherwise the city segments must agree and the qualifiers behind them
 * must not conflict — "Austin, TX" matches a feed's "Austin, TX, USA" and
 * "Austin, Texas" without an exact string match, while "Portland, OR" does NOT
 * match "Portland, ME". When the cities differ it falls back to WHOLE-WORD
 * containment either direction, which admits "New York, NY" against "New York
 * City, NY" without admitting a bare "IN" posting against "Austin, TX" the way
 * a raw substring test did.
 *
 * Known limits, every one of them the missing gazetteer: "SF Bay Area" vs "San
 * Francisco, CA" needs an alias table; a city refinement cannot be told from a
 * company name in "Boston Consulting Group, London"; a bare state name is read
 * as the state, so a "New York" posting is kept for a Buffalo, NY candidate
 * (write "New York, NY" for the city — the résumé parser already does); a
 * region-only posting cannot be placed for a query that carries no state or
 * country at all ("Austin" against "USA" is a mismatch); and a bare two-letter
 * qualifier that is both a USPS code and an ISO country code reads as the US
 * state, so "Berlin, DE" is Delaware and does not match "Berlin, Germany"
 * (the registry's #429 precedence; "Paris, FR" and "London, GB" are fine, since
 * no state claims those). All of them fail toward the soft axis, and the
 * never-fail-closed floor below is what keeps any of them from emptying the
 * panel.
 *
 * An EMPTY posting location returns false — a feed that told us nothing about
 * where the job is has not told us it is near you. That is the conservative
 * read for the RATING axis (no evidence, no credit); the hard filter takes the
 * opposite read on the same fact, see `filterPostingsByLocation`.
 */
export function locationMatches(queryLocation: string, postingLocation: string): boolean {
  const offices = postingLocation
    .split(OFFICE_LIST_SEPARATOR)
    .map((office) => office.trim())
    .filter((office) => office.length > 0);
  if (offices.length > 1) {
    return offices.some((office) => locationMatches(queryLocation, office));
  }
  if (isRemotePosting(postingLocation)) return true;
  const posting = place(postingLocation);
  const query = place(queryLocation);
  if (posting === undefined || query === undefined) return false;
  if (
    (posting.regions !== undefined || query.regions !== undefined) &&
    regionsOverlap(posting.regions ?? posting.qualifiers, query.regions ?? query.qualifiers)
  ) {
    return true;
  }
  if (!qualifiersAgree(posting.qualifiers, query.qualifiers)) return false;
  if (posting.city === query.city) return true;
  const postingWords = words(posting.city);
  const queryWords = words(query.city);
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
