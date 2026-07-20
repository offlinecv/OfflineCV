// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * ISO-3166 country registry for structuring the trailing token of a free-form
 * location string into JSON Resume's `countryCode` (#429). Mirrors the
 * `PROFILE_HOSTS` convention (`contact/profile-registry.ts`): a single ordered
 * data table plus small pure lookups, so adding a country is a ONE-LINE change.
 *
 * Two directions, kept consistent so `location string → structured → string`
 * round-trips losslessly for the canonical spelling of each country:
 *   - forward  ({@link countryCodeForToken}): a country NAME / alias → alpha-2
 *     `countryCode` (e.g. "UK" / "United Kingdom" → "GB").
 *   - reverse  ({@link countryDisplayName}): alpha-2 → the ONE canonical display
 *     name used to reconstruct the string. Canonical names are the résumé-common
 *     form ("USA", "UK"), NOT the ISO long form, so `"San Francisco, CA, USA"`
 *     and `"London, UK"` reconstruct byte-identically.
 *
 * ── The 2-letter ambiguity (deliberate precedence) ──────────────────────────────
 * A bare 2-letter trailing token is FAR more often a US state than the same-
 * lettered ISO country on a résumé ("San Francisco, CA" = California, not Canada;
 * "Atlanta, GA" = Georgia the state, not Gabon; "Mumbai, IN" = Indiana collision).
 * So the caller ({@link toJsonResumeLocation}) treats any token that is a US state
 * (by 2-letter code OR full name, see {@link isUsStateToken}) as `region` and
 * never as a country. To reinforce that at the data layer, this registry's
 * forward table maps ONLY spelled-out names and unambiguous short forms
 * ("USA"/"UK"/"UAE") — it deliberately contains NO bare alpha-2 keys, so a
 * Canadian-province token like "NL" (Newfoundland) or "PE" (PEI) can never be
 * mis-read as Netherlands / Peru. A spelled-out country name is the only way a
 * token becomes a `countryCode`.
 */

interface CountryRule {
  /** ISO 3166-1 alpha-2 code — the value emitted as `countryCode`. */
  code: string;
  /** Canonical display name for reverse reconstruction (résumé-common form). */
  name: string;
  /** Extra spellings recognized on the forward path (besides `name`). */
  aliases?: readonly string[];
}

/**
 * Ordered country rules. To support a new country, add one line. Keep `name` the
 * form most résumés actually write (so the string round-trips losslessly), and
 * put every other accepted spelling in `aliases`. Do NOT add a bare 2-letter
 * alias that collides with a US state or Canadian province code (see header).
 */
const COUNTRIES: readonly CountryRule[] = [
  { code: "US", name: "USA", aliases: ["United States", "United States of America", "U.S.", "U.S.A.", "US"] },
  { code: "GB", name: "UK", aliases: ["United Kingdom", "Great Britain", "Britain", "England", "Scotland", "Wales", "Northern Ireland", "U.K.", "UK"] },
  { code: "CA", name: "Canada" },
  { code: "MX", name: "Mexico" },
  { code: "AU", name: "Australia" },
  { code: "NZ", name: "New Zealand" },
  { code: "IE", name: "Ireland" },
  { code: "FR", name: "France" },
  { code: "DE", name: "Germany", aliases: ["Deutschland"] },
  { code: "ES", name: "Spain" },
  { code: "PT", name: "Portugal" },
  { code: "IT", name: "Italy" },
  { code: "NL", name: "Netherlands", aliases: ["Holland", "The Netherlands"] },
  { code: "BE", name: "Belgium" },
  { code: "CH", name: "Switzerland" },
  { code: "AT", name: "Austria" },
  { code: "SE", name: "Sweden" },
  { code: "NO", name: "Norway" },
  { code: "DK", name: "Denmark" },
  { code: "FI", name: "Finland" },
  { code: "PL", name: "Poland" },
  { code: "CZ", name: "Czech Republic", aliases: ["Czechia"] },
  { code: "GR", name: "Greece" },
  { code: "RU", name: "Russia", aliases: ["Russian Federation"] },
  { code: "UA", name: "Ukraine" },
  { code: "RO", name: "Romania" },
  { code: "HU", name: "Hungary" },
  { code: "IN", name: "India" },
  { code: "CN", name: "China" },
  { code: "JP", name: "Japan" },
  { code: "KR", name: "South Korea", aliases: ["Korea", "Republic of Korea"] },
  { code: "SG", name: "Singapore" },
  { code: "HK", name: "Hong Kong" },
  { code: "TW", name: "Taiwan" },
  { code: "MY", name: "Malaysia" },
  { code: "ID", name: "Indonesia" },
  { code: "TH", name: "Thailand" },
  { code: "VN", name: "Vietnam" },
  { code: "PH", name: "Philippines" },
  { code: "PK", name: "Pakistan" },
  { code: "BD", name: "Bangladesh" },
  { code: "LK", name: "Sri Lanka" },
  { code: "NP", name: "Nepal" },
  { code: "AE", name: "UAE", aliases: ["United Arab Emirates", "U.A.E."] },
  { code: "SA", name: "Saudi Arabia" },
  { code: "IL", name: "Israel" },
  { code: "TR", name: "Turkey", aliases: ["Türkiye", "Turkiye"] },
  { code: "EG", name: "Egypt" },
  { code: "ZA", name: "South Africa" },
  { code: "NG", name: "Nigeria" },
  { code: "KE", name: "Kenya" },
  { code: "GH", name: "Ghana" },
  { code: "BR", name: "Brazil", aliases: ["Brasil"] },
  { code: "AR", name: "Argentina" },
  { code: "CL", name: "Chile" },
  { code: "CO", name: "Colombia" },
  { code: "PE", name: "Peru" },
];

