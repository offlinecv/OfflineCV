// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

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
import { PHONE_RE, US_LOCATION_RE, INTL_LOCATION_RE } from "./regex.ts";

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
  PHONE_RE.lastIndex = 0;
  const byUs = PHONE_RE.test(text);
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
 * Locate and normalize the first phone number found in `text`.
 *
 * Uses a cheap pre-filter (`PHONE_RE` + `+\d` heuristic, relaxed for non-US
 * regions): if no digit sequence looks like a phone, the heavier
 * `findPhoneNumbersInText` call is skipped entirely. When a hit is found,
 * the number is formatted per `formatPhoneNumber`.
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
  if (hits.length === 0) return undefined;
  const pn = hits[0].number;
  return { formatted: formatPhoneNumber(pn), isValid: pn.isValid() };
}
