// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// The dispatcher: run the extraction tiers against a document in trust order and
// return the first result.
//
// Deliberately network-free. Every tier below reads the document it was handed and
// nothing else, which is what lets this module be bundled and injected into a live
// page — see `./index.ts`. The `ats_api` tier is real but lives in `./ats-api.ts`,
// because it needs `fetch()` and the boundary #704 established is that a consumer
// auditing its own import graph for network primitives must be able to take the
// DOM half without one appearing.
//
// The upstream implementation of this logic was a browser-extension content-script
// entry point: it read `window` globals, called `chrome.runtime.sendMessage`, and
// could not be called as a function or tested. Only the tier ordering and the
// job-page signal heuristic carried over; the surrounding plumbing is new.

import { greenhouse } from "./adapters/greenhouse";
import { lever } from "./adapters/lever";
import { linkedin } from "./adapters/linkedin";
import { workday } from "./adapters/workday";
import { oracleHcm } from "./adapters/oracle-hcm";
import { smartrecruiters } from "./adapters/smartrecruiters";
import { generic } from "./adapters/generic";
import { extractSchemaOrgJobPosting } from "./schema-org";
import { enrichWithDomMetadata, extractFromDomMetadata } from "./dom-metadata";
import { extractApplyLink } from "./apply-link";
import {
  EXTRACTION_ALGORITHM_VERSION,
  type ATSExtractor,
  type ExtractedPosting,
} from "./types";

/**
 * Host adapters in dispatch order — most specific first, `generic` always last.
 *
 * Exported so a test can pin the ordering. The order is behaviour, not
 * configuration: `generic.matches()` returns `true` unconditionally, so anything
 * placed after it is unreachable, and `linkedin` must precede it or LinkedIn
 * postings get the catch-all's extraction instead of the one written for them.
 */
export const DOM_EXTRACTORS: readonly ATSExtractor[] = [
  greenhouse,
  lever,
  linkedin,
  workday,
  oracleHcm,
  smartrecruiters,
  generic,
];

/**
 * Weighted evidence that a page is a job posting at all.
 *
 * Needed because `generic.matches()` accepts everything: without a gate, every
 * page with an `<h1>` and a `<main>` would extract as a posting. Weighted rather
 * than a keyword list because no single phrase is conclusive — "responsibilities"
 * appears on an about-us page, "salary" on a blog post — while a combination is.
 *
 * Weight 3 signals are near-exclusive to job listings; weight 2 are standard
 * job-page section headings; weight 1 are supportive but common elsewhere.
 */
