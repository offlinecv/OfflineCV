// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * company-search-link.ts — one-click deep links into a self-hosted employer's
 * OWN careers-search page, prefilled with the user's current query (#691).
 *
 * WHY A SECOND, SEPARATE REGISTRY. `company-registry.ts` maps a company to a
 * Greenhouse/Lever/Ashby board WE can fetch and rank postings from. This
 * registry answers a different question — where does a HUMAN search this
 * company's own site — for the large self-hosted-careers employers (Apple,
 * Google, Meta, …) that `company-registry.ts` structurally cannot hold (see
 * that module's corrected docblock: the boundary is CORS, not a missing
 * endpoint). A company can be in neither, either, or both registries, so
 * folding this into `CompanyEntry` as an optional field would invite a row
 * that half-populates and a call site that forgets which half it got —
 * deliberately kept apart instead.
 *
 * NO EGRESS IS ADDED. `buildCompanySearchUrl` / `buildCompanySearchLinks` are
 * pure string assembly — nothing here fetches. The query terms reach the
 * employer only when the USER clicks and their own browser navigates, with
 * their own session, exactly like `deep-links.ts`'s LinkedIn/Indeed/Google
 * Jobs links.
 *
 * WHY THIS DOES NOT REUSE `buildKeywords`. It did, on the reasoning that one
 * derivation with two renderers cannot drift. That was the wrong seam, and it
 * shipped a link that returned nothing. `buildKeywords` composes the
 * BROADENING phrase — seniority + every title + the top skills — which #539
 * chose for a major board's OR-weighted keyword field. An employer's own
 * careers box is the other shape: a single-intent full-text query, the same
 * shape `providers/keywords.ts` already refuses to stack titles into, and for
 * the same stated reason. So this composes `searchPhrase` — the primary
 * (most-recent) title, or the top few skills when the résumé yielded no title
 * — and shares with `deep-links.ts` only `stripSearchOperators`, which is
 * correct for every destination. Measured against the live Apple search on
 * 2026-07-30 with a real résumé's query: the union phrase returned zero
 * postings and `search=Sr. Engineering Manager` returned 600+.
 *
 * The two paths are now genuinely different derivations, so the drift the old
 * docblock claimed to prevent is real and is the reason `company-search-
 * link.test.ts` pins this one's output directly rather than by comparison.
 *
 * A COMPANY WITH NO QUERY SUPPORT still gets a working link: `queryParam` /
 * `locationParam` are optional, and `buildCompanySearchUrl` only sets a param
 * that is BOTH declared supported AND has a non-empty term — never an empty
 * `?q=`. Degraded (a static careers-search URL), never broken.
 *
 * PER-DESTINATION QUERY DIALECT (#697). A working link is not the same as a
 * useful one. #691's links opened a real, non-empty results page whose results
 * were mostly wrong — the failure nobody notices, because nothing on the page
 * says the query was bad. Measured live against `jobs.apple.com/en-us/search`
 * on 2026-07-31, `sort=relevance`, with a real leadership résumé's derived
 * query (primary title `Sr. Engineering Manager`, location `Santa Clara Valley`):
 *
 *   search=                     location=                          count  top of page
 *   Engineering Manager         (none)                              600+  AU-Senior Manager, UK-Senior
 *                                                                         Manager — RETAIL store managers
 *   "Engineering Manager"       (none)                               120  all genuine Engineering Manager
 *   "engineering manager"       united-states-USA                     92  all genuine EM
 *   Sr. Engineering Manager     santa-clara-valley-cupertino-SCV     243  8/8 individual contributors —
 *                                                                         Sr Messages Infrastructure
 *                                                                         Engineer, Sr. Software QA
 *                                                                         Engineer, Sr Software Engineer
 *                                                                         AI & Data Platforms
 *   software engineering manager santa-clara-valley-cupertino-SCV    244  8/8 ICs — Software Engineer -
 *                                                                         Capture, Software Engineer,
 *                                                                         Observability
 *   "engineering manager"       santa-clara-valley-cupertino-SCV       3  3/3 genuine EM — Engineering
 *                                                                         Manager Field Diagnostics,
 *                                                                         Engineering Manager App Insights,
 *                                                                         Customer Experience Engineering
 *                                                                         Team Manager
 *   "Sr. Engineering Manager"   santa-clara-valley-cupertino-SCV       0  —
 *   "Sr. Engineering Manager"   (none)                                 3  3/3 genuine Sr EM
 *   (none)                      Santa Clara Valley  (FREE TEXT)        0  "There are no results that
 *                                                                         match your search."
 *
 * Three defects fall out of that table, and each one is the justification for
 * exactly one field on the Apple row below:
 *
 *  1. `phraseQuote` — an unquoted phrase is OR/fuzzy. Apple scores each bare
 *     token independently, so `Manager` alone drags in retail store managers
 *     and `Sr.` alone drags in every senior IC. Quoting forces a phrase/
 *     proximity match: 600+ → 120, and the noise leaves the top of the page.
 *     The match stays LOOSE, not literal — `"Sr. Engineering Manager"` still
 *     matched `Senior Engineering Manager - RAD`, and `"engineering manager"`
 *     still matched `Customer Experience Engineering Team Manager` — so it
 *     narrows precision without clamping to an exact substring.
 *  2. `dropSeniorityPrefix` — a leading seniority modifier poisons the phrase.
 *     `Sr.` is the single worst token in this query: unquoted it returns 243
 *     results whose entire first page is senior ICs, and quoted *plus* a metro
 *     location it returns zero. Seniority is a filter dimension, not part of
 *     the role phrase, and `JobQuery.seniority` already derives it separately.
 *  3. `locationSlugs` — a free-text location is not merely ignored, it returns
 *     a hard zero (last row). Apple's `location=` reads a closed vocabulary.
 *     So the Apple row can only gain a `locationParam` TOGETHER with the slug
 *     table; adding the param alone would have shipped a zero-results bug
 *     strictly worse than the one #691 had to fix.
 *
 * MEASURED-OR-NOTHING. These rules are per-destination, not universal — the
 * same lesson as the ` - ` operator bug fixed on PR #696, where a rule true for
 * one careers box was not true for the next. So a rule attaches ONLY to the row
 * it was measured against, and an unmeasured row keeps its pre-#697 behaviour
 * byte-for-byte (pinned as a test, not left to convention):
 *
 *   Apple    — MEASURED (table above)   → phraseQuote + dropSeniorityPrefix + locationSlugs
 *   Netflix  — MEASURED 2026-07-31, and ONLY on a phrase carrying NO seniority prefix:
 *              bare `engineering manager` + `location=Los Gatos` → 40 results; quoted
 *              → 13, identical top-5 in the same order. Free-text location works, so
 *              NO slug table.
 *              NOT measured here: a quoted phrase that still carries a seniority
 *              modifier. That is the shape the Apple table records as a hard ZERO
 *              alongside a location (`"Sr. Engineering Manager"` + metro → 0), and
 *              Netflix has no `dropSeniorityPrefix` to remove the modifier first — so
 *              `phraseQuote` DECLINES on such a phrase and Netflix keeps its pre-#697
 *              unquoted output there (see `applyPhraseDialect`).
 *                                                       → phraseQuote only
 *   Amazon   — UNMEASURED (results are client-rendered, invisible to a plain fetch);
 *              `loc_query` predates this and is unverified for quality → no dialect
 *   Google   — UNMEASURED (client-rendered)                            → no dialect
 *   Meta     — UNMEASURED                                              → no dialect
 *   Tesla    — UNMEASURED                                              → no dialect
 *
 * Confirming the four unmeasured destinations needs a real browser pass. Until
 * that happens they get nothing — a dialect added on inference is exactly the
 * guess this module refuses to make elsewhere.
 *
 * OPEN, deliberately unresolved: when the résumé yields no title at all, the
 * phrase is the top few SKILLS (`searchPhrase`'s fallback), and `phraseQuote`
 * currently quotes that too — `"Kubernetes Go Terraform"` — which may
 * over-constrain where the same rule helps a real title. Neither direction was
 * measured, so no carve-out was invented; the fix, if one is needed, is a
 * measurement, not an inference.
 *
 * VERIFICATION. Every entry below was hand-verified against the live site at
 * authoring time (2026-07-30) by loading the templated URL with a nonsense
 * query and confirming the site's own UI echoed it back (the search box
 * showed the term, or the page title/heading named it) and returned a
 * plausible "no results" state rather than silently ignoring the parameter.
 * That is a POINT-IN-TIME check, not a continuous one — entries are NOT
 * re-verified on a schedule, and there is deliberately no automated test that
 * pretends to check them against the live sites (that would require the
 * fetch this module exists to avoid). A site that renames its query param
 * will make the link open unfiltered rather than fail loudly — the templates
 * below were chosen because getting it wrong produces a visibly empty or
 * obviously-unfiltered results page rather than one that looks plausible.
 * Expect drift; a registry refresh is future work, same as `company-
 * registry.ts`'s.
 */

import { buildLocationParam, stripSearchOperators } from "./deep-links.ts";
import type { JobBoardLink } from "./deep-links.ts";
import { searchPhrase } from "./providers/keywords.ts";
import { roleHeadForSearch } from "./query-builder.ts";
import type { JobQuery } from "./query-builder.ts";

export interface CompanySearchLink {
  /** Display name, e.g. "Apple" — also the rendered link label. */
  readonly name: string;
  /** The company's own careers-search page, with no query string. */
  readonly url: string;
  /** Param name the site reads the free-text query from, when it has one. */
  readonly queryParam?: string;
  /** Param name the site reads a free-text location from, when it has one. */
  readonly locationParam?: string;
  /**
   * How this destination PARSES its query box (#697). Set ONLY on a row whose
   * behaviour was MEASURED — see the module docblock's table. An absent
   * `dialect` is not "no opinion yet", it is the contract: behave exactly as
   * this module did before #697.
   */
  readonly dialect?: {
    /** Wrap the role phrase in double quotes to force a phrase match. Declines
     *  on a phrase that still carries a leading seniority modifier — see the
     *  guard in `applyPhraseDialect`. */
    readonly phraseQuote?: boolean;
    /** Drop a leading Sr./Senior/Jr./Junior modifier from the phrase. */
    readonly dropSeniorityPrefix?: boolean;
  };
  /**
   * The CLOSED location vocabulary this site's location param reads, as
   * `normalizeLocationKey` key → site slug. Omit ENTIRELY for a destination
   * whose location param takes free text: an absent table means "pass the
   * user's string through", a present one means "resolve it or send nothing".
   */
  readonly locationSlugs?: Readonly<Record<string, string>>;
}

/**
 * Apple's `location=` vocabulary. Every slug here was observed on a live Apple
 * results page on 2026-07-31 (the module docblock's table is the same session);
 * a free-text value returns a hard zero, so this table is what makes it safe to
 * declare `locationParam` on that row at all.
 *
 * Keys are `normalizeLocationKey` output — lowercased, whitespace-collapsed
 * CITY SEGMENT — so `"Santa Clara, CA"` and `"Santa Clara Valley"` both land on
 * the Cupertino slug.
 *
 * DO NOT ADD A SLUG YOU HAVE NOT LOADED. A wrong slug degrades to an unfiltered
 * results page rather than an error, so a guessed row is invisible in testing
 * and surfaces only as bad results for a real user. `austin` is the row this
 * table is missing on purpose: it is plausible and it was not verified.
 */
const APPLE_LOCATION_SLUGS: Readonly<Record<string, string>> = {
  "santa clara": "santa-clara-valley-cupertino-SCV",
  "santa clara valley": "santa-clara-valley-cupertino-SCV",
  cupertino: "santa-clara-valley-cupertino-SCV",
  sunnyvale: "santa-clara-valley-cupertino-SCV",
  "san jose": "san-jose-SJS",
  seattle: "seattle-SEA",
  "new york": "new-york-city-NYC",
  "new york city": "new-york-city-NYC",
  california: "california-state953",
  "united states": "united-states-USA",
  usa: "united-states-USA",
  // Apple's vocabulary has no remote entry; the nationwide slug is the widest
  // real option, and fail-broad is the recoverable direction (see `resolveLocation`).
  remote: "united-states-USA",
};

/**
 * Hand-curated, hand-verified — see the module docblock. Every entry supports
 * at least a query param today; a future entry that supports neither is
 * still valid (`buildCompanySearchUrl` degrades to the bare `url`).
 */
export const COMPANY_SEARCH_LINKS: readonly CompanySearchLink[] = [
  {
    name: "Apple",
    url: "https://jobs.apple.com/en-us/search",
    queryParam: "search",
    // `locationParam` and `locationSlugs` are one decision, not two — see the
    // slug table's docblock and defect 3 in the module docblock.
    locationParam: "location",
    dialect: { phraseQuote: true, dropSeniorityPrefix: true },
    locationSlugs: APPLE_LOCATION_SLUGS,
  },
  {
    name: "Amazon",
    url: "https://www.amazon.jobs/en/search",
    queryParam: "base_query",
    locationParam: "loc_query",
  },
  {
    name: "Google",
    url: "https://www.google.com/about/careers/applications/jobs/results",
    queryParam: "q",
  },
  { name: "Meta", url: "https://www.metacareers.com/jobs", queryParam: "q" },
  {
    name: "Netflix",
    url: "https://explore.jobs.netflix.net/careers",
    queryParam: "query",
    // Free-text location is MEASURED to work here (`location=Los Gatos`), so no
    // slug table — the absence is the statement, see `locationSlugs`' docblock.
    locationParam: "location",
    dialect: { phraseQuote: true },
  },
  { name: "Tesla", url: "https://www.tesla.com/careers/search/", queryParam: "query" },
];

/**
 * Fills in `link`'s query/location holes with `terms`, dropping any hole the
 * site doesn't support and any term that is empty — never an empty `?param=`.
 * `URLSearchParams` handles the encoding, so `&`, `#`, spaces and non-ASCII
 * characters in `terms` all round-trip correctly.
 */
export function buildCompanySearchUrl(
  link: CompanySearchLink,
  terms: { query?: string; location?: string },
): string {
  const url = new URL(link.url);
  if (link.queryParam && terms.query) {
    url.searchParams.set(link.queryParam, terms.query);
  }
  if (link.locationParam && terms.location) {
    url.searchParams.set(link.locationParam, terms.location);
  }
  return url.toString();
}

/**
 * The ONLY seniority modifiers that may be subtracted from a search phrase, and
 * only at its HEAD.
 *
 * WHY NOT `parseSeniorityLabel`. It answers a different question — which rung
 * of the ladder is this title on — and its vocabulary is deliberately wider
 * than what may be removed from a phrase. `SENIORITY_PATTERNS` classifies
 * `Manager` as a seniority label, so the obvious implementation ("remove
 * `query.seniority` from the phrase") turns `Sr. Engineering Manager` into
 * `Sr. Engineering`, deleting the ROLE NOUN and manufacturing a query worse
 * than the one we started from. Same trap for `Engineering Lead` (Lead is a
 * rung), `Staff Engineer` (Staff is a rung) and `Head of Platform` (Director,
 * via `\bhead\s+of\b`). That is the #605 defect class — a subtraction that
 * manufactures the string which egresses.
 *
 * `Staff`, `Principal`, `Lead`, `Manager`, `Director`, `VP` and `Head of` are
 * therefore out of scope: none was measured, several are role nouns rather than
 * modifiers, and each would need its own before/after count before it earns a
 * place here.
 *
 * The trailing `\s+` is load-bearing twice over. It acts as the word boundary
 * that keeps `Sriram` and `Senior-Level` intact, and — because the phrase this
 * runs on has already been through `stripSearchOperators`, which trims and
 * collapses runs of whitespace to single spaces — a match GUARANTEES a
 * following token, so the strip can never empty the phrase.
 */
const SENIORITY_PREFIX_RE = /^(?:sr\.?|senior|jr\.?|junior)\s+/i;

/**
 * The lookup key for a `locationSlugs` table: the lowercased, whitespace-
 * collapsed CITY SEGMENT of a free-text location, so `"Santa Clara, CA"` and
 * `"Santa Clara Valley"` both reach the same row. Registry-lookup
 * normalization, not general location parsing — it stays here rather than
 * joining `deep-links.ts`'s shared helpers because nothing outside this
 * registry has a closed vocabulary to look anything up in.
 */
function normalizeLocationKey(raw: string): string {
  return raw.split(",")[0].trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * The location term for one destination — free text where the site takes free
 * text, a resolved slug where it takes a closed vocabulary.
 *
 * A MISS OMITS THE PARAM. It must never fall back to the free-text value:
 * fail-broad (Apple's 92 nationwide results) costs the user two clicks on the
 * employer's own page, while fail-zero reads as "this employer has no matching
 * roles" and is not recoverable at all, because nothing on the page says the
 * query was malformed.
 */
function resolveLocation(link: CompanySearchLink, query: JobQuery): string | undefined {
  const raw = buildLocationParam(query);
  if (!raw) return undefined;
  if (!link.locationSlugs) return raw;
  return link.locationSlugs[normalizeLocationKey(raw)];
}

/**
 * `dropSeniorityPrefix`, with the one carve-out the fuzz found: a strip that
 * would leave a SINGLE token is declined.
 *
 * `Senior Manager` → `Manager`, `Senior Director` → `Director`, `Senior
 * Engineer` → `Engineer` — and `Manager` alone is the exact token defect 1 in
 * the module docblock indicts ("drags in retail store managers"). On a
 * two-token title the strip therefore manufactures the generic noun this
 * module exists to avoid, rather than narrowing anything. A leading modifier is
 * only safely subtractable when what remains is still a role PHRASE.
 *
 * Declining is today's behaviour, so this stays inside measured-or-nothing: the
 * phrase ships exactly as it did before #697.
 */
function dropSeniorityPrefix(phrase: string): string {
  const stripped = phrase.replace(SENIORITY_PREFIX_RE, "");
  return /\s/.test(stripped) ? stripped : phrase;
}

/**
 * The registry row's dialect, applied as the LAST hop of the derivation.
 *
 * Quoting must run AFTER `stripSearchOperators`, not before: a leading `"`
 * makes the first token no longer START with `-`, so #696's operator strip
 * would silently stop firing on a title like `- Customer Experience` and the
 * bare `-` would ride into the quoted phrase as a NOT.
 *
 * An empty phrase stays empty — a degenerate query must degrade to the bare
 * careers-search URL, never to `search=""`.
 */
function applyPhraseDialect(phrase: string, link: CompanySearchLink): string {
  if (!phrase || !link.dialect) return phrase;
  const stripped = link.dialect.dropSeniorityPrefix
    ? dropSeniorityPrefix(phrase)
    : phrase;

  // THE TWO FLAGS INTERACT — they do not compose independently. The module
  // docblock's Apple table measures `"Sr. Engineering Manager"` + a metro
  // location at a hard ZERO, and the same phrase UNQUOTED at 243: it is the
  // QUOTED, seniority-bearing phrase that kills the result set, not the
  // seniority modifier on its own. Apple never emits that shape only because
  // `dropSeniorityPrefix` removes the modifier before quoting; a row carrying
  // `phraseQuote` alone would emit it directly.
  //
  // So `phraseQuote` is scoped to the phrase shape it was actually measured on
  // (Netflix: `engineering manager` → 40, quoted → 13 — no seniority prefix).
  // A phrase that still carries one keeps its pre-#697 unquoted form: fail-broad
  // costs two clicks on the employer's page, fail-zero reads as "this employer
  // has no matching roles" and is unrecoverable, because nothing on the results
  // page says the query was malformed (same asymmetry as `resolveLocation`).
  if (SENIORITY_PREFIX_RE.test(stripped)) return stripped;

  return link.dialect.phraseQuote ? `"${stripped}"` : stripped;
}

/**
 * The outbound terms for ONE destination. This is the seam #697 moved: the
 * derivation is a function of `(query, link)`, not of `query` alone, because a
 * rule that is true for one careers box is not true for the next.
 *
 * The BASE derivation is shared by every destination and unchanged:
 * `searchPhrase` → `roleHeadForSearch` → `stripSearchOperators`. Within it,
 * `roleHeadForSearch` runs before `stripSearchOperators`: the first drops a
 * trailing scope qualifier ("Engineering Lead - Customer Experience" →
 * "Engineering Lead"), the second neutralizes an operator the first left behind
 * because the title's punctuation did not read as a role stack. Both are no-ops
 * on a phrase that needs neither, so that order is a preference, not a
 * dependency — unlike the dialect's, which is (see `applyPhraseDialect`).
 */
export function buildCompanySearchTerms(
  query: JobQuery,
  link: CompanySearchLink,
): { query?: string; location?: string } {
  const base = stripSearchOperators(roleHeadForSearch(searchPhrase(query)));
  return {
    query: applyPhraseDialect(base, link),
    location: resolveLocation(link, query),
  };
}

/**
 * One prefilled link per registry entry, in registry order.
 *
 * The query term is the SINGLE-INTENT phrase (`searchPhrase`), not the board
 * links' broadening union — see the module docblock for the measurement that
 * forced that split — narrowed per destination by that row's measured dialect.
 */
export function buildCompanySearchLinks(query: JobQuery): JobBoardLink[] {
  return COMPANY_SEARCH_LINKS.map((link) => ({
    label: link.name,
    url: buildCompanySearchUrl(link, buildCompanySearchTerms(query, link)),
  }));
}
