// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import {
  US_LOCATION_RE,
  INTL_LOCATION_RE,
  US_STATE_CODE_RE,
  COUNTRY_GAZETTEER,
  matchSectionHeader,
} from "../regex.ts";
import { looksLikeTitle, looksLikeCompany } from "./shared.ts";

/** The role fields `disambiguateCompanyTitle` maps a header block onto. */
type Fields = {
  company?: string;
  title?: string;
  team?: string;
  location?: string;
};

/** One header segment after splitting. `via` records HOW a split was cleaved so
 *  downstream guards can key on the actual shape, not just "same source line":
 *  "delim" = a `@`/`—`/`|`/`·` delimiter split, "comma" = a `splitRoleComma`
 *  (role-comma) split, "whole" = an unsplit header line. `source` is the index
 *  of the originating header line. */
type Split = {
  text: string;
  source: number;
  via: "delim" | "comma" | "whole";
  /** True when the delim split was cleaved by a `" · "` MIDDOT and no other
   *  delimiter was present on the line — the exporter's one-line
   *  `Title · Company, Location · Team` shape and the #217 "Title · Company"
   *  convention. Lets the no-signal default read the first segment as the TITLE
   *  (not the company), which is what that convention means (#436). */
  middot?: boolean;
};

const LEGAL_SUFFIX_RE =
  /^(inc\.?|llc|l\.l\.c\.?|ltd\.?|corp\.?|co\.?|gmbh|plc|lp|llp|pc|s\.a\.?|n\.a\.?|sa)$/i;

/** Multi-word US cities recognized by BOTH the whole-string `BARE_LOCATION_RE`
 *  (case-insensitive) and the embedded-fold `KNOWN_MULTIWORD_US_CITY_RE`
 *  (case-sensitive Title-case). Single source of truth so the two can't drift
 *  apart. Longest-first so "New York City" wins over "New York" in the embedded
 *  alternation (regex first-match); order is irrelevant for the `^…$`-anchored
 *  `BARE_LOCATION_RE`. */
const MULTIWORD_US_CITY_ALT =
  "New York City|New York|New Orleans|San Francisco|San Diego|San Jose|San Antonio|Los Angeles|Las Vegas|Salt Lake City";

/** Bare city/region names (no "City, ST" state tail, so `US_LOCATION_RE` misses
 *  them) that show up as a `"Title, Location"` header tail — must NOT be cleaved
 *  off as the company. Exact whole-string match keeps a real company that merely
 *  contains a city word ("New York Times", "Boston Consulting") splittable. */
const BARE_LOCATION_RE = new RegExp(
  `^(remote|hybrid|on-?site|${MULTIWORD_US_CITY_ALT}|washington|washington d\\.?c\\.?|boston|chicago|seattle|austin|denver|portland|atlanta|dallas|houston|phoenix|miami|detroit|philadelphia|pittsburgh|minneapolis|nashville|charlotte|columbus|indianapolis|baltimore|sacramento|raleigh|london|paris|berlin|munich|tokyo|singapore|bangalore|bengaluru|mumbai|delhi|hyderabad|toronto|vancouver|sydney|melbourne|dublin|amsterdam)$`,
  "i",
);

/** True when the comma tail reads like a location rather than an employer —
 *  either a "City, ST"/"City, Country" shape, a bare well-known city, or a
 *  lone 2-letter US state code (which occurs when a "City, ST" suffix was
 *  split at the first comma, leaving the city on the title and the state
 *  code as the comma tail). */
function looksLikeLocationTail(after: string): boolean {
  return (
    BARE_LOCATION_RE.test(after) ||
    US_LOCATION_RE.test(after) ||
    INTL_LOCATION_RE.test(after) ||
    US_STATE_CODE_RE.test(after)
  );
}

/**
 * Strip a trailing location segment from a header string and return both the
 * cleaned string and the extracted location.
 *
 * Three passes, tried in order (US state first — tighter closed vocabulary):
 *
 *   Pass A — comma-delimited US "…, City, ST": comma boundary lets the city be
 *     multi-word ("Mountain View", "Santa Clara").
 *   Pass B — space-delimited US "Role … City, ST": single-token city only (no
 *     comma boundary means greedy multi-word would consume role keywords).
 *   Pass C — comma-delimited international "…, City, Country": validates the
 *     trailing token against `COUNTRY_GAZETTEER` (closed ~249-entry ISO set +
 *     colloquial aliases) to avoid false-matching any capitalized word.
 *   Pass D — space-delimited international "…Company City, Country" (#287): the
 *     two-column fold where the location is glued onto the company line with no
 *     comma before the city ("Kasa Seoul, S.Korea"). Single-token city only and
 *     a closed-vocabulary country, mirroring Pass B's US guards; tried last so
 *     the comma-delimited passes win first.
 *
 * Conservative design choices shared by all passes:
 *   - The state/country suffix must be in a closed vocabulary (US_STATE_CODE_RE
 *     for A/B; COUNTRY_GAZETTEER for C) — open-shape regex is not enough.
 *   - Stripping must leave a non-empty remainder so the entire string is never
 *     consumed into location.
 */
/** Trim a trailing field separator (",", "–", "—", "-", "|", "·") left dangling
 *  after a location suffix was peeled off — e.g. "Northwind Robotics – Springfield,
 *  IL" → "Northwind Robotics –" → "Northwind Robotics" (#215, role-first layout
 *  where the company and its city sit on one " – "-joined line below the date). A
 *  legit company never ends in a bare separator, so this only ever cleans the
 *  artifact, never real company text. */
function stripDanglingSeparator(s: string): string {
  return s.replace(/[\s,–—\-|·]+$/, "").trim();
}

/** A comma-delimited intl "city" (Pass C group 1) whose FIRST token is a legal
 *  suffix ("Ltd.") or an all-caps org acronym ("MND") is company text carried
 *  past a company-internal comma — not a city — so that comma is not the
 *  company/city boundary. Reject it in Pass C so the space-delimited Pass D
 *  peels only the real trailing single-token city:
 *  "Omnious. Co., Ltd. Seoul, S.Korea" → company "Omnious. Co., Ltd." +
 *  "Seoul, S.Korea", not company "Omnious. Co." + "Ltd. Seoul, S.Korea" (#287). */
function cityStartsWithCompanyText(city: string): boolean {
  const first = city.split(/\s+/)[0];
  return LEGAL_SUFFIX_RE.test(first) || /^[A-Z]{2,}$/.test(first);
}

/** A single-token Pass-D "city" that is a locality-TYPE generic ("City", "Beach",
 *  "Springs", "Heights", "Town", …) is never a standalone city — it is the
 *  truncated tail of a multi-word place ("Mexico City", "Long Beach", "Cape
 *  Town") whose earlier words the single-token space-fold regex left glued to the
 *  company. Peeling it would mis-split "Google Mexico City, Mexico" into company
 *  "Google Mexico" + location "City, Mexico" — both wrong (#286 review). Defer:
 *  leave the whole string as company rather than fragment a real multi-word city.
 *  (A proper-noun compound like "Buenos Aires" has no generic tell and stays a
 *  known limitation — distinguishing it from a real company+city fold needs a
 *  city gazetteer we don't carry.) */
const LOCALITY_SUFFIX_RE =
  /^(?:city|town|beach|springs?|heights|falls|hills|park|bay|harbou?r|grove|gardens?|valley|shores?)$/i;

