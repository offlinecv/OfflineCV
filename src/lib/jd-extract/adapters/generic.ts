// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// The catch-all adapter: no host knowledge, only conventions every content page
// shares — an `<h1>`, an `<article>`/`<main>` landmark, an `og:site_name`.
//
// `matches()` always returns true, so this MUST be registered last. It is the
// dispatcher's floor, and the only reason the ladder can be described as "first hit
// wins" without a special case for the miss.
//
// Because it knows nothing, its guards do the work. `MIN_BODY_LENGTH` is what
// separates a real posting from a page whose `<main>` is a nav bar, and returning
// `null` there is what lets a genuinely unreadable page report as unreadable
// instead of producing a plausible-looking record of navigation labels.
//
// Reports `dom_metadata` rather than `ats_extractor`: no ATS was identified, and
// claiming one would misreport how the posting was obtained.

import { htmlToMarkdown } from "../html-to-markdown";
import { pruneNonPosting } from "../prune";
import type { ATSExtractor, ExtractedPosting } from "../types";

/** See `./linkedin.ts` — below this, the container held page chrome, not a JD. */
const MIN_BODY_LENGTH = 100;

export const generic: ATSExtractor = {
  name: "generic",

  matches(): boolean {
    return true;
  },

  extract(doc: Document, url: URL): ExtractedPosting | null {
    const title = doc.querySelector("h1")?.textContent?.trim();
    if (!title) return null;

    // Company, in descending order of reliability: the page's declared site name,
    // then the trailing segment of `<title>` (the "… | Acme" branding convention),
    // then the bare domain. The last is always available, so `company` is never
    // empty here — which is what lets this adapter return a usable result at all.
    const ogSiteName = doc
      .querySelector('meta[property="og:site_name"]')
      ?.getAttribute("content");
    const titleParts = (doc.title || "").split(/\s*[-|]\s*/);
    const company =
      ogSiteName ||
      (titleParts.length > 1 ? titleParts[titleParts.length - 1].trim() : "") ||
      url.hostname.replace(/^www\./, "").split(".")[0];

    const locationEl = doc.querySelector(
      '[class*="location"], [data-testid*="location"], .job-location',
    );
    const location = locationEl?.textContent?.trim() || undefined;

    // Landmark elements only — never `doc.body`, which on an unknown page would
    // sweep in the header, nav, and footer along with the posting.
    const mainEl =
      doc.querySelector("article") ||
      doc.querySelector("main") ||
      doc.querySelector('[role="main"]');
    // Pruned for the same reason the landmark is preferred over `doc.body`: a
    // landmark is the smallest container the page offers, not a clean one. An
    // unknown board's `<main>` still carries a "Related jobs" rail, and those are
    // other postings' terms landing in this posting's coverage denominator.
    const body = mainEl
      ? htmlToMarkdown(pruneNonPosting(mainEl))
      : doc.body?.textContent?.trim() || "";

    if (body.length < MIN_BODY_LENGTH) return null;

    return {
      title,
      company,
      location,
      body,
      descriptionPreview: body.slice(0, 200),
      atsDetected: undefined,
      extractionTier: "dom_metadata",
    };
  },
};