/** Lowercased alias → alpha-2, built once from {@link COUNTRIES}. */
const CODE_BY_ALIAS: ReadonlyMap<string, string> = (() => {
  const m = new Map<string, string>();
  for (const c of COUNTRIES) {
    m.set(c.name.toLowerCase(), c.code);
    for (const a of c.aliases ?? []) m.set(a.toLowerCase(), c.code);
  }
  return m;
})();

/** alpha-2 → canonical display name, built once from {@link COUNTRIES}. */
const NAME_BY_CODE: ReadonlyMap<string, string> = (() => {
  const m = new Map<string, string>();
  for (const c of COUNTRIES) m.set(c.code, c.name);
  return m;
})();

/**
 * Resolve a trailing location token to an ISO alpha-2 `countryCode`, or
 * `undefined` when it is not a recognized country name/alias. Case- and
 * whitespace-insensitive.
 */
export function countryCodeForToken(token: string): string | undefined {
  return CODE_BY_ALIAS.get(token.trim().toLowerCase());
}

/**
 * Canonical display name for an alpha-2 `countryCode` (reverse of
 * {@link countryCodeForToken}), or `undefined` for a code we don't carry.
 */
export function countryDisplayName(code: string): string | undefined {
  return NAME_BY_CODE.get(code.trim().toUpperCase());
}

/**
 * US states, both 2-letter USPS codes and full names (lowercased), including DC.
 * The trailing-token guard that keeps "…, CA" / "…, Georgia" as `region` rather
 * than mis-reading it as a country (Canada / Gabon-code / etc.).
 */
const US_STATES: ReadonlySet<string> = new Set(
  [
    // 2-letter USPS codes
    "al", "ak", "az", "ar", "ca", "co", "ct", "de", "fl", "ga", "hi", "id",
    "il", "in", "ia", "ks", "ky", "la", "me", "md", "ma", "mi", "mn", "ms",
    "mo", "mt", "ne", "nv", "nh", "nj", "nm", "ny", "nc", "nd", "oh", "ok",
    "or", "pa", "ri", "sc", "sd", "tn", "tx", "ut", "vt", "va", "wa", "wv",
    "wi", "wy", "dc",
    // full names
    "alabama", "alaska", "arizona", "arkansas", "california", "colorado",
    "connecticut", "delaware", "florida", "georgia", "hawaii", "idaho",
    "illinois", "indiana", "iowa", "kansas", "kentucky", "louisiana", "maine",
    "maryland", "massachusetts", "michigan", "minnesota", "mississippi",
    "missouri", "montana", "nebraska", "nevada", "new hampshire", "new jersey",
    "new mexico", "new york", "north carolina", "north dakota", "ohio",
    "oklahoma", "oregon", "pennsylvania", "rhode island", "south carolina",
    "south dakota", "tennessee", "texas", "utah", "vermont", "virginia",
    "washington", "west virginia", "wisconsin", "wyoming",
    "district of columbia",
  ],
);

/**
 * True when a trailing token is a US state (2-letter code or full name). Such a
 * token is always kept as `region`, never resolved to a country — the deliberate
 * precedence that disambiguates "CA" (California) from Canada (#429).
 */
export function isUsStateToken(token: string): boolean {
  return US_STATES.has(token.trim().toLowerCase());
}
