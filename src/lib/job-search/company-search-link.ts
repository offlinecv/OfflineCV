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
}

/**
 * Hand-curated, hand-verified — see the module docblock. Every entry supports
 * at least a query param today; a future entry that supports neither is
 * still valid (`buildCompanySearchUrl` degrades to the bare `url`).
 */
export const COMPANY_SEARCH_LINKS: readonly CompanySearchLink[] = [
  { name: "Apple", url: "https://jobs.apple.com/en-us/search", queryParam: "search" },
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
    locationParam: "location",
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
 * One prefilled link per registry entry, in registry order.
 *
 * The query term is the SINGLE-INTENT phrase (`searchPhrase`), not the board
 * links' broadening union — see the module docblock for the measurement that
 * forced that split. Location still comes from `deep-links.ts`, because a
 * location param is a filter on both kinds of destination and nothing about it
 * differs here.
 */
export function buildCompanySearchLinks(query: JobQuery): JobBoardLink[] {
  // `roleHeadForSearch` before `stripSearchOperators`: the first drops a
  // trailing scope qualifier ("Engineering Lead - Customer Experience" →
  // "Engineering Lead"), the second neutralizes an operator the first left
  // behind because the title's punctuation did not read as a role stack. Both
  // are no-ops on a phrase that needs neither, so the order is a preference,
  // not a dependency.
  const terms = {
    query: stripSearchOperators(roleHeadForSearch(searchPhrase(query))),
    location: buildLocationParam(query),
  };
  return COMPANY_SEARCH_LINKS.map((link) => ({
    label: link.name,
    url: buildCompanySearchUrl(link, terms),
  }));
}