/** Closed-vocabulary corporate-name tails. A single-token Pass-D "city" that is
 *  a common corporate suffix noun ("Deutsche Bank", "Cognizant Solutions",
 *  "Acme Group") is the last word of the COMPANY, not a city — peeling it as
 *  location would silently corrupt every multi-word company on a single-column
 *  em-dash header (`Title — Multi-Word Company, Country`, #461). Mirrors
 *  {@link LOCALITY_SUFFIX_RE}'s design: defer when the token matches — a false
 *  negative leaves the string as company (recoverable via inline edit), whereas
 *  the current false-positive silently steals the company's tail into location.
 *  Deliberately closed-set (open-shape "single-word remnant looks wrong" would
 *  over-correct: `Citi Bank` legitimately reduces to `Citi Bank`, and `Citi`
 *  alone is a real company — a one-token-remnant rule would be unsafe.) */
const COMPANY_TAIL_TOKENS_RE =
  /^(?:Bank|Corp|Corporation|Group|Systems|Solutions|Technologies|Studios|Media|Software|Consulting|Partners|Ventures|Holdings|Industries|Financial|Health|Healthcare|Networks|Digital|Analytics|Labs|Ltd|LLC|Inc|GmbH|SA|PLC)$/i;

/** Unambiguous LEGAL-ENTITY markers — a strictly narrower closed vocabulary
 *  than {@link COMPANY_TAIL_TOKENS_RE}, used by `mapTitleFirst` case 3a to
 *  PROMOTE a post-comma segment to `company`. Rationale (PR #483 review): a
 *  DEFERRAL vocab where a false positive is harmless can be broad; a
 *  PROMOTION vocab where a false positive destroys the team AND blocks the
 *  #382 shared-employer banner from being inherited must be strict. Generic
 *  team-name tails (`Systems`, `Analytics`, `Financial`, `Health`, `Media`,
 *  `Digital`, `Labs`, `Solutions`, `Networks`, `Group`) are deliberately
 *  excluded — they legitimately end team names like `Core Systems`,
 *  `Growth Analytics`, `Consumer Health`, `Payments Digital`. */
const COMPANY_LEGAL_TAIL_RE =
  /^(?:Inc\.?|LLC|L\.L\.C\.?|Ltd\.?|GmbH|PLC|Corp\.?|Corporation|Holdings)$/i;

/** Trailing "…, <Country>$" strip used by {@link stripLocationSuffix}'s Pass E
 *  (#461 follow-up). Module-scope so it's built once, matching the siblings
 *  {@link LOCALITY_SUFFIX_RE} / {@link COMPANY_TAIL_TOKENS_RE} /
 *  {@link COMPANY_LEGAL_TAIL_RE}. The captured group must additionally match
 *  the closed COUNTRY_GAZETTEER at the call site — the regex alone is
 *  intentionally shape-only. */
const COUNTRY_ONLY_RE =
  /,\s*([A-Z][A-Za-z.\-]+(?:\s+[A-Z][A-Za-z.\-]+)*)$/;

/** Known multi-word US cities, for the space-delimited "…Company New York, ST"
 *  fold where the location is glued onto the company line with no comma before
 *  the city. Pass B's single-token city rule truncates such a city to its last
 *  word ("…New York, NY" → city "York", company "…New"), so a multi-word city is
 *  admitted here ONLY from this closed vocabulary — an open greedy multi-word
 *  match would eat company/role words ("Greenfield Studios New York" → city
 *  "Studios New York"). Same closed-vocabulary discipline as Pass C/D's country
 *  gazetteer. Longest-first so "New York City" wins over "New York" (regex
 *  alternation is first-match). Shares its city list with `BARE_LOCATION_RE` via
 *  the single-source `MULTIWORD_US_CITY_ALT` const so the two can't drift. */
const KNOWN_MULTIWORD_US_CITY_RE = new RegExp(MULTIWORD_US_CITY_ALT);

/** Recover a location from an anchor-row cell of a "Company | Location Dates"
 *  header line — the "New York, NY" cell of "Globex Financial | New York, NY
 *  August 2024 - Present" (#373). `parseEntryBlocks` runs `stripDateRange` on the
 *  anchor line before it reaches disambiguation, so the cell is a clean bare
 *  "City, ST" / "City, Country" — but the location sits BEFORE the (removed)
 *  dates, so `stripLocationSuffix`'s end-anchored passes never claimed it and it
 *  was dropped. Return the cell when it is a whole-string bare location.
 *
 *  No date-range peel here: this only ever runs on the anchor line, which
 *  `stripDateRange` has already cleared with the same `DATE_RANGE_RE`, so any
 *  glued range is gone before this sees the cell (#409 review). */
function locationFromAnchorCell(cell: string): string | undefined {
  const c = cell.trim();
  return isBareLocationString(c) ? c : undefined;
}

