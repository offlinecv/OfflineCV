// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// The `og:` / `<meta>` / data-attribute tier, and the enrichment pass that runs
// after every other tier.
//
// Two jobs, deliberately in one module because they read the same metadata:
//
//   - `extractFromDomMetadata` — a standalone tier for pages with no JSON-LD that
//     no host adapter claims. Social-preview tags are the lowest-common-denominator
//     structured data on the web: nearly every page has them, they are meant to be
//     machine-read, and unlike a host adapter they are not a guess about one
//     vendor's markup.
//   - `enrichWithDomMetadata` — a gap-filler applied to whatever an earlier tier
//     produced. It only ever fills fields that are missing and never overwrites,
//     because the tier that produced the result was more trusted than this one;
//     letting a page-level `og:` tag overwrite a JSON-LD field would invert the
//     ladder's whole ordering.

import type { ExtractedPosting, ExtractionTier } from "./types";
import { matchAtsDomain } from "./schema-org-core";

interface DomMetadata {
  title?: string;
  company?: string;
  location?: string;
  description?: string;
  jobId?: string;
  atsPlatform?: string;
}

function getMetaContent(doc: Document, selector: string): string | undefined {
  const el = doc.querySelector(selector);
  const content = el?.getAttribute("content")?.trim();
  return content || undefined;
}

/**
 * Read what the page says about itself through metadata rather than content.
 *
 * `og:site_name` is used as the company, which is right on a company's own careers
 * page and wrong on an aggregator — where it yields the aggregator's name. That is
 * acceptable precisely because this tier runs last among the general tiers: an
 * aggregator page that a host adapter claims never reaches here, and one that
 * reaches here has no better answer available.
 *
 * The job-id meta names are alternatives, not a hierarchy of quality — different
 * ATS vendors simply chose different spellings for the same thing.
 *
 * `url` is passed in rather than read off `doc.location` for the reason given in
 * `./schema-org.ts`: a `Document` only has a meaningful location when it came from
 * navigation.
 */
function extractDomMetadata(doc: Document, url?: URL): DomMetadata {
  const meta: DomMetadata = {};

  const ogTitle = getMetaContent(doc, 'meta[property="og:title"]');
  const ogSiteName = getMetaContent(doc, 'meta[property="og:site_name"]');
  const ogDescription = getMetaContent(doc, 'meta[property="og:description"]');

  if (ogTitle) meta.title = ogTitle;
  if (ogSiteName) meta.company = ogSiteName;
  if (ogDescription) meta.description = ogDescription;

  const jobIdMeta =
    getMetaContent(doc, 'meta[name="JobIdentifier"]') ||
    getMetaContent(doc, 'meta[name="job-id"]') ||
    getMetaContent(doc, 'meta[name="jobId"]') ||
    getMetaContent(doc, 'meta[name="requisitionId"]') ||
    getMetaContent(doc, 'meta[name="job_id"]');
  if (jobIdMeta) meta.jobId = jobIdMeta;

  // Data attributes on a job-detail container. Only read when the container is
  // found — these attribute names are generic enough that querying for them
  // individually across the whole document would collect unrelated widgets.
  const jobContainer = doc.querySelector(
    '[data-jobtitle], [data-job-title], [data-id][class*="job"]',
  );
  if (jobContainer) {
    const dataTitle =
      jobContainer.getAttribute("data-jobtitle") ||
      jobContainer.getAttribute("data-job-title");
    if (dataTitle && !meta.title) meta.title = dataTitle;

    const dataId = jobContainer.getAttribute("data-id");
    if (dataId && !meta.jobId) meta.jobId = dataId;

    const dataLocation =
      jobContainer.getAttribute("data-location") ||
      jobContainer.getAttribute("data-job-location");
    if (dataLocation) meta.location = dataLocation;
  }

  // ATS platform from apply-button targets, then from the page's own URL — the
  // same two-step and the same shared domain table the schema.org tier uses, so
  // platform naming stays one rule rather than drifting per tier.
  const applyLinks = doc.querySelectorAll(
    'a[href*="apply"], a[class*="apply"], [data-apply-url]',
  );
  for (const link of applyLinks) {
    const href =
      link.getAttribute("href") || link.getAttribute("data-apply-url") || "";
    const platform = matchAtsDomain(href);
    if (platform) {
      meta.atsPlatform = platform;
      break;
    }
  }

  if (!meta.atsPlatform) {
    meta.atsPlatform = matchAtsDomain(url?.href || doc.location?.href || "");
  }

  return meta;
}

/**
 * Fill gaps in a posting an earlier tier produced.
 *
 * Only `location`, `jobId`, and `atsDetected` are enriched. The rest are left
 * alone on purpose: `title`, `company`, and `body` are the fields the earlier tier
 * was chosen for, and metadata versions of them are systematically worse —
 * `og:title` carries site branding, `og:description` is a truncated blurb.
 */
export function enrichWithDomMetadata(
  posting: ExtractedPosting,
  doc: Document,
  url?: URL,
): ExtractedPosting {
  const meta = extractDomMetadata(doc, url);

  return {
    ...posting,
    location: posting.location || meta.location,
    jobId: posting.jobId || meta.jobId,
    atsDetected: posting.atsDetected || meta.atsPlatform,
  };
}

/**
 * Build a posting from metadata alone.
 *
 * `body` is supplied by the caller rather than read here, because this tier has no
 * view of which element holds the description — the dispatcher does. The `og:`
 * description, when present, is used only for the short preview.
 *
 * Returns `null` without both a title and a company, for the reason given on
 * `ATSExtractor.extract`: a partially-populated result is indistinguishable from a
 * successful one to every caller downstream.
 *
 * `existingTier` lets a host adapter reuse this builder while keeping its own,
 * more specific tier label on the result.
 */
export function extractFromDomMetadata(
  doc: Document,
  body: string,
  existingTier?: ExtractionTier,
  url?: URL,
): ExtractedPosting | null {
  const meta = extractDomMetadata(doc, url);

  const title = meta.title || doc.querySelector("h1")?.textContent?.trim();
  const company = meta.company;

  if (!title || !company) return null;

  return {
    title,
    company,
    location: meta.location,
    body,
    descriptionPreview: (meta.description || body).slice(0, 200),
    atsDetected: meta.atsPlatform,
    extractionTier: existingTier || "dom_metadata",
    jobId: meta.jobId,
  };
}
