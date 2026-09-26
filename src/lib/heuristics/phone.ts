// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * Phone number recognition, validation, and formatting helpers.
 *
 * Wraps `libphonenumber-js/min` (smaller metadata bundle) for robust
 * multi-locale parsing, with `PHONE_RE` from `./regex.ts` as a cheap
 * pre-filter so the heavier libphonenumber call is skipped when the
 * text clearly contains no digit sequence worth parsing.
 *
 * Callers receive a `{ formatted, isValid }` tuple:
 *   - `formatted` — a clean, human-readable string ready for display
 *     (national form for US numbers, international form for others).
 *   - `isValid` — whether libphonenumber considers the number valid.
 *     Currently informational only; consumed by future Issue C (scoring).
 *
 * Default region is "US" throughout the tier 1 / tier 1.5 pipeline.
 * Region inference from location fields is implemented via `regionFromLocation`
 * and wired into `extractContact` in extract-fields.ts.
 */

import {
  parsePhoneNumberFromString,
  findPhoneNumbersInText,
  type CountryCode,
  type PhoneNumber,
} from "libphonenumber-js/min";
import {
  PHONE_RE,
  US_LOCATION_RE,
  INTL_LOCATION_RE,
  YEAR_SHAPE,
} from "./regex.ts";

// ── Region inference ─────────────────────────────────────────────────────────

/**
 * Explicit country-name → ISO 3166-1 alpha-2 mapping for the most common
 * non-US locales seen on international résumés. Extend as needed; the list
 * is intentionally small to keep the bundle tiny (no i18n dependency).
 *
 * Key: lowercased country name as it appears after the comma in a location
 * string matched by INTL_LOCATION_RE (e.g. "London, United Kingdom" → "united kingdom").
 */
const COUNTRY_TO_REGION: Record<string, CountryCode> = {
  "united kingdom": "GB",
  "uk": "GB",
  "england": "GB",
  "scotland": "GB",
  "wales": "GB",
  "india": "IN",
  "canada": "CA",
  "australia": "AU",
  "germany": "DE",
  "france": "FR",
  "netherlands": "NL",
  "singapore": "SG",
  "ireland": "IE",
  "new zealand": "NZ",
  "brazil": "BR",
  "mexico": "MX",
  "japan": "JP",
  "china": "CN",
  "south korea": "KR",
  "korea": "KR",
  "sweden": "SE",
  "norway": "NO",
  "denmark": "DK",
  "finland": "FI",
  "switzerland": "CH",
  "austria": "AT",
  "spain": "ES",
  "italy": "IT",
  "portugal": "PT",
  "poland": "PL",
  "israel": "IL",
  "pakistan": "PK",
  "bangladesh": "BD",
  "nigeria": "NG",
  "south africa": "ZA",
  "kenya": "KE",
  "ghana": "GH",
  "egypt": "EG",
  "uae": "AE",
  "united arab emirates": "AE",
  "saudi arabia": "SA",
  "hong kong": "HK",
  "taiwan": "TW",
  "indonesia": "ID",
  "malaysia": "MY",
  "thailand": "TH",
  "philippines": "PH",
  "vietnam": "VN",
  "argentina": "AR",
  "chile": "CL",
  "colombia": "CO",
};

/**
 * Derive a libphonenumber-js region code from a candidate location string
 * (as extracted by US_LOCATION_RE / INTL_LOCATION_RE in extract-fields.ts).
 *
 * - A US_LOCATION_RE match (City, XX where XX is a 2-letter US state abbr) → "US".
 * - An INTL_LOCATION_RE match whose country tail maps in COUNTRY_TO_REGION → that code.
 * - Anything else (unrecognised country, no match) → `undefined` (callers
 *   should fall back to "US").
 *
 * @param location The raw location string, e.g. "San Francisco, CA" or
 *                 "London, United Kingdom". May be undefined/empty.
 *                 Three-part "City, State, Country" strings (e.g. "Bengaluru,
 *                 Karnataka, India") do not map — INTL_LOCATION_RE captures
 *                 only the first comma-segment as the country tail.
 * @returns An ISO 3166-1 alpha-2 CountryCode, or `undefined` if unmapped.
 */
export function regionFromLocation(
  location: string | undefined,
): CountryCode | undefined {
  if (!location) return undefined;

  // Try the INTL table first — covers both full country names ("United Kingdom")
  // and known 2-letter abbreviations like "UK" that would otherwise be caught
  // by US_LOCATION_RE (which matches any 2-uppercase-letter token after a comma).
  const intlMatch = INTL_LOCATION_RE.exec(location);
  if (intlMatch) {
    const countryTail = intlMatch[2].trim().toLowerCase();
    const mapped = COUNTRY_TO_REGION[countryTail];
    if (mapped) return mapped;
  }

  // US check: "City, ST" where ST is exactly 2 uppercase letters and not a
  // known international abbreviation (already handled above).
  const usMatch = US_LOCATION_RE.exec(location);
  if (usMatch) return "US";

  return undefined;
}

