// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// Tier 1 — read the publisher's own JSON-LD `JobPosting` declaration.
//
// This tier is first in the ladder because it is the only one that is not a guess
// about someone else's markup. A `JobPosting` block is what the publisher chose to
// tell machines about the role, so it is site-agnostic, survives redesigns, and
// costs nothing to read. Most modern boards ship one, which means most pages are
// extracted here with no host-specific code executing at all — the per-host
// adapters exist for the remainder, not the common case.
//
// The DOM half of the tier only: finding and parsing `<script type="ld+json">`
// blocks. Everything that operates on the parsed object lives in
// `./schema-org-core.ts`, which is DOM-free and testable without jsdom.

import type { ExtractedPosting } from "./types";
import {
  computeStructuredDataHash,
  extractJobId,
  extractLocation,
  extractSalary,
  extractWorkModel,
  findJobPosting,
  hasSchemaOrgContext,
  matchAtsDomain,
  parseHtmlSections,
} from "./schema-org-core";

/**
 * Name the ATS platform behind a page, from its apply links and then its own host.
 *
 * Apply links first because they are the more informative signal: a company's
 * careers page on its own domain reveals which ATS it runs only through where its
 * "Apply" button points. The page's own hostname is the fallback for postings
 * hosted directly on the ATS.
 *
 * `url` is passed in rather than read off `doc.location` because a `Document` only
 * has a meaningful location when it came from navigation — one built by
 * `DOMParser`, or detached, reports `about:blank`. `doc.location` remains the
 * fallback for callers that have no URL in hand.
 */
function detectAtsPlatform(doc: Document, url?: URL): string | undefined {
  const applyLinks = doc.querySelectorAll(
    'a[href*="apply"], a[class*="apply"], button[data-href]',
  );

  for (const link of applyLinks) {
    const href =
      link.getAttribute("href") || link.getAttribute("data-href") || "";
    const platform = matchAtsDomain(href);
    if (platform) return platform;
  }

  return matchAtsDomain(url?.hostname || doc.location?.hostname || "");
}

/**
 * Extract a posting from a document's JSON-LD blocks, or `null` if none carries a
 * usable `JobPosting`.
 *
 * Iterates every `ld+json` block rather than stopping at the first, because pages
 * routinely ship several (an `Organization` block, a `BreadcrumbList`, then the
 * posting) and their order is arbitrary. A block that fails to parse, fails the
 * schema.org context check, or lacks both a title and a company is skipped and the
 * next is tried — a malformed block from one vendor widget must not cost the whole
 * extraction.
 *
 * `title` and `company` are both required. Without them there is nothing a
 * consumer can display or deduplicate on, and returning a body with no identity
 * attached would look like a successful extraction to every caller downstream.
 *
 * Async solely because the change-detection hash uses Web Crypto.
 */
export async function extractSchemaOrgJobPosting(
  doc: Document,
  url?: URL,
): Promise<ExtractedPosting | null> {
  const scripts = doc.querySelectorAll('script[type="application/ld+json"]');
  if (scripts.length === 0) return null;

  for (const script of scripts) {
    try {
      // Some publishers wrap JSON-LD in CDATA markers, which are not valid JSON.
      const text = (script.textContent || "")
        .replace(/^\s*<!\[CDATA\[/, "")
        .replace(/\]\]>\s*$/, "")
        .trim();

      if (!text) continue;

      const data = JSON.parse(text);

      // Only object roots can declare a context; a bare array root is checked by
      // `findJobPosting` reaching into its items instead.
      const root = typeof data === "object" && !Array.isArray(data) ? data : null;
      if (root && !hasSchemaOrgContext(root)) continue;

      const posting = findJobPosting(data);
      if (!posting) continue;

      const title = posting.title as string | undefined;
      const org = posting.hiringOrganization as
        | Record<string, unknown>
        | undefined;
      const company =
        (org && typeof org === "object" ? (org.name as string) : null) ||
        undefined;

      if (!title || !company) continue;

      // `description` is HTML inside a JSON string, so it is parsed by the
      // string-input converter rather than a DOM walk. This is the JD body: the
      // publisher's own description field IS the job description, which is why
      // this lane needs no heuristic guess at which part of the page is the article.
      const htmlDescription = (posting.description as string) || "";
      const sections = htmlDescription
        ? parseHtmlSections(htmlDescription)
        : { requirements: [], qualifications: [], description: "" };

      // `employmentType` is a string on most boards and an array on some.
      let employmentType: string | undefined;
      if (typeof posting.employmentType === "string") {
        employmentType = posting.employmentType;
      } else if (Array.isArray(posting.employmentType)) {
        employmentType = posting.employmentType.join(", ");
      }

      return {
        title,
        company,
        location: extractLocation(posting),
        workModel: extractWorkModel(posting),
        body: sections.description,
        descriptionPreview: sections.description.slice(0, 200),
        atsDetected: detectAtsPlatform(doc, url),
        extractionTier: "schema_org",
        jobId: extractJobId(posting),
        datePosted: (posting.datePosted as string) || undefined,
        validThrough: (posting.validThrough as string) || undefined,
        employmentType,
        salaryRange: extractSalary(posting),
        // Empty arrays are normalized away: a posting that writes its
        // requirements as prose should read as "none extracted", not "zero
        // requirements", and `undefined` is the honest encoding of that.
        requirements:
          sections.requirements.length > 0 ? sections.requirements : undefined,
        qualifications:
          sections.qualifications.length > 0
            ? sections.qualifications
            : undefined,
        structuredDataHash: await computeStructuredDataHash(posting),
        schemaOrgRaw: posting,
      };
    } catch {
      // Invalid JSON or an unexpected structure — try the next block.
      continue;
    }
  }

  return null;
}