function stripLocationSuffix(s: string): {
  text: string;
  location: string | undefined;
} {
  // Pass A — comma-delimited "…, City, ST": comma boundary lets the city be
  // multi-word (one+ capitalized words).
  const COMMA_LOCATION_RE =
    /,\s*([A-Z][A-Za-z.\-]+(?:\s+[A-Z][A-Za-z.\-]+)*),\s*([A-Z]{2})$/;
  // Pass B-multi — space-delimited "…Company <known multi-word city>, ST": no
  // comma before the city, so a multi-word city is admitted only from the closed
  // `KNOWN_MULTIWORD_US_CITY_RE` vocabulary (an open multi-word match would eat
  // company/role words). Tried before single-token Pass B so "…New York, NY"
  // captures "New York", not "York".
  const SPACE_MULTIWORD_LOCATION_RE = new RegExp(
    `\\s+(${KNOWN_MULTIWORD_US_CITY_RE.source}),\\s*([A-Z]{2})$`,
  );
  // Pass B — space-delimited "Role … City, ST": single-token city only.
  const SPACE_LOCATION_RE = /\s+([A-Z][A-Za-z.\-]+),\s*([A-Z]{2})$/;

  const mUS =
    s.match(COMMA_LOCATION_RE) ??
    s.match(SPACE_MULTIWORD_LOCATION_RE) ??
    s.match(SPACE_LOCATION_RE);
  if (mUS && US_STATE_CODE_RE.test(mUS[2])) {
    // Guard: stripping must leave a non-empty remainder.
    const before = stripDanglingSeparator(s.slice(0, mUS.index));
    if (before) return { text: before, location: `${mUS[1]}, ${mUS[2]}` };
  }

  // Pass C — comma-delimited "…, City, Country" (international). Only fires
  // when the COUNTRY_GAZETTEER is non-empty (graceful fallback when Intl APIs
  // are unavailable keeps this a no-op rather than a false-positive risk).
  if (COUNTRY_GAZETTEER.size > 0) {
    // Country may be multi-word ("United Kingdom", "New Zealand", "South Korea").
    const INTL_SUFFIX_RE =
      /,\s*([A-Z][A-Za-z.\-]+(?:\s+[A-Z][A-Za-z.\-]+)*),\s*([A-Z][A-Za-z.\-]+(?:\s+[A-Z][A-Za-z.\-]+)*)$/;
    const mIntl = s.match(INTL_SUFFIX_RE);
    if (
      mIntl &&
      COUNTRY_GAZETTEER.has(mIntl[2].toLowerCase()) &&
      !cityStartsWithCompanyText(mIntl[1])
    ) {
      const before = stripDanglingSeparator(s.slice(0, mIntl.index));
      if (before) return { text: before, location: `${mIntl[1]}, ${mIntl[2]}` };
    }

    // Pass D — space-delimited international "…Company City, Country" (#287).
    // Two-column templates (Awesome-CV) fold the right-column location onto the
    // company line with no comma between company and city ("Kasa Seoul, S.Korea"),
    // so Pass C (which needs a comma before the city) misses it. This is the
    // space-delimited intl case Pass C deferred: it's admissible here only under
    // the same tight guards Pass B uses for US "City, ST" —
    //   - single-token city (space boundary). A multi-word space-fold city whose
    //     last token is a locality generic ("…City", "…Beach") would otherwise be
    //     truncated to that generic tail and mis-split, so LOCALITY_SUFFIX_RE
    //     defers it ("Google Mexico City, Mexico" stays company, not fragmented),
    //     and
    //   - a closed-vocabulary country (COUNTRY_GAZETTEER), not any capitalized
    //     word — so it fires on a real "City, Country" fold, not on a company
    //     that merely ends in a comma tail.
    // Tried after Pass C so a genuine comma-delimited multi-word city
    // ("…, Mexico City, Mexico") is still captured whole; Pass D then peels the
    // single-token fold Pass C skipped (including the company-internal-comma case
    // "…Co., Ltd. Seoul, S.Korea" that Pass C's guard rejected).
    const SPACE_INTL_RE =
      /\s+([A-Z][A-Za-z.\-]+),\s*([A-Z][A-Za-z.\-]+(?:\s+[A-Z][A-Za-z.\-]+)*)$/;
    const mSpaceIntl = s.match(SPACE_INTL_RE);
    if (
      mSpaceIntl &&
      COUNTRY_GAZETTEER.has(mSpaceIntl[2].toLowerCase()) &&
      !LOCALITY_SUFFIX_RE.test(mSpaceIntl[1]) &&
      // #461 — Pass C's `cityStartsWithCompanyText` guard applies equally here:
      // a legal suffix ("Inc.", "Ltd.") or an org acronym is company text carried
      // past a company-internal comma, not a city. Adding this fixes the
      // "…Ltd., Country" / "…Inc., Country" false-strip Pass C left for Pass D.
      !cityStartsWithCompanyText(mSpaceIntl[1]) &&
      // #461 — a common corporate-name tail ("Bank", "Group", "Solutions") is the
      // last word of the company, not a bare city — peeling it would silently
      // corrupt every multi-word company on `Title — Multi-Word Company, Country`
      // headers. Closed-vocabulary defer (see COMPANY_TAIL_TOKENS_RE).
      !COMPANY_TAIL_TOKENS_RE.test(mSpaceIntl[1])
    ) {
      const before = stripDanglingSeparator(s.slice(0, mSpaceIntl.index));
      if (before)
        return { text: before, location: `${mSpaceIntl[1]}, ${mSpaceIntl[2]}` };
    }

    // Pass E — trailing-COUNTRY-ONLY strip (#461 follow-up). Fires when Passes
    // A–D all deferred and the string still ends in `,\s*<Country>$` — the
    // residual shape a corporate-tail deferral (Pass D) leaves behind. Example:
    // "Deutsche Bank, India" — Pass D defers on "Bank" as a corporate tail
    // (so the last company word isn't stolen), Pass E now peels the bare
    // ", India" tail so company becomes "Deutsche Bank" and location surfaces
    // as "India". Multi-word countries ("United Kingdom", "New Zealand") are
    // admitted only through the closed COUNTRY_GAZETTEER — no open-shape
    // regex — so a `Buyer, Home Goods` job-title tail (Home Goods not a
    // country) is safe. Tried LAST so the richer city+country shapes above
    // still win when they apply. `COUNTRY_ONLY_RE` is hoisted to module scope
    // (PR #483 review) for consistency with its siblings.
    const mCountry = s.match(COUNTRY_ONLY_RE);
    if (mCountry && COUNTRY_GAZETTEER.has(mCountry[1].toLowerCase())) {
      const before = stripDanglingSeparator(s.slice(0, mCountry.index));
      if (before) return { text: before, location: mCountry[1] };
    }
  }

  // Pass F — comma-delimited trailing BARE-LOCATION keyword (#436). The one-line
  // experience exporter joins "Company, Location" into a single middot cell, and
  // when the model's `location` is a work-mode keyword ("Remote", "Hybrid",
  // "On-site") or a bare well-known city with no state/country tail ("London",
  // "Seattle") — the forms `BARE_LOCATION_RE` recognizes but Passes A–E (which
  // all require a "City, ST" / "City, Country" shape) do not — the location bled
  // into `company` on round-trip ("Globex Corporation, Remote"). Peel the tail
  // when it whole-matches the closed `BARE_LOCATION_RE` vocabulary; a real
  // company never ends in a bare ", Remote" / ", London" tail, so the closed set
  // keeps this from stealing company text. Tried LAST so the richer city+state
  // and city+country shapes above still win when they apply.
  const commaF = s.lastIndexOf(",");
  if (commaF > 0) {
    const tail = s.slice(commaF + 1).trim();
    if (BARE_LOCATION_RE.test(tail)) {
      const before = stripDanglingSeparator(s.slice(0, commaF));
      if (before) return { text: before, location: tail };
    }
  }

  return { text: s, location: undefined };
}

/**
 * Split a single "Role, Company" header line into [title, company]. Guarded so
 * it only fires when the part before the comma reads like a job title
 * (`looksLikeTitle`), the part after is not a bare legal suffix, and the part
 * after does not read like a location — so "Office manager, The Phone Company"
 * splits, but "Acme, Inc", "Acme Analytics (…) New York, NY" (no title keyword
 * before the comma), and "Marketing Manager, San Francisco" (location tail) do
 * not. Returns null when no guarded split applies.
 */
function splitRoleComma(h: string): [string, string] | null {
  const comma = h.indexOf(",");
  if (comma <= 0) return null;
  const before = h.slice(0, comma).trim();
  const after = h.slice(comma + 1).trim();
  if (!before || !after) return null;
  if (!looksLikeTitle(before)) return null;
  if (LEGAL_SUFFIX_RE.test(after)) return null;
  if (looksLikeLocationTail(after)) return null;
  return [before, after];
}

/**
 * Split a single "Title – Company" header line on a spaced EN-DASH (–, U+2013)
 * into [title, company]. Word / Google-Docs single-column exports join the role
 * title to the employer with an en-dash, exactly like the em-dash (—, U+2014)
 * the Phase-1 delimiter split already recognizes — the en-dash was simply
 * missing from that alternation, so the whole header collapsed into one segment
 * (title dropped to null, or the company lost to the title).
 *
 * Guarded to leave the line UNSPLIT (returns null) when the tail reads like a
 * bare location: the role-first "Company – City, ST" header (#215/#436) uses the
 * same spaced en-dash to join a company to its trailing city, and that shape is
 * owned by the location-recovery path in {@link recoverLocation}, not by a
 * segment split — cleaving it would strand the city as a phantom company.
 * Requires exactly one en-dash boundary (two segments) so a multi-dash line
 * falls through to the existing paths untouched.
 *
 * Date ranges also use an en-dash, but `parseEntryBlocks` runs `stripDateRange`
 * on every header line before it reaches here, so a spaced en-dash surviving on
 * a header line is a field separator, never a date range.
 */
function splitEnDashTitleCompany(h: string): [string, string] | null {
  const parts = h.split(/\s+–\s+/);
  if (parts.length !== 2) return null;
  const before = parts[0].trim();
  const after = parts[1].trim();
  if (!before || !after) return null;
  if (isBareLocationString(after)) return null;
  return [before, after];
}

/**
 * True when a date-anchor line carries the reconstructed-export org signature —
 * used to gate the anchor-is-company positional tiebreak in
 * {@link disambiguateCompanyTitle} so it fires ONLY on our own reconstructed
 * "Download PDF" export shape, never on a genuine two-line real-résumé header.
 *
 * The ONLY signal is an edge/whitespace-bounded " · " middot marker. Our emit
 * (ats-resume-model.ts) ALWAYS appends it to the company sub-line whenever a role
 * has a title and a date anchor: "Company · Location  Dates" for the with-location
 * case and "Company · Dates" for the location-less case. That middot is a
 * sufficient and unambiguous round-trip signature.
 *
 * Location- and title-keyword-based signals were REMOVED (Phase 4b, #298): on a
 * genuinely ambiguous two-line header ("Company (top) / Title + Dates (bottom)")
 * the anchor line's shape alone can't disambiguate company from title, so every
 * location/comma/keyword heuristic created a symmetric company↔title inversion on
 * generic real résumés (three review rounds). None of them are needed for the
 * round-trip goal — the middot marker covers every reconstructed/corpus case.
 *
 * A neutral anchor (no middot — e.g. "Relationship Banking" or "Acme Widgets,
 * Austin, TX") returns false, so control falls through to the pre-#298 default
 * (company = first line): generic real résumés behave exactly as they did before.
 */
