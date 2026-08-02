// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// The `ats_api` tier — read a posting from its ATS platform's public JSON API
// instead of from a rendered page.
//
// Second in the ladder, below the publisher's own JSON-LD and above every
// DOM-reading tier, because an ATS's own API is authoritative about its own
// postings: no markup to guess at, no SPA to wait for, no selector to rot.
//
// This module is a thin adapter over `src/lib/jd-match/fetch-jd.ts`, which already
// owns every ATS URL parser and API client in this repo. It deliberately adds no
// second parser — two implementations of "is this a Greenhouse URL, and which job"
// is exactly the fork `src/lib/jd-extract/` exists to end, and the same argument
// `src/lib/storage/job-url.ts` makes for id derivation.
//
// **Kept out of `./detect.ts` and out of the injectable bundle on purpose.**
// `fetch-jd.ts` owns live `fetch()` calls, so anything importing it pulls a network
// primitive into its import graph — the boundary #704 established when it split
// `html-to-plaintext.ts` out for exactly this reason. `./index.ts` (the page-injected
// entry point) must never reach this file: injected code runs in the page's origin,
// where a cross-origin ATS request would be blocked by CORS anyway.

import { fetchJdFromUrl, parseAtsUrl } from "../jd-match/fetch-jd";
import { extractFromDomTiers, finalize } from "./detect";
import { extractSchemaOrgJobPosting } from "./schema-org";
import { stripHtml } from "./schema-org-core";
import { EXTRACTION_ALGORITHM_VERSION, type ExtractedPosting } from "./types";

/**
 * Can this URL be read through a public ATS API?
 *
 * Delegates to `parseAtsUrl` rather than testing hostnames here, so the set of
 * fetchable platforms has exactly one definition. Note this is a narrower question
 * than "which ATS is this", which `matchAtsDomain` in `./schema-org-core.ts`
 * answers for a much longer list of platforms that have no fetchable API.
 */
export function isAtsApiUrl(url: string): boolean {
  return parseAtsUrl(url) !== null;
}

/**
 * Extract a posting through its ATS platform's public API.
 *
 * Returns `null` for a URL no supported platform claims — the caller falls through
 * to the DOM tiers. Network failures also return `null` rather than throwing: an
 * ATS API being down is a reason to read the page instead, not a reason for the
 * whole extraction to fail. (`fetchJdFromUrl` distinguishes these two cases by
 * returning `null` vs throwing; that distinction matters to `JdInput`, which routes
 * them to different user-facing copy, but not here, where both mean "try the DOM".)
 *
 * Prefers the platform's raw HTML over its plaintext so the body keeps its list
 * structure — see `ExtractedPosting.body`. Falls back to the plaintext `text` when
 * a platform returns no HTML (Workable's widget has no description body at all).
 */
export async function extractPostingFromAtsApi(
  url: string,
): Promise<ExtractedPosting | null> {
  if (!parseAtsUrl(url)) return null;

  let result: Awaited<ReturnType<typeof fetchJdFromUrl>>;
  try {
    result = await fetchJdFromUrl(url);
  } catch {
    return null;
  }
  if (!result) return null;

  const body = result.descriptionHtml
    ? stripHtml(result.descriptionHtml)
    : result.text;

  // Same rule as every other tier: without a title and a company there is nothing
  // to display or deduplicate on, so report nothing rather than something partial.
  if (!result.title || !result.company) return null;

  return {
    title: result.title,
    company: result.company,
    body,
    descriptionPreview: body.slice(0, 200),
    atsDetected: result.source,
    extractionTier: "ats_api",
    algorithmVersion: EXTRACTION_ALGORITHM_VERSION,
  };
}

/**
 * The full tier ladder, including the network-bound `ats_api` tier:
 *
 *   `schema_org` → `ats_api` → `dom_metadata` / `ats_extractor`
 *
 * First hit wins. Use this from app code that can make network requests; use
 * `extractPostingFromDocument` in `./detect.ts` where the extraction must stay
 * offline — including anything that gets injected into a page.
 *
 * The API tier is skipped without a cheap URL test first, so a page on a
 * non-fetchable host costs no network round-trip on its way to the DOM tiers.
 */
export async function extractPosting(
  doc: Document,
  url: URL,
): Promise<ExtractedPosting | null> {
  const schemaOrgPosting = await extractSchemaOrgJobPosting(doc);
  if (schemaOrgPosting) return finalize(schemaOrgPosting, doc, url);

  if (isAtsApiUrl(url.href)) {
    const fromApi = await extractPostingFromAtsApi(url.href);
    if (fromApi) return fromApi;
  }

  return extractFromDomTiers(doc, url);
}