/** Result shape returned by both public helpers. */
export interface PhoneResult {
  /** Clean, locale-appropriate display string. */
  formatted: string;
  /**
   * Whether libphonenumber considers the number valid for its country.
   * Informational only — scoring still uses presence-only semantics (Issue C).
   */
  isValid: boolean;
}

/**
 * Format a PhoneNumber instance consistently:
 *   - US/CA → national form, e.g. `(408) 372-6626`
 *   - Everything else → international form, e.g. `+44 20 7946 0958`
 */
function formatPhoneNumber(pn: PhoneNumber): string {
  return pn.country === "US" || pn.country === "CA"
    ? pn.formatNational()
    : pn.formatInternational();
}

/**
 * Parse and normalize a single raw phone string.
 *
 * @param raw    The raw matched string (may include punctuation).
 * @param region ISO 3166-1 alpha-2 default region. Defaults to `"US"`.
 * @returns `{ formatted, isValid }` or `undefined` if the string cannot be
 *          parsed into a possible phone number.
 */
export function normalizePhone(
  raw: string,
  region: CountryCode = "US",
): PhoneResult | undefined {
  const pn = parsePhoneNumberFromString(raw, region);
  // isPossible() is a fast structural length check. Rejects "123", "+1123",
  // etc. without the overhead of full validation metadata lookup.
  if (!pn || !pn.isPossible()) return undefined;
  return { formatted: formatPhoneNumber(pn), isValid: pn.isValid() };
}

/**
 * Pre-filter check: returns true if `text` might contain a phone number.
 *
 * Two fast checks are applied before invoking the heavier libphonenumber parser:
 *   1. `PHONE_RE` — catches US/CA 10-digit shapes and common variants.
 *   2. `/\+\d/` — catches E.164 international numbers (`+44 …`, `+1 …`)
 *      whose space-separated groups fall outside PHONE_RE's US-biased pattern.
 *
 * For non-US regions the pre-filter is relaxed to any 7+ total digits across
 * the string, because national-format numbers (e.g. UK `020 7946 0958`,
 * India `098765 43210`) do not match PHONE_RE and carry no `+` prefix.
 */
function mightHavePhone(text: string, region: CountryCode): boolean {
  // Some templates (Word/LaTeX) use a Unicode dash as the digit-group
  // separator, e.g. "(718) 555–0100" with an en-dash (U+2013). PHONE_RE's
  // separator class is ASCII-only, so fold en/em/figure dashes to "-" for
  // this cheap pre-gate only. `findPhoneNumbersInText` parses the Unicode
  // forms natively, so the matcher itself needs no change.
  const ascii = text.replace(/[‒–—]/g, "-");
  PHONE_RE.lastIndex = 0;
  const byUs = PHONE_RE.test(ascii);
  PHONE_RE.lastIndex = 0;
  if (byUs) return true;
  if (/\+\d/.test(text)) return true;
  // For non-US regions, accept text containing 7+ total digits as a candidate
  // to pass to libphonenumber. National-format numbers (e.g. UK "020 7946 0958",
  // India "098765 43210") are space-separated so no single run of 6+ digits
  // exists; counting all digits is the reliable pre-filter. The heavier
  // libphonenumber parser is the authoritative validity gate.
  if (region !== "US") return (text.replace(/\D/g, "").length >= 7);
  return false;
}

/**
 * A 4-digit token shaped like a plausible résumé year — 1900 through 2099.
 * Narrower than bare `\d{4}`: an 8-digit international number is often
 * grouped as two 4-digit runs (Hong Kong `2872-1234`, or the trailing
 * `2345-6789` of a Taiwanese `02-2345-6789`), and those runs land outside
 * this range far more often than a real date does — #480 caught both
 * rejected outright by the un-narrowed version. Reuses `regex.ts`'s
 * `YEAR_SHAPE` fragment rather than re-deriving the `(19|20)` prefix.
 */
const RESUME_YEAR = YEAR_SHAPE;

/**
 * One numeric date anchor: `MM.YYYY`, `MM/YYYY`, `MM-YYYY`, or a bare
 * `YYYY` — where `YYYY` must be {@link RESUME_YEAR}-shaped, not just any
 * 4 digits (see {@link FABRICATED_DATE_RANGE_RE}). The `MM` side is capped
 * at two digits before the separator — a real phone number's area code /
 * exchange groups run 3+ digits, so they can never fit this shape.
 *
 * Carries a bare top-level `|` — same footgun `regex.ts`'s `DATE_ANCHOR`
 * docblock warns about. Any consumer MUST wrap it in a non-capturing group
 * before anchoring (`^(?:${NUMERIC_DATE_ANCHOR})$`), else `^`/`$` bind only
 * to the first alternative.
 */