function anchorCarriesOrgSignal(text: string): boolean {
  // A " · " mid-dot (Company · Location) or a trailing " ·" marker (the
  // reconstructed-export signature our own emit appends to a location-less
  // company sub-line, ats-resume-model.ts) — either bounded by whitespace/edge.
  return /(?:^|\s)·(?:\s|$)/.test(text);
}

/**
 * True when `s` is ENTIRELY a bare location string — a lone US state code, a
 * bare well-known city, or a "City, ST" / "City, Country" shape that spans the
 * WHOLE string (not merely a trailing suffix). The full-length check on the
 * US/intl matches distinguishes a self-contained location ("Pomona, CA",
 * "Mountain View, CA") from a company that merely carries a trailing city
 * ("Globex, Hyderabad, India", where INTL_LOCATION_RE matches only a substring).
 *
 * Shape is NOT sufficient — the comma-tail must resolve against a REAL location
 * signal, not merely a "CapWords, CapWords" shape. `US_LOCATION_RE` /
 * `INTL_LOCATION_RE` are generic Title-Case-pair matchers (regex.ts:42/45), so
 * on their own they full-match a comma-formatted job title whose role word is
 * outside the finite `looksLikeTitle` keyword list ("Buyer, Home Goods",
 * "Merchandiser, Footwear", "Barista, Downtown Store"), silently erasing a real
 * title into `location` (the #325 step-5 rescue false-positive class). So each
 * shape branch additionally requires its tail to be in a CLOSED vocabulary — a
 * valid 2-letter USPS code (`US_STATE_CODE_RE`) or a real country
 * (`COUNTRY_GAZETTEER`) — the same closed-vocabulary discipline
 * `stripLocationSuffix` already applies. A generic Title-Case tail
 * ("Home Goods", "Footwear") is in neither set and stays a title.
 *
 * The single shared bare-location predicate in {@link disambiguateCompanyTitle}:
 * the step-3a rotate-guard (negated — a rotatable "Company, City, Country" is
 * NOT a whole-string location), the step-3b `team`→location rescue, and the
 * step-5 `title`→location rescue all route through it, so the same closed-vocab
 * discipline gates every path and no branch can reintroduce the shape-only leak.
 */
function isBareLocationString(s: string): boolean {
  const usLoc = US_LOCATION_RE.exec(s);
  const intlLoc = INTL_LOCATION_RE.exec(s);
  return (
    US_STATE_CODE_RE.test(s) ||
    BARE_LOCATION_RE.test(s) ||
    (usLoc !== null && usLoc[0].length === s.length && US_STATE_CODE_RE.test(usLoc[2])) ||
    (intlLoc !== null &&
      intlLoc[0].length === s.length &&
      COUNTRY_GAZETTEER.has(intlLoc[2].toLowerCase()))
  );
}

/** Result of the leading-section-header strip: the surviving header lines, the
 *  anchor index re-based onto them, and whether a boundary was stripped (which
 *  marks the role as leading a fresh entry group, #310). */
type StripResult = {
  filtered: string[];
  anchorIdx: number | undefined;
  leadsFreshEntry: boolean;
};

/**
 * Phase 0 — drop a mis-merged leading section header (#310).
 *
 * A header line that is itself a recognized SECTION HEADER (e.g. a second
 * "INVOLVEMENT EXPERIENCE" / "RELEVANT EXPERIENCE" heading) is a section
 * BOUNDARY the windower failed to split on — the section splitter retains a
 * second same-category L2 header as content rather than opening a new section
 * (#258 Layer B), so it lands in the header block of the role directly below
 * it. It is neither company nor title: dropping it stops the role from
 * absorbing the heading string as its company (#310).
 *
 * The boundary is admissible ONLY on a LEADING header line of the block — one
 * with no non-header role content above it. `matchSectionHeader` falls through
 * to the fuzzy anchor-fallback tier (regex.ts), which fires on ANY ≤4-word
 * Title-Case / ALL-CAPS phrase whose last word is an anchor noun (experience,
 * employment, education, …). So a legitimate role TITLE that is such a phrase
 * ("Clinical Research Experience") also matches — but it sits MID-BLOCK, below
 * its own company line ("Mass General Hospital"), whereas a genuine mis-merged
 * inner section header LEADS the entry block (the role's own title/company/date
 * follow below it). Matching only the contiguous leading run of header lines
 * distinguishes the two: the genuine boundary is stripped, the mis-flagged
 * mid-block title is kept so its role is not dropped (#310 false-positive).
 * Everything at or above that leading boundary is the previous entry or the
 * boundary itself, so keep only the lines below it as this role's header.
 */
function stripLeadingSectionHeaders(
  headers: string[],
  anchorIdx: number | undefined,
): StripResult {
  let filtered = headers.filter((h) => h.length > 0);
  let idx = anchorIdx;
  let leadsFreshEntry = false;

  let lastBoundary = -1;
  for (let i = 0; i < filtered.length; i++) {
    if (matchSectionHeader(filtered[i]) === null) break;
    lastBoundary = i;
  }
  if (lastBoundary !== -1) {
    filtered = filtered.slice(lastBoundary + 1);
    if (idx !== undefined) idx -= lastBoundary + 1;
    leadsFreshEntry = true;
  }
  return { filtered, anchorIdx: idx, leadsFreshEntry };
}

/**
 * Phase 1 — split each header line into segments.
 *
 * Split any header that has an obvious "Title @ Company", "Title — Company"
 * (em-dash), "Title – Company" (en-dash, via {@link splitEnDashTitleCompany}),
 * "Title | Company", "Title · Company" (mid-dot, #217), or guarded
 * "Title, Company" pattern.
 */
function splitHeaderSegments(filtered: string[]): Split[] {
  const splits: Split[] = [];
  filtered.forEach((h, idx) => {
    const atSplit = h.split(/\s+@\s+|\s+—\s+|\s+\|\s+|\s+·\s+/);
    if (atSplit.length > 1) {
      // A PURE-middot line ("Title · Company · Team") — the exporter's one-line
      // shape (#436). Excludes a line that also carries `@`/`—`/`|`, which follow
      // other ordering conventions.
      const middot = /\s+·\s+/.test(h) && !/\s+[@—|]\s+/.test(h);
      atSplit.forEach((s) =>
        splits.push({ text: s.trim(), source: idx, via: "delim", middot }),
      );
      return;
    }
    const enDash = splitEnDashTitleCompany(h);
    if (enDash) {
      enDash.forEach((s) =>
        splits.push({ text: s, source: idx, via: "delim", middot: false }),
      );
      return;
    }
    const roleComma = splitRoleComma(h);
    if (roleComma) {
      roleComma.forEach((s) =>
        splits.push({ text: s, source: idx, via: "comma" }),
      );
      return;
    }
    splits.push({ text: h, source: idx, via: "whole" });
  });
  return splits;
}

/**
 * Phase 2 — map the split segments onto company/title/team.
 *
 * See {@link disambiguateCompanyTitle} for the full priority order. In brief: a
 * single company-suffix match is decisive (`mapWithCompanyMatch`); otherwise the
 * mapping tiebreaks on title keywords and anchor position
 * (`mapWithoutCompanyMatch`).
 */
