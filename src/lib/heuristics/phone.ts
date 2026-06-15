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
 * Region inference from location fields is tracked as Issue B.
 */

import {
  parsePhoneNumberFromString,
  findPhoneNumbersInText,
  type CountryCode,
  type PhoneNumber,
} from "libphonenumber-js/min";
import { PHONE_RE } from "./regex.ts";

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
 * Pre-filter check: returns true if `text` might contain a phone number,
 * using two fast checks before invoking the heavier libphonenumber parser:
 *   1. `PHONE_RE` — catches US/CA 10-digit shapes and common variants.
 *   2. `/\+\d/` — catches E.164 international numbers (`+44 …`, `+1 …`)
 *      whose space-separated groups fall outside PHONE_RE's US-biased pattern.
 */
function mightHavePhone(text: string): boolean {
  PHONE_RE.lastIndex = 0;
  const byUs = PHONE_RE.test(text);
  PHONE_RE.lastIndex = 0;
  if (byUs) return true;
  return /\+\d/.test(text);
}

/**
 * Locate and normalize the first phone number found in `text`.
 *
 * Uses a cheap pre-filter (`PHONE_RE` + `+\d` heuristic): if no digit
 * sequence looks like a phone, the heavier `findPhoneNumbersInText` call
 * is skipped entirely. When a hit is found, the number is formatted per
 * `formatPhoneNumber`.
 *
 * @param text   Full text to search (e.g. the joined contact-header lines).
 * @param region ISO 3166-1 alpha-2 default region. Defaults to `"US"`.
 * @returns `{ formatted, isValid }` for the first hit, or `undefined`.
 */
export function findFirstPhone(
  text: string,
  region: CountryCode = "US",
): PhoneResult | undefined {
  if (!mightHavePhone(text)) return undefined;

  const hits = findPhoneNumbersInText(text, region);
  if (hits.length === 0) return undefined;
  const pn = hits[0].number;
  return { formatted: formatPhoneNumber(pn), isValid: pn.isValid() };
}