const NUMERIC_DATE_ANCHOR = `\\d{1,2}[./-]${RESUME_YEAR}|${RESUME_YEAR}`;

/**
 * Rejects a candidate phone span that IS a date range, rather than
 * allow-listing punctuation.
 *
 * `findPhoneNumbersInText` doesn't stop at word boundaries — it will fold
 * digits across arbitrary punctuation into one candidate number and hand
 * back whichever span happens to validate. Given "(555) 018-2390" (invalid:
 * 555 isn't a real NANP area code) followed by a "06/2017 – 03/2021" date
 * range, it skips the invalid header number and returns a *valid* number
 * fabricated from the date's digits ("2017 – 03/2021" → (201) 703-2021) —
 * see #480. The same fabrication happens with a `.`-separated range
 * ("11.2022 – 05.2020"), and neither punctuation mark can simply be banned:
 * `/` is a real area-code separator in some locales (German `030/12345678`),
 * and `.` folds harmlessly into `mightHavePhone`'s pre-filter too. So the
 * gate checks the matched span's SHAPE instead of its characters: two
 * numeric anchors joined by a dash-family separator, each either a bare
 * {@link RESUME_YEAR} or an `MM` + {@link RESUME_YEAR} pair, is a date range
 * and nothing else — a real number's digit groups are always either
 * unbroken, split into 3+-digit groups, or (see {@link RESUME_YEAR}) land
 * outside the plausible-year window.
 */
const FABRICATED_DATE_RANGE_RE = new RegExp(
  `^\\s*(?:${NUMERIC_DATE_ANCHOR})\\s*[‒–—-]\\s*(?:${NUMERIC_DATE_ANCHOR})\\s*$`,
);

/**
 * A span shaped like a bare `YYYY - YYYY` range, with NEITHER side carrying
 * an `MM` prefix. Unlike the `MM`-prefixed anchors (whose 3+ digit area-code
 * groups can never collide with a real number), this bare shape can BE a
 * real phone number in non-NANP locales: several group an 8-digit number as
 * two bare 4-digit runs (Hong Kong `2019 2021`), and when both runs happen
 * to be {@link RESUME_YEAR}-shaped it is indistinguishable from a
 * fabricated date range by shape alone. NANP regions (US/CA) have no such
 * native grouping — an area code is always 3 digits — so this shape is
 * unambiguous only there.
 */
const BARE_YEAR_RANGE_RE = new RegExp(
  `^\\s*${RESUME_YEAR}\\s*[‒–—-]\\s*${RESUME_YEAR}\\s*$`,
);

/**
 * Whether `span` should be rejected as a fabricated date range for `region`.
 *
 * Mirrors `mightHavePhone`'s NANP/non-NANP split (phone.ts:204): outside
 * NANP-like regions (US/CA), a bare `YYYY - YYYY` span is not rejected,
 * because it may be a real number (see {@link BARE_YEAR_RANGE_RE}) — every
 * other shape `FABRICATED_DATE_RANGE_RE` matches (an `MM`-prefixed anchor on
 * at least one side) is still rejected everywhere.
 */
function isFabricatedDateRange(span: string, region: CountryCode): boolean {
  if (!FABRICATED_DATE_RANGE_RE.test(span)) return false;
  if (region === "US" || region === "CA") return true;
  return !BARE_YEAR_RANGE_RE.test(span);
}

/**
 * Locate and normalize the first phone number found in `text`.
 *
 * Uses a cheap pre-filter (`PHONE_RE` + `+\d` heuristic, relaxed for non-US
 * regions): if no digit sequence looks like a phone, the heavier
 * `findPhoneNumbersInText` call is skipped entirely. Of the hits found, the
 * first one whose matched span is NOT a fabricated date range
 * (`isFabricatedDateRange`) wins.
 *
 * @param text   Full text to search (e.g. the joined contact-header lines).
 * @param region ISO 3166-1 alpha-2 default region. Defaults to `"US"`.
 * @returns `{ formatted, isValid }` for the first hit, or `undefined`.
 */
export function findFirstPhone(
  text: string,
  region: CountryCode = "US",
): PhoneResult | undefined {
  if (!mightHavePhone(text, region)) return undefined;

  const hits = findPhoneNumbersInText(text, region);
  const hit = hits.find(
    (h) => !isFabricatedDateRange(text.slice(h.startsAt, h.endsAt), region),
  );
  if (!hit) return undefined;
  const pn = hit.number;
  return { formatted: formatPhoneNumber(pn), isValid: pn.isValid() };
}