function mapSegmentsToFields(
  splits: Split[],
  filtered: string[],
  anchorIdx: number | undefined,
): Fields {
  // Every split that reads like a company/institution (its index in `splits`).
  const companyMatchIdxs = splits
    .map((s, i) => (looksLikeCompany(s.text) ? i : -1))
    .filter((i) => i >= 0);
  // The stacked-header positional tiebreak is available only when the anchor
  // (date) line is known AND at least one split sits ABOVE it (a title line) —
  // i.e. a real two-line "Title \n Company Dates" shape, not a single header
  // line where everything shares the anchor row.
  const hasAbove =
    anchorIdx !== undefined &&
    anchorIdx > 0 &&
    splits.some((s) => s.source < anchorIdx);

  // The anchor-is-company positional tiebreak below (else-if) must NOT fire on a
  // genuine "Company (top) / Title + Dates (bottom)" résumé where the anchor line
  // is the TITLE and neither line carries any lexical tell — e.g. "Northern Trust"
  // over "Relationship Banking  Jan 2019 – Mar 2021". There, treating the anchor
  // as the company inverts the roles (company↔title swap, #298 review). Gate it on
  // the anchor line carrying a positive "this line is the org/company" signal
  // ({@link anchorCarriesOrgSignal}): a " · " reconstructed-export separator, an
  // embedded location / country, or a role/title keyword (the anchor of the
  // stacked shapes our own reconstructed export and dense/two-column source
  // layouts produce). A fully neutral anchor (no separator, no location, no title
  // keyword) has no such corroboration, so we fall through to the old default
  // (company = first line) — the only case this narrows, and one no corpus fixture
  // exercises, so every round-trip that relied on the tiebreak stays intact.
  const anchorHasReconstructedSignature =
    anchorIdx !== undefined &&
    anchorIdx >= 0 &&
    anchorIdx < filtered.length &&
    anchorCarriesOrgSignal(filtered[anchorIdx]);

  // Choose which split is the company. A single company-suffix match is a
  // decisive content signal (rule 1). When MULTIPLE splits look like a company,
  // the plain findIndex would pick the topmost — which mis-labels the title line
  // as the company whenever the title carries a soft company-suffix word
  // ("Solutions Engineer"). Break that tie with the anchor position: the
  // date-bearing line is the company (#298). No above line ⇒ keep findIndex.
  const chooseCompanyIdx = (): number => {
    if (companyMatchIdxs.length <= 1) return companyMatchIdxs[0] ?? -1;
    if (hasAbove) {
      const anchorMatch = companyMatchIdxs.find(
        (i) => splits[i].source === anchorIdx,
      );
      if (anchorMatch !== undefined) return anchorMatch;
    }
    // #436 (truncation root) — a single-line MIDDOT header "Title · Company"
    // (no line above) where BOTH segments read like a company: the title carries
    // a SOFT company word ("Solutions Engineer" → `Solutions`) and the real
    // company carries a HARD legal-entity marker ("Acme Cloud, Inc." → `Inc.`).
    // Without `hasAbove` the anchor tiebreak can't fire, so the topmost
    // `companyMatchIdxs[0]` (the title) would be mis-labelled the company,
    // swapping title↔company — the #495 middot title-first default never runs
    // because `companyIdx !== -1` routes to `mapWithCompanyMatch`. Prefer the
    // hard-legal segment: it is a strictly stronger company signal than a soft
    // keyword. `COMPANY_LEGAL_TAIL_RE` is the same strict promotion vocab
    // `mapTitleFirst` case 3a uses; a soft-only tie keeps the topmost default.
    //
    // GATED to the exact export shape — every company-match on ONE source line
    // that split as `middot` — so a stacked two-line header (matches on
    // different sources) and a non-middot single line are untouched. When the
    // topmost match is itself the hard-legal one, `find` returns it and the
    // result equals the default, so no extra guard is needed. Without this gate
    // the preference
    // fired on genuine two-column/stacked layouts and stole the company (#436
    // review).
    const allMatchesShareMiddotLine =
      companyMatchIdxs.every(
        (i) =>
          splits[i].source === splits[companyMatchIdxs[0]].source &&
          splits[i].middot,
      );
    if (allMatchesShareMiddotLine) {
      const hardLegalIdx = companyMatchIdxs.find((i) =>
        COMPANY_LEGAL_TAIL_RE.test(
          splits[i].text.trim().split(/[\s,]+/).pop() ?? "",
        ),
      );
      if (hardLegalIdx !== undefined) return hardLegalIdx;
    }
    return companyMatchIdxs[0];
  };
  const companyIdx = chooseCompanyIdx();

  if (companyIdx !== -1) {
    return mapWithCompanyMatch(splits, companyIdx, anchorIdx);
  }
  return mapWithoutCompanyMatch(
    splits,
    filtered,
    anchorIdx,
    hasAbove,
    anchorHasReconstructedSignature,
  );
}

/** Phase 2a — a split carries a company suffix, so it is the company; the rest
 *  is the title/team. */
function mapWithCompanyMatch(
  splits: Split[],
  companyIdx: number,
  anchorIdx: number | undefined,
): Fields {
  const company = splits[companyIdx].text;
  const others = splits.filter((_, i) => i !== companyIdx);
  // #342 — "Company [— Dept] — Location  Dates \n Title": the company sits on
  // the anchor (date) row and the TITLE is the line BELOW it. Prefer a
  // below-anchor split that reads like a title as the role title. Without
  // this, an anchor-row segment (the location, or a department) takes the
  // title slot via `others[0]` and the real below-anchor title is demoted to
  // `team` or dropped. Symmetric to the "title above" tiebreak (#298), for the
  // inverse title-below-anchor layout. Additive: when no such split exists the
  // `else` keeps the exact prior mapping, so only the broken case changes.
  const belowTitle =
    anchorIdx !== undefined
      ? others.find((s) => s.source > anchorIdx && looksLikeTitle(s.text))
      : undefined;
  if (belowTitle) {
    return {
      company,
      title: belowTitle.text,
      team: others.find((s) => s !== belowTitle)?.text,
    };
  }
  return { company, title: others[0]?.text, team: others[1]?.text };
}

/**
 * Phase 2b-i — the first split reads like a title and the second does not:
 * "Title, Team" over "Company | Location Dates" (#372).
 *
 * splits[0]/splits[1] are a role-comma split of ONE header line (same source,
 * `via: "comma"`), so the post-comma splits[1] is a team/sub-org suffix, not the
 * company. When the anchor (date) line below was delimiter-split into "Company |
 * Location Dates", its leading segment is the real company — take it and demote
 * the post-comma segment to team. Guarded on `via: "comma"` so a same-line
 * `|`/`@`/`·`/`—` delimiter split (also same-source) can't misfire this
 * comma-shape branch. Additive: fires only for the comma-split + delimited-anchor
 * shape; every other case keeps the "Title, Company" default.
 */