const JOB_SIGNALS: ReadonlyArray<{ pattern: RegExp; weight: number }> = [
  { pattern: /apply\s*(now|for\s*this)/i, weight: 3 },
  { pattern: /job\s*(description|summary|details|overview)/i, weight: 3 },
  { pattern: /equal\s*opportunity\s*employer/i, weight: 3 },
  { pattern: /job\s*(id|number|code|ref(erence)?)\b/i, weight: 3 },

  { pattern: /responsibilities/i, weight: 2 },
  { pattern: /qualifications/i, weight: 2 },
  { pattern: /requirements?\b/i, weight: 2 },
  { pattern: /certifications?\s*(required)?/i, weight: 2 },
  { pattern: /about\s*the\s*(role|position|job)/i, weight: 2 },
  { pattern: /what\s*you('ll| will)\s*(do|bring)/i, weight: 2 },
  { pattern: /who\s*you\s*are/i, weight: 2 },
  // A careers path is URL-borne evidence — the safety net for an ATS embedded
  // into a company site, where the page markup reveals nothing.
  { pattern: /\/careers?\//i, weight: 2 },

  { pattern: /date\s*published|posted\s*(on|date)?/i, weight: 1 },
  { pattern: /work\s*model|remote|hybrid|on.?site/i, weight: 1 },
  { pattern: /job\s*category|employment\s*type/i, weight: 1 },
  { pattern: /full.?time|part.?time|contract/i, weight: 1 },
  { pattern: /years?\s*(of\s*)?experience/i, weight: 1 },
  { pattern: /salary|compensation|pay\s*range/i, weight: 1 },
  { pattern: /benefits|perks/i, weight: 1 },
  { pattern: /how\s*to\s*apply/i, weight: 1 },
  { pattern: /join\s*our\s*(team|talent)/i, weight: 1 },
];

/**
 * Score needed to treat a page as a posting: one strong signal plus one standard,
 * or two medium. Low enough that a terse posting still passes, high enough that a
 * single incidental keyword does not.
 */
const SIGNAL_THRESHOLD = 4;

/** Does a non-`generic` adapter claim this URL outright? */
function isKnownAtsUrl(doc: Document, url: URL): boolean {
  return DOM_EXTRACTORS.some(
    (e) => e.name !== "generic" && e.matches(url, doc),
  );
}

/** Accumulate signal weight over the page text and URL; stop as soon as it passes. */
function hasJobSignals(doc: Document, url: URL): boolean {
  const bodyText = doc.body?.textContent || "";
  const searchText = bodyText + "\n" + url.href;
  let score = 0;
  for (const { pattern, weight } of JOB_SIGNALS) {
    if (pattern.test(searchText)) {
      score += weight;
      if (score >= SIGNAL_THRESHOLD) return true;
    }
  }
  return false;
}

/**
 * Attach the canonical ATS URL behind an aggregator listing, when one is readable.
 *
 * Only ever fills a gap: an adapter that already recovered an `atsUrl` (Greenhouse's
 * embedded path does) knows more than an apply-button scan does. Failures are
 * swallowed — a missing canonical URL forks a duplicate record the user can delete,
 * whereas a throw here would cost the whole extraction.
 */
function withApplyLink(
  posting: ExtractedPosting,
  doc: Document,
  url: URL,
): ExtractedPosting {
  if (posting.atsUrl) return posting;
  try {
    const result = extractApplyLink(doc, url);
    if (result.sourceUrl) {
      return { ...posting, applyUrl: result.sourceUrl, atsUrl: result.sourceUrl };
    }
  } catch {
    // Selector rot or a hostile DOM — not worth failing the extraction over.
  }
  return posting;
}

/**
 * Extract a job posting from a document, or `null` if the page is not one.
 *
 * Tier order, first hit wins:
 *   1. `schema_org`     — the publisher's own JSON-LD declaration.
 *   2. `ats_extractor`  — a host adapter, for boards that ship no JSON-LD.
 *   3. `dom_metadata`   — `og:`/`<meta>` tags, the floor.
 *
 * (The `ats_api` tier sits between 1 and 2 conceptually but is network-bound and
 * lives in `./ats-api.ts`; `extractPosting` there composes the two.)
 *
 * Tier 1 runs before the job-page gate on purpose: a valid `JobPosting` block is
 * itself conclusive evidence, so a page carrying one should never be rejected for
 * failing a keyword heuristic. The gate exists only to protect the guess-based
 * tiers below it.
 *
 * Every result is stamped with `algorithmVersion` so a stored extraction can be
 * recognised as stale rather than silently compared against fresher output.
 */
export async function extractPostingFromDocument(
  doc: Document,
  url: URL,
): Promise<ExtractedPosting | null> {
  // ─── Tier 1: schema.org JSON-LD ────────────────────────────────────────────
  const schemaOrgPosting = await extractSchemaOrgJobPosting(doc, url);
  if (schemaOrgPosting) return finalize(schemaOrgPosting, doc, url);

  return extractFromDomTiers(doc, url);
}

/**
 * The tiers below `schema_org`: the job-page gate, the host adapters, then the
 * metadata floor.
 *
 * Split out so the network-bound `ats_api` tier can be interleaved at its declared
 * position without re-running tier 1. `extractPosting` in `./ats-api.ts` is the only
 * other caller; it runs tier 1, then the API tier, then this.
 */
export async function extractFromDomTiers(
  doc: Document,
  url: URL,
): Promise<ExtractedPosting | null> {
  // ─── Gate ──────────────────────────────────────────────────────────────────
  if (!isKnownAtsUrl(doc, url) && !hasJobSignals(doc, url)) return null;

  // ─── Tier 2/3: host adapters, then the metadata floor ──────────────────────
  for (const extractor of DOM_EXTRACTORS) {
    if (!extractor.matches(url, doc)) continue;
    const posting = extractor.extract(doc, url);
    if (posting) return finalize(posting, doc, url);
  }

  // `generic` declined — usually too little body text. Metadata alone may still
  // carry a title and company, which is a thin but honest result.
  const fromMeta = extractFromDomMetadata(
    doc,
    doc.body?.textContent?.trim() || "",
    undefined,
    url,
  );
  return fromMeta ? finalize(fromMeta, doc, url) : null;
}

/**
 * The common tail every DOM tier's result passes through: fill metadata gaps,
 * attach a canonical ATS URL if one is readable, stamp the algorithm version.
 */
export function finalize(
  posting: ExtractedPosting,
  doc: Document,
  url: URL,
): ExtractedPosting {
  return {
    ...withApplyLink(enrichWithDomMetadata(posting, doc, url), doc, url),
    algorithmVersion: EXTRACTION_ALGORITHM_VERSION,
  };
}
