// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

import type { ResumeExperience } from "../../score/types.ts";
import type { PdfSection } from "../sections.ts";
import { parseEntryBlocks } from "../entry-blocks.ts";
import type { EntryBlock } from "../entry-blocks.ts";
import {
  US_LOCATION_RE,
  INTL_LOCATION_RE,
  US_STATE_CODE_RE,
  COUNTRY_GAZETTEER,
  matchSectionHeader,
} from "../regex.ts";
import { looksLikeTitle, looksLikeCompany, finalizeEntries } from "./shared.ts";

// ── Experience ──────────────────────────────────────────────────────────────

/**
 * Split the experience section into entry blocks and extract a
 * `ResumeExperience` row per block. The grouping heuristic:
 *
 *   - A line containing a date range anchors an entry header.
 *   - Non-bullet lines in the 0..2 lines ABOVE the anchor = company / title.
 *   - Bullet lines after the anchor, until the next anchor or section end,
 *     = the description.
 *
 * Fallback for a DATELESS section (#309): when the section carries no date
 * ranges at all, the `date_range` anchor finds nothing and yields zero blocks
 * (the "no date range ⇒ []" contract in `parseEntryBlocks`), collapsing the
 * whole section to zero roles. Re-run with the date-optional `"first_line"`
 * anchor so each `header + bullets` group becomes one dateless role.
 *
 * Confidence is per-entry, then averaged: we report the average of the
 * per-entry confidence as the section-level `experience` confidence.
 */
export function extractExperience(
  experience: PdfSection | undefined,
): { value: ResumeExperience[]; confidence: number } {
  // Split the section into dated entry blocks using the shared primitive, then
  // map each block's header lines into title/company/team and score it. The
  // windowing, date parsing, and bullet-body collection live in
  // `parseEntryBlocks`; this function owns only the experience-specific field
  // mapping (`disambiguateCompanyTitle`) and scoring.
  let blocks = parseEntryBlocks(experience, {
    anchor: "date_range",
    collectBody: true,
    headerLookback: 2,
  });
  // A dateless experience section yields zero `date_range` blocks. Fall back to
  // the `"first_line"` anchor so each header-run + bullet-group is recovered as
  // one dateless role instead of the whole section collapsing to nothing (#309).
  // A résumé with ANY dated role produced ≥1 block above and never reaches here,
  // so `date_range` stays the primary path and dated résumés cannot regress. The
  // date-only-phantom drop and the `title || company` non-empty filter below
  // apply to both paths uniformly.
  if (blocks.length === 0) {
    blocks = parseEntryBlocks(experience, {
      anchor: "first_line",
      collectBody: true,
    });
  }
  // Drop a date-only phantom — a block with neither title nor company (#145).
  // Experience has no single title axis, so we keep a role that has either.
  return finalizeEntries(
    blocks.map(experienceFromBlock),
    (e) => e.title !== "" || e.company !== "",
  );
}

/** Map one dated entry block to a `ResumeExperience` and its confidence score.
 *  Extracted from `extractExperience` to keep each function below the
 *  complexity threshold; mirrors `projectFromBlock` / `achievementFromBlock`. */
function experienceFromBlock(block: EntryBlock): {
  entry: ResumeExperience;
  score: number;
} {
  const { dates } = block;
  const { title, company, team, location } = disambiguateCompanyTitle(
    block.headerLines,
    block.anchorHeaderIndex,
  );
  const description = block.body;

  // Score the entry.
  let score = 0;
  if (dates.start_date) score += 0.25;
  if (dates.end_date || dates.is_current) score += 0.15;
  if (company) score += 0.25;
  if (title) score += 0.2;
  if (block.bulletCount >= 1) score += 0.15;

  return {
    entry: {
      title: title ?? "",
      company: company ?? "",
      ...(team ? { team } : {}),
      ...(location ? { location } : {}),
      ...(dates.start_date ? { start_date: dates.start_date } : {}),
      ...(dates.end_date ? { end_date: dates.end_date } : {}),
      ...(dates.is_current ? { is_current: true } : {}),
      description: description || undefined,
    },
    score: Math.min(score, 1),
  };
}