function mapTitleFirst(splits: Split[], anchorIdx: number | undefined): Fields {
  const title = splits[0]?.text;
  const isRoleCommaSplit =
    splits[1] !== undefined &&
    splits[0]?.via === "comma" &&
    splits[0]?.source === splits[1].source;
  // Case 1 (#372) — anchor line is delim-split ("Company | Location Dates")
  // BELOW the Title, Team comma-split. Company is the leading DELIM segment on
  // the anchor line. Restricted to `via === "delim"` so an anchor-line
  // comma-split (Title, Team ON the anchor row — cases 2/3 below) does NOT
  // read its own title as the company via `anchorSplits[0]`.
  const anchorSplits =
    anchorIdx !== undefined ? splits.filter((s) => s.source === anchorIdx) : [];
  const anchorDelimSplits = anchorSplits.filter((s) => s.via === "delim");
  const anchorCompany =
    anchorDelimSplits.length >= 2 &&
    !looksLikeLocationTail(anchorDelimSplits[0].text)
      ? anchorDelimSplits[0].text
      : undefined;
  if (isRoleCommaSplit && anchorCompany) {
    return { company: anchorCompany, title, team: splits[1]?.text };
  }
  // The anchor line IS itself the Title, Team comma-split — the date sits on
  // the same line as the comma-split header (cases 2/3 below), rather than on
  // a separate delim-split line below it (case 1 above).
  const anchorIsCommaSplit =
    isRoleCommaSplit &&
    anchorIdx !== undefined &&
    splits[0]?.source === anchorIdx;
  // Case 2 (#466) — anchor is Title, Team with dates on it; the real employer
  // sits on a line BELOW the anchor, typically delim-split into
  // "Company | Location [Dept]". Prefer the leading delim-split segment of the
  // first below-anchor delim-split source as the company, and demote the
  // post-comma splits[1] to team. Location is recovered downstream by
  // `recoverLocation`'s step 3c (extended for below-anchor cells).
  if (anchorIsCommaSplit) {
    const belowDelimGroups = new Map<number, Split[]>();
    for (const s of splits) {
      if (s.source > anchorIdx && s.via === "delim") {
        const arr = belowDelimGroups.get(s.source) ?? [];
        arr.push(s);
        belowDelimGroups.set(s.source, arr);
      }
    }
    const sortedSources = [...belowDelimGroups.keys()].sort((a, b) => a - b);
    for (const src of sortedSources) {
      const group = belowDelimGroups.get(src)!;
      if (group.length >= 2 && !looksLikeLocationTail(group[0].text)) {
        return { company: group[0].text, title, team: splits[1]?.text };
      }
    }
  }
  // Case 3a (#466 follow-up) — anchor is Title, Team with no below-anchor
  // employer, but the post-comma segment ITSELF ends in an unambiguous
  // legal-entity marker (`Inc.`, `LLC`, `Ltd.`, `GmbH`, `PLC`, `Corp.`,
  // `Corporation`, `Holdings`). Fixes the dogfooding case where
  // "Software Engineer, Ridgemont Holdings" fell into case 3, mirrored the
  // title into company, then the backstop cleared it.
  //
  // Post-review narrowing (PR #483): the earlier version of this branch reused
  // `COMPANY_TAIL_TOKENS_RE` — a DEFERRAL vocabulary where a false positive is
  // harmless (Pass D just leaves the string as company). Here a false positive
  // is DESTRUCTIVE: it promotes team to company and clears team, and
  // `isBannerContinuation` (extract/experience.ts) then early-returns on the
  // missing team so the shared-banner employer never inherits either. That
  // regressed shapes like "Senior Engineer, Growth Analytics" under a
  // `Wingtip Financial Inc.` banner — three fields worse than main. The two
  // decisions need different vocabularies: use closed legal-entity markers
  // here (unambiguous employer signal), leave the broader Pass D deferral
  // vocab alone. Case 3 below still handles the generic post-comma-is-team
  // shape and lets the banner propagator inherit correctly.
  if (anchorIsCommaSplit && splits[1]?.text) {
    const lastToken = splits[1].text.trim().split(/\s+/).pop() ?? "";
    if (COMPANY_LEGAL_TAIL_RE.test(lastToken)) {
      return { company: splits[1].text, title, team: undefined };
    }
  }
  // Case 3 (#382) — anchor is Title, Team on the same line as its date, with
  // NO below-anchor employer line to draw from: a bare shared-banner
  // continuation ("Senior Engineer, Payments Core Jul 2022 - Aug 2024"). The
  // post-comma segment is a team/sub-org, not the employer. Keep it as `team`
  // so `propagateSharedEmployer` (extract/experience.ts) can inherit the
  // banner into `company`; mirror the title into `company` so
  // `isBannerContinuation`'s `company === title` branch fires the same way it
  // did before #466 gained the delim-only anchor restriction. If no banner is
  // active, the `disambiguateCompanyTitle` end-of-pipeline backstop clears
  // the mirrored company back to undefined so the miss reads as a miss.
  if (anchorIsCommaSplit) {
    return { company: title, title, team: splits[1]?.text };
  }
  // Case 4 — plain "Title, Company" over a bare date-only line below (#372's
  // negative-regression contract): the post-comma segment IS the employer.
  return { company: splits[1]?.text, title, team: splits[2]?.text };
}

/** Phase 2b — no company suffix anywhere; tiebreak on title keywords and anchor
 *  position (#372, #298, #346). */
function mapWithoutCompanyMatch(
  splits: Split[],
  filtered: string[],
  anchorIdx: number | undefined,
  hasAbove: boolean,
  anchorHasReconstructedSignature: boolean,
): Fields {
  // No company suffix — tiebreak on title keywords. If only one of the
  // first two splits looks title-shaped, assign accordingly.
  const firstLooksTitle = splits[0] ? looksLikeTitle(splits[0].text) : false;
  const secondLooksTitle = splits[1] ? looksLikeTitle(splits[1].text) : false;
  if (firstLooksTitle && !secondLooksTitle) {
    return mapTitleFirst(splits, anchorIdx);
  } else if (!firstLooksTitle && secondLooksTitle) {
    // Older convention ("Company / Title"): leave as default.
    return {
      company: splits[0]?.text,
      title: splits[1]?.text,
      team: splits[2]?.text,
    };
  } else if (hasAbove && anchorHasReconstructedSignature) {
    // No title-keyword signal either way, but the anchor line carries the
    // reconstructed-export signature (a " · " on the date line) — so this is
    // our own "Title \n Company · Location Dates" export shape: the anchor
    // (date) line is the company and the line(s) above it are the title. This
    // preserves the mapping our reconstructed export was built from, WITHOUT
    // the old blind "anchor line is company" swap that inverted a genuine
    // "Company \n Title Dates" résumé lacking the signature (#298 review).
    const anchorSplit = splits.find((s) => s.source === anchorIdx);
    const titleSplit = splits.find((s) => s.source < anchorIdx!);
    return {
      company: anchorSplit?.text,
      title: titleSplit?.text,
      // A leftover split (an extra anchor-row segment such as a location, or a
      // second above line) becomes team — rescued to `location` below if it is
      // one.
      team: splits.find((s) => s !== anchorSplit && s !== titleSplit)?.text,
    };
  }
  // #346 — stacked "Title / Company / Dates+Location" where the company
  // name itself carries a title keyword ("Globex Assistant"), so
  // `looksLikeCompany` finds no employer and BOTH above lines read as
  // titles. When ≥2 header lines sit ABOVE a pure date/location anchor and
  // the topmost reads like a title, positional order wins: top = title, the
  // next line = company (kept WHOLE so a comma descriptor stays with the
  // company, not cleaved into the title), and the anchor's location routes
  // via team-rescue below. Without this the default inverts them (top =
  // company) and the comma-split orphans the location. `filtered[src]` is
  // the original line, so the company keeps its "…, descriptor" tail.
  const aboveSources =
    anchorIdx !== undefined
      ? [
          ...new Set(
            splits.filter((s) => s.source < anchorIdx).map((s) => s.source),
          ),
        ].sort((a, b) => a - b)
      : [];
  if (aboveSources.length >= 2 && looksLikeTitle(filtered[aboveSources[0]])) {
    return {
      title: filtered[aboveSources[0]],
      company: filtered[aboveSources[1]],
      team: splits.find((s) => s.source === anchorIdx)?.text,
    };
  }
  // No title-keyword signal and no stacked-shape anchor. Default: the top line is
  // the company (the stacked "Company \n Title" convention the parser inherited).
  //
  // EXCEPTION (#436) — a single-line MIDDOT header follows the OPPOSITE ordering:
  // "Title · Company" ("Composer · Northwind Ensemble"). That is the exporter's
  // one-line shape AND the dominant single-line résumé convention (#217), so a
  // neutral two-segment middot split (no company/title keyword either side) must
  // read the FIRST segment as the title — otherwise the exported header re-parses
  // title↔company swapped and no round-trip holds. Guarded to a pure-middot split
  // whose two segments share one source, so pipe/em-dash/@/stacked shapes keep the
  // company-first default.
  if (
    splits[0]?.middot &&
    splits[1] !== undefined &&
    splits[0].source === splits[1].source
  ) {
    return {
      title: splits[0].text,
      company: splits[1].text,
      team: splits[2]?.text,
    };
  }
  return {
    company: splits[0]?.text,
    title: splits[1]?.text,
    team: splits[2]?.text,
  };
}

