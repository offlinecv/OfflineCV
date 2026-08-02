// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// LinkedIn adapter — the most load-bearing file in this directory.
//
// LinkedIn's logged-in job view ships no JSON-LD and no `og:` meta tags, so every
// general tier misses it. It is also the highest-volume source in the `job-hunt`
// lane, which means without this adapter the single most common posting the user
// captures gets the worst extraction available.
//
// The parsing itself lives in `../linkedin-parse.ts` because it is needed in two
// contexts, only one of which has a `Document` — see that module's docblock.
//
// Reports `dom_metadata` rather than `ats_extractor`: LinkedIn is an aggregator,
// not an applicant tracking system, and labelling it as one would misreport how the
// posting was obtained.

import { htmlToMarkdown } from "../html-to-markdown";
import type { ATSExtractor, ExtractedPosting } from "../types";
import {
  extractLinkedInCompanyFromDOM,
  isLinkedInJobUrl,
  parseLinkedInTitle,
} from "../linkedin-parse";

/**
 * Below this many characters, `<main>` held navigation chrome rather than a
 * posting — the SPA had not rendered the job yet. Returning null lets the caller
 * fall through instead of persisting a body of menu labels, which would score as a
 * successful capture and produce no extractable skill terms.
 */
const MIN_BODY_LENGTH = 100;

export const linkedin: ATSExtractor = {
  name: "linkedin",

  matches(url: URL): boolean {
    return isLinkedInJobUrl(url);
  },

  extract(doc: Document): ExtractedPosting | null {
    // The DOM's `aria-label` is more reliable than the title string, so it wins;
    // title parsing fills whichever half it left empty.
    let company = extractLinkedInCompanyFromDOM(doc) || undefined;
    let title = doc.querySelector("h1")?.textContent?.trim();

    const parsed = parseLinkedInTitle(doc.title || "");
    if (parsed) {
      if (!title) title = parsed.title;
      if (!company) company = parsed.company;
    }

    if (!title) return null;

    const mainEl = doc.querySelector("main") || doc.querySelector('[role="main"]');
    const body = mainEl
      ? htmlToMarkdown(mainEl)
      : doc.body?.textContent?.trim() || "";

    if (body.length < MIN_BODY_LENGTH) return null;

    return {
      title,
      // A posting with no readable company is still worth capturing — the body
      // and URL carry real value — so this degrades rather than returning null.
      company: company || "Unknown",
      body,
      descriptionPreview: body.slice(0, 200),
      atsDetected: undefined,
      extractionTier: "dom_metadata",
    };
  },
};