/** Legal-entity suffix that must NOT be cleaved off as a separate field by the
 *  comma split — "Acme, Inc" is one employer, not "Acme" + a role "Inc". */
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
      !LOCALITY_SUFFIX_RE.test(mSpaceIntl[1])
    ) {
      const before = stripDanglingSeparator(s.slice(0, mSpaceIntl.index));
      if (before)
        return { text: before, location: `${mSpaceIntl[1]}, ${mSpaceIntl[2]}` };
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
 */
function disambiguateCompanyTitle(
  headers: string[],
  anchorIdx?: number,
): {
  company?: string;
  title?: string;
  team?: string;
  location?: string;
} {
  let filtered = headers.filter((h) => h.length > 0);
  if (filtered.length === 0) return {};

  // A header line that is itself a recognized SECTION HEADER (e.g. a second
  // "INVOLVEMENT EXPERIENCE" / "RELEVANT EXPERIENCE" heading) is a section
  // BOUNDARY the windower failed to split on — the section splitter retains a
  // second same-category L2 header as content rather than opening a new section
  // (#258 Layer B), so it lands in the header block of the role directly below
  // it. It is neither company nor title: dropping it stops the role from
  // absorbing the heading string as its company (#310).
  //
  // The boundary is admissible ONLY on a LEADING header line of the block — one
  // with no non-header role content above it. `matchSectionHeader` falls through
  // to the fuzzy anchor-fallback tier (regex.ts), which fires on ANY ≤4-word
  // Title-Case / ALL-CAPS phrase whose last word is an anchor noun (experience,
  // employment, education, …). So a legitimate role TITLE that is such a phrase
  // ("Clinical Research Experience") also matches — but it sits MID-BLOCK, below
  // its own company line ("Mass General Hospital"), whereas a genuine mis-merged
  // inner section header LEADS the entry block (the role's own title/company/date
  // follow below it). Matching only the contiguous leading run of header lines
  // distinguishes the two: the genuine boundary is stripped, the mis-flagged
  // mid-block title is kept so its role is not dropped (#310 false-positive).
  // Everything at or above that leading boundary is the previous entry or the
  // boundary itself, so keep only the lines below it as this role's header.
  let leadsFreshEntry = false;
  let lastBoundary = -1;
  for (let i = 0; i < filtered.length; i++) {
    if (matchSectionHeader(filtered[i]) === null) break;
    lastBoundary = i;
  }
  if (lastBoundary !== -1) {
    filtered = filtered.slice(lastBoundary + 1);
    if (anchorIdx !== undefined) anchorIdx -= lastBoundary + 1;
    leadsFreshEntry = true;
    if (filtered.length === 0) return {};
  }

  // Split any header that has an obvious "Title @ Company", "Title — Company",
  // "Title | Company", "Title · Company" (mid-dot, #217), or guarded
  // "Title, Company" pattern.
  // `via` records HOW a split was cleaved so downstream guards can key on the
  // actual shape, not just "same source line": "delim" = a `@`/`—`/`|`/`·`
  // delimiter split, "comma" = a `splitRoleComma` (role-comma) split, "whole" =
  // an unsplit header line.
  const splits: Array<{
    text: string;
    source: number;
    via: "delim" | "comma" | "whole";
  }> = [];
  filtered.forEach((h, idx) => {
    const atSplit = h.split(/\s+@\s+|\s+—\s+|\s+\|\s+|\s+·\s+/);
    if (atSplit.length > 1) {
      atSplit.forEach((s) =>
        splits.push({ text: s.trim(), source: idx, via: "delim" }),
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

  let company: string | undefined;
  let title: string | undefined;
  let team: string | undefined;

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
    return companyMatchIdxs[0];
  };
  const companyIdx = chooseCompanyIdx();

  if (companyIdx !== -1) {
    company = splits[companyIdx].text;
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
      title = belowTitle.text;
      team = others.find((s) => s !== belowTitle)?.text;
    } else {
      title = others[0]?.text;
      team = others[1]?.text;
    }
  } else {
    // No company suffix — tiebreak on title keywords. If only one of the
    // first two splits looks title-shaped, assign accordingly.
    const firstLooksTitle = splits[0] ? looksLikeTitle(splits[0].text) : false;
    const secondLooksTitle = splits[1] ? looksLikeTitle(splits[1].text) : false;
    if (firstLooksTitle && !secondLooksTitle) {
      title = splits[0]?.text;
      // #372 — "Title, Team" over "Company | Location Dates": splits[0]/splits[1]
      // are a role-comma split of ONE header line (same source, `via: "comma"`),
      // so the post-comma splits[1] is a team/sub-org suffix, not the company.
      // When the anchor (date) line below was delimiter-split into "Company |
      // Location Dates", its leading segment is the real company — take it and
      // demote the post-comma segment to team. Guarded on `via: "comma"` so a
      // same-line `|`/`@`/`·`/`—` delimiter split (also same-source) can't
      // misfire this comma-shape branch. Additive: fires only for the comma-split
      // + delimited-anchor shape; every other case keeps the "Title, Company"
      // default below.
      const isRoleCommaSplit =
        splits[1] !== undefined &&
        splits[0]?.via === "comma" &&
        splits[0]?.source === splits[1].source;
      const anchorSplits =
        anchorIdx !== undefined
          ? splits.filter((s) => s.source === anchorIdx)
          : [];
      const anchorCompany =
        anchorSplits.length >= 2 &&
        !looksLikeLocationTail(anchorSplits[0].text)
          ? anchorSplits[0].text
          : undefined;
      if (isRoleCommaSplit && anchorCompany) {
        company = anchorCompany;
        team = splits[1]?.text;
      } else {
        company = splits[1]?.text;
        team = splits[2]?.text;
      }
    } else if (!firstLooksTitle && secondLooksTitle) {
      // Older convention ("Company / Title"): leave as default.
      company = splits[0]?.text;
      title = splits[1]?.text;
      team = splits[2]?.text;
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
      company = anchorSplit?.text;
      title = titleSplit?.text;
      // A leftover split (an extra anchor-row segment such as a location, or a
      // second above line) becomes team — rescued to `location` below if it is
      // one.
      team = splits.find((s) => s !== anchorSplit && s !== titleSplit)?.text;
    } else {
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
      if (
        aboveSources.length >= 2 &&
        looksLikeTitle(filtered[aboveSources[0]])
      ) {
        title = filtered[aboveSources[0]];
        company = filtered[aboveSources[1]];
        team = splits.find((s) => s.source === anchorIdx)?.text;
      } else {
        // No title-keyword signal and no stacked-shape anchor — assume top line
        // is company (single-line header default).
        company = splits[0]?.text;
        title = splits[1]?.text;
        team = splits[2]?.text;
      }
    }
  }

  // ── Location stripping ────────────────────────────────────────────────────
  // (1) Strip trailing ", City, ST" from company — covers the · case where
  //     "Acme Corp, Springfield, IL" landed wholesale in company.
  let location: string | undefined;
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
    // (3a) Try stripping a trailing location suffix from team — handles the case
    //      where `looksLikeCompany` mis-routed a "Group"/"Systems"/"Labs" segment
    //      as company (e.g. "Platform Group" in
    //      "Title · Globex, Hyderabad, India · Platform Group"), pushing
    //      "Globex, Hyderabad, India" into the team slot. If strip succeeds and
    //      the team isn't itself a bare whole-string location (which the step-3b
    //      check below handles), rotate: remainder → company, old company → team.
    //
    //      Bare-location guard: a string like "Mountain View, CA" would also
    //      satisfy stripLocationSuffix (Pass B yields "Mountain" + "View, CA"),
    //      but it IS already a bare location (US_LOCATION_RE covers the whole
    //      string). Exclude these by checking whether any location regex matches
    //      the FULL string (not just a substring), so "Mountain View, CA"
    //      (full match) vs. "Globex, Hyderabad, India" (INTL_LOCATION_RE only
    //      matches "Globex, Hyderabad", not the full "…India" tail) are
    //      distinguished correctly.
    const teamStrip = stripLocationSuffix(team);
    const teamIsBareLocation = isBareLocationString(team);
    if (teamStrip.location && !teamIsBareLocation) {
      location = teamStrip.location;
      // Rotate: real-company (strip remainder) → company, old company → team.
      team = company;
      company = teamStrip.text;
    } else if (teamIsBareLocation) {
      // (3b) Whole-string bare location check. Uses the SAME shared
      //      `isBareLocationString` predicate as step 3a's rotate-guard and
      //      step 5 — closed-vocabulary (valid state code / gazetteer country),
      //      full-length anchored — so a comma-formatted sub-team/department
      //      whose tail is a generic Title-Case pair ("Buyer, Home Goods",
      //      "Product Owner, Growth Team") is NOT erased into location the way a
      //      raw shape-only `.test()` on US_LOCATION_RE/INTL_LOCATION_RE would
      //      (the #325 false-positive class reached via `team` instead of `title`).
      location = team;
      team = undefined;
    }
  }

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

  // (6) A role that LEADS a fresh entry group — its header block began with a
  //     section-header boundary we stripped in step 0 — has no company yet: the
  //     sole remaining lead line is the role's title (its display name), not its
  //     employer. Flip the default first-line-is-company assignment so a
  //     company-less role under a second experience header keeps `company` empty
  //     (#310). Guarded to the no-title default AND a lead line that carries no
  //     company signal, so a genuinely company-suffixed lead ("Robotics Club
  //     Inc") or a two-line role (title already set) is left untouched.
  if (leadsFreshEntry && company && !title && !looksLikeCompany(company)) {
    title = company;
    company = undefined;
  }

  return { company, title, team, location };
}