/**
 * Step 3 — rescue a location that landed in the `team` slot.
 *
 * (3a) Try stripping a trailing location suffix from team — handles the case
 *      where `looksLikeCompany` mis-routed a "Group"/"Systems"/"Labs" segment
 *      as company (e.g. "Platform Group" in
 *      "Title · Globex, Hyderabad, India · Platform Group"), pushing
 *      "Globex, Hyderabad, India" into the team slot. If strip succeeds and
 *      the team isn't itself a bare whole-string location (which the step-3b
 *      check below handles), rotate: remainder → company, old company → team.
 *
 *      Bare-location guard: a string like "Mountain View, CA" would also
 *      satisfy stripLocationSuffix (Pass B yields "Mountain" + "View, CA"),
 *      but it IS already a bare location (US_LOCATION_RE covers the whole
 *      string). Exclude these by checking whether any location regex matches
 *      the FULL string (not just a substring), so "Mountain View, CA"
 *      (full match) vs. "Globex, Hyderabad, India" (INTL_LOCATION_RE only
 *      matches "Globex, Hyderabad", not the full "…India" tail) are
 *      distinguished correctly.
 *
 * (3b) Whole-string bare location check. Uses the SAME shared
 *      `isBareLocationString` predicate as step 3a's rotate-guard and step 5 —
 *      closed-vocabulary (valid state code / gazetteer country), full-length
 *      anchored — so a comma-formatted sub-team/department whose tail is a
 *      generic Title-Case pair ("Buyer, Home Goods", "Product Owner, Growth
 *      Team") is NOT erased into location the way a raw shape-only `.test()` on
 *      US_LOCATION_RE/INTL_LOCATION_RE would (the #325 false-positive class
 *      reached via `team` instead of `title`).
 *
 * Caller only invokes this when there is no location yet and `team` is set.
 */
function rescueTeamLocation(
  company: string | undefined,
  team: string | undefined,
): { company?: string; team?: string; location?: string } {
  if (!team) return { company, team };
  const teamStrip = stripLocationSuffix(team);
  const teamIsBareLocation = isBareLocationString(team);
  if (teamStrip.location && !teamIsBareLocation) {
    // Rotate: real-company (strip remainder) → company, old company → team.
    return { company: teamStrip.text, team: company, location: teamStrip.location };
  }
  if (teamIsBareLocation) {
    return { company, team: undefined, location: team };
  }
  return { company, team };
}

/**
 * Phase 3 — recover and normalize the location.
 *
 * Peels a trailing location off company/title (steps 1–2), rescues a
 * location that landed in `team` (step 3), and recovers a bare location from
 * an anchor-row cell of a "Company | Location Dates" line (#373, step 3c).
 */
function recoverLocation(
  fields: Fields,
  splits: Split[],
  anchorIdx: number | undefined,
): Fields {
  let { company, title, team, location } = fields;

  // (1) Strip trailing ", City, ST" from company — covers the · case where
  //     "Acme Corp, Springfield, IL" landed wholesale in company.
  if (company) {
    const r = stripLocationSuffix(company);
    if (r.location) {
      company = r.text;
      location = r.location;
    }
  }

  // (2) Strip trailing " City, ST" from title — covers the two-line case where
  //     the title line carries a trailing location ("Software Eng Intern Bellevue, WA").
  //     The guard in looksLikeLocationTail now also catches a bare state-code tail,
  //     so the comma-split no longer fires on "...Bellevue, WA" — but the location
  //     is still embedded in the title string and needs to be peeled off here.
  if (title && !location) {
    const r = stripLocationSuffix(title);
    if (r.location) {
      title = r.text;
      location = r.location;
    }
  }

  // (3) If team is a bare location segment (e.g. a state code peeled off before
  //     looksLikeLocationTail was fixed, or a "City, ST" segment from a ·-split),
  //     rescue it as location and clear team.  Only fire when we have no location yet.
  if (!location && team) {
    const rescued = rescueTeamLocation(company, team);
    company = rescued.company;
    team = rescued.team;
    location = rescued.location;
  }

  // (3c) #373 — recover a per-entry location from an anchor-row cell that folds
  //      "<City, ST> <dates>" with no separator ("Globex Financial | New York,
  //      NY August 2024 - Present" — the second `|` cell). The date parse already
  //      took the range into `block.dates`, but the location residue never
  //      reached a field. Scan the anchor line's non-company segments; if one
  //      yields a bare location once the date range is peeled, use it (and clear
  //      the segment from `team` if it landed there).
  //
  //      #466 EXTENSION — also scan below-anchor DELIM segments for a location.
  //      The Title,Team + next-line employer shape ("SE II, Payments Platform
  //      Aug 2024 - Present" / "Globex Financial | Chicago, IL  Dept") lands the
  //      city on the employer line, not the anchor. Below-anchor delim cells are
  //      structurally identical to the anchor-line delim cell #373 recovers
  //      from, so the same `locationFromAnchorCell` guard applies. A
  //      column-gap-folded "City, ST  Dept" cell is additionally split on 2+
  //      spaces so the location cell is reached inside a delim-split segment
  //      that couldn't cleanly separate the columns.
  //
  //      PR #483 review — also scan below-anchor WHOLE cells (a bare "City, ST"
  //      line on its own, no delimiters). This is the shape the exporter emits
  //      for an empty-company role with a location (see the `emptyCompanySubLine`
  //      branch in ats-resume-model.ts) — the subLine renders `City, ST` on its
  //      own row below `Title, Team [Dates]`, and buildEntryBlock pushes it into
  //      `belowHeaderLines` as a `via: "whole"` split. Without this branch the
  //      subLine content was captured into headerLines but not surfaced as
  //      `location`, breaking round-trip on empty-company + location roles.
  if (!location && anchorIdx !== undefined) {
    for (const s of splits) {
      // Anchor-line cells (existing behavior), OR below-anchor delim cells
      // (#466), OR below-anchor whole cells that read as a bare location.
      const isAnchorCell = s.source === anchorIdx;
      const isBelowDelim = s.source > anchorIdx && s.via === "delim";
      const isBelowWholeLoc =
        s.source > anchorIdx &&
        s.via === "whole" &&
        isBareLocationString(s.text);
      if (!isAnchorCell && !isBelowDelim && !isBelowWholeLoc) continue;
      // Skip the company and the title cells: a location cell that landed in
      // `title` is the empty-title "Company · City, ST" export shape, which
      // step 5 rescues correctly (title → "", location set) — claiming it here
      // would set `location` and block that rescue, orphaning the location in
      // `title`. Only an unused/team location cell is claimed here.
      if (s.text === company || s.text === title) continue;
      let loc = locationFromAnchorCell(s.text);
      if (!loc && isBelowDelim) {
        // Column-gap fold: a "City, ST  Dept" cell where the delim regex
        // couldn't split the columns because only a `\s{2,}` gap separates
        // them. Split on the column gap and check each part.
        const parts = s.text
          .split(/\s{2,}/)
          .map((p) => p.trim())
          .filter((p) => p.length > 0);
        for (const p of parts) {
          const c = locationFromAnchorCell(p);
          if (c) {
            loc = c;
            break;
          }
        }
      }
      if (loc) {
        location = loc;
        if (team === s.text) team = undefined;
        break;
      }
    }
  }

  return { company, title, team, location };
}

