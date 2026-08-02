// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// Lever adapter.
//
// Lever splits a posting body across several `.section-wrapper` elements rather
// than nesting them under one container, so the body is assembled by concatenating
// them in document order — taking only the first would drop most of the JD.
//
// Per-host adapters are the last tier for the reason given in `../types.ts`.

import { htmlToMarkdown } from "../html-to-markdown";
import type { ATSExtractor, ExtractedPosting } from "../types";

export const lever: ATSExtractor = {
  name: "lever",

  // Exact host match: Lever serves postings only from this hostname, and a
  // suffix match would also claim unrelated `*.lever.co` marketing pages.
  matches(url: URL): boolean {
    return url.hostname === "jobs.lever.co";
  },

  extract(doc: Document, url: URL): ExtractedPosting | null {
    const title =
      doc.querySelector(".posting-headline h2")?.textContent?.trim() ||
      doc.querySelector("h1")?.textContent?.trim();
    if (!title) return null;

    // Lever URLs are `jobs.lever.co/<company>/<id>`, so the first path segment is
    // the company slug when the page doesn't name it.
    const company =
      doc.querySelector(".posting-headline .company-name")?.textContent?.trim() ||
      url.pathname.split("/")[1] ||
      "";

    const location =
      doc.querySelector(".posting-categories .location")?.textContent?.trim() ||
      doc
        .querySelector(".sort-by-time .posting-category:first-child")
        ?.textContent?.trim() ||
      undefined;

    // Lever is one of the few boards that publishes work model as its own field
    // rather than leaving it to prose.
    const workModel =
      doc.querySelector(".posting-categories .workplaceType")?.textContent?.trim() ||
      undefined;

    const contentSections = doc.querySelectorAll(".posting-page .section-wrapper");
    let body = "";
    contentSections.forEach((section) => {
      body += htmlToMarkdown(section) + "\n\n";
    });

    if (!body.trim()) {
      const contentEl = doc.querySelector(".content");
      body = contentEl
        ? htmlToMarkdown(contentEl)
        : doc.body?.textContent?.trim() || "";
    }

    body = body.trim();

    return {
      title,
      company,
      location,
      workModel,
      body,
      descriptionPreview: body.slice(0, 200),
      atsDetected: "lever",
      extractionTier: "ats_extractor",
    };
  },
};