/**
 * Phase 4 — clean field-separator artifacts and rescue a title that is itself a
 * bare location (steps 4, 4b, 5).
 */
function cleanFieldArtifacts(fields: Fields): Fields {
  let { company, title, location } = fields;
  const { team } = fields;

  // (4) Strip the reconstructed-export " ·" org-signature marker that our own
  //     "Download PDF" appends to a location-less company sub-line so the anchor
  //     re-parses as the company (see `anchorCarriesOrgSignal` and the emit in
  //     ats-resume-model.ts). It survives as a trailing dangling middot on an
  //     otherwise clean company ("Leadership Experience ·"); peel it back off so
  //     the round-tripped company field matches the source. A genuine company
  //     never ends in a bare middot, so this only ever removes the marker.
  if (company) company = company.replace(/\s*·\s*$/, "").trim() || undefined;

  // (4b) Strip a field-separator glyph left dangling on the TITLE after header
  //      splitting. The `·`/`|`/`—`-split above only fires on a separator with
  //      whitespace on BOTH sides, so a two-line "Title ·" / "Company … Dates"
  //      header (WeasyPrint-Cairo, #348) — where the title line ends in a bare
  //      trailing "·" (no company on the same row to split against) — keeps the
  //      glyph glued to the title. A real title never ends in a bare separator,
  //      so `stripDanglingSeparator` only ever removes the residue.
  if (title) title = stripDanglingSeparator(title) || undefined;

  // (5) A title that is ENTIRELY a bare location string is a title-less role, not
  //     a real title. Our own empty-title-role export (ats-resume-model.ts) emits
  //     "Company · City, ST" on a SINGLE header line for a role with no title (the
  //     title-less branch of the experience map): the " · " split makes the
  //     location the second segment, and with no title line above the date anchor
  //     it lands in `title` here instead of `team`, so the `team`→location rescue
  //     in step 3 never sees it and the location is lost while "City, ST" corrupts
  //     the title (#325). A genuine job title is never a bare "City, ST" /
  //     "City, Region" / bare city, so rescue it: the location is the location and
  //     the role keeps no title (which `experienceFromBlock` renders as ""). The
  //     `!location` guard leaves a normal titled role — whose "City, ST" already
  //     became `team`→location above — untouched, and the FULL-string match (via
  //     `isBareLocationString`) leaves a title with a mere trailing location
  //     ("… Intern, Bellevue, WA", peeled by step 2) unaffected. The real
  //     shape-vs-semantics guard lives inside `isBareLocationString`: it now
  //     requires the comma tail to resolve against a CLOSED vocabulary (a valid
  //     USPS code or a real country), so a "CapWords, CapWords" job title whose
  //     role word is outside the finite `looksLikeTitle` list ("Buyer, Home
  //     Goods", "Merchandiser, Footwear") no longer full-matches as a bare
  //     location and keeps its title. The leading `!looksLikeTitle` check is a
  //     cheap belt-and-suspenders early-out for the keyword-bearing titles
  //     ("Marketing Manager, San Francisco").
  if (title && !location && !looksLikeTitle(title) && isBareLocationString(title)) {
    location = title;
    title = undefined;
  }

  return { company, title, team, location };
}

/**
 * Phase 5 — trailing company/title guard (#310, step 6).
 *
 * A role that LEADS a fresh entry group — its header block began with a
 * section-header boundary we stripped in phase 0 — has no company yet: the
 * sole remaining lead line is the role's title (its display name), not its
 * employer. Flip the default first-line-is-company assignment so a
 * company-less role under a second experience header keeps `company` empty
 * (#310). Guarded to the no-title default AND a lead line that carries no
 * company signal, so a genuinely company-suffixed lead ("Robotics Club
 * Inc") or a two-line role (title already set) is left untouched.
 */
function applyTrailingCompanyGuard(
  fields: Fields,
  leadsFreshEntry: boolean,
): Fields {
  const { company, title, team, location } = fields;
  if (leadsFreshEntry && company && !title && !looksLikeCompany(company)) {
    return { company: undefined, title: company, team, location };
  }
  return fields;
}

/**
 * Given 1..3 header lines, decide which is the company and which is the title.
 * Heuristics (in priority order):
 *   - If one looks like a company/institution (legal suffix OR "University",
 *     "College", … — see `looksLikeCompany`) and is not itself a title, that's
 *     the company; the rest is the title. This fires on the common stacked
 *     "Designation / University / Dates" student-resume shape, which the old
 *     suffix-only check missed (it has no "Inc"/"LLC").
 *   - Else if one looks like a title (role/level keyword) and the other
 *     doesn't, the title-keyword one is the title.
 *   - Otherwise the first line (top of the entry) is the company.
 *   - Team is an optional third piece, often separated by "—", ",", or "|".
 *
 * Single-line `·`-delimited headers ("Title · Company, City, ST · Team", #217)
 * are tokenized here into up to three segments before the tiebreaker runs, so
 * the title and company are extracted rather than staying glued together. The
 * location embedded in the company segment ("Company, City, ST" or intl
 * "Company, City, Country") is stripped by `stripLocationSuffix`.
 *
 * `anchorIdx` (optional) is the index within `headers` of the line that carried
 * the date anchor — the company/org line in a stacked "Title \n Company Dates"
 * header (see {@link EntryBlock.anchorHeaderIndex}). It is used ONLY as a
 * structural TIEBREAK when the text-content heuristics above can't decide (the
 * default `first-line-is-company` path, and the case where MORE THAN ONE header
 * line reads as a company): the anchor line is the company and the line above it
 * is the title. This is what lets our own reconstructed "Download PDF" export —
 * whose experience block is a bare title header over a `Company · Location Dates`
 * sub-line — re-segment back to the SAME title/company it was built from, even
 * when neither content heuristic fires (both lines look like a company, e.g. a
 * "Solutions Engineer" title carrying the soft company-suffix word "Solutions";
 * or both look like a title, e.g. a two-column source parse that assigned the
 * org name as the title). A decisive content signal (exactly one company suffix,
 * or exactly one title keyword) still wins, so genuine source layouts are
 * unaffected (#298).
 *
 * The function is a thin orchestrator over the phase helpers above: strip a
 * mis-merged leading section header (#310) → split each header line into
 * segments → map the segments onto fields → recover/normalize the location →
 * apply the trailing company/title guard.
 */
export function disambiguateCompanyTitle(
  headers: string[],
  anchorIdx?: number,
): Fields {
  const strip = stripLeadingSectionHeaders(headers, anchorIdx);
  if (strip.filtered.length === 0) return {};
  const splits = splitHeaderSegments(strip.filtered);
  const mapped = mapSegmentsToFields(splits, strip.filtered, strip.anchorIdx);
  const located = recoverLocation(mapped, splits, strip.anchorIdx);
  const cleaned = cleanFieldArtifacts(located);
  const guarded = applyTrailingCompanyGuard(cleaned, strip.leadsFreshEntry);
  // #466 backstop — a `company` byte-identical to `title` is never correct: it
  // means an upstream branch mirrored the title into the company slot when no
  // real employer signal was found. Clear it so the miss reads as a miss
  // (blank company, recoverable via inline edit) rather than as bad data the
  // user has to notice. Cheap and precise: exact-equality only, so a
  // legitimately similar name ("Software Inc." title in a "Software Inc."
  // company slot — vanishingly rare) is the only theoretical hit.
  if (guarded.company && guarded.company === guarded.title) {
    return { ...guarded, company: undefined };
  }
  return guarded;
}
