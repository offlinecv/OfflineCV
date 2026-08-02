// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// SmartRecruiters adapter.
//
// The title selectors are ordered deliberately and the order is the whole point:
// SmartRecruiters serves an IE11 sunset notice whose `<h1>` appears BEFORE the real
// job title in document order. A generic `h1` read — which every other adapter uses
// as its fallback — captures that banner instead of the posting. So the
// SmartRecruiters-specific classes are tried first and `h1` is not a fallback here
// at all; `og:title` is used instead.
//
// Per-host adapters are the last tier for the reason given in `../types.ts`.

import { htmlToMarkdown } from "../html-to-markdown";
import type { ATSExtractor, ExtractedPosting } from "../types";

/** See `../adapters/linkedin.ts` — below this, the container held page chrome. */
const MIN_BODY_LENGTH = 100;

export const smartrecruiters: ATSExtractor = {
  name: "smartrecruiters",

  matches(url: URL): boolean {
    return (
      url.hostname === "jobs.smartrecruiters.com" ||
      url.hostname.endsWith(".smartrecruiters.com")
    );
  },

  extract(doc: Document, url: URL): ExtractedPosting | null {
    const title =
      doc.querySelector(".summary-title")?.textContent?.trim() ||
      doc.querySelector(".job-title")?.textContent?.trim() ||
      doc.querySelector('meta[property="og:title"]')?.getAttribute("content")?.trim();
    if (!title) return null;

    // URLs are `jobs.smartrecruiters.com/<Company>/<id>-<slug>`.
    const pathCompany = url.pathname.split("/")[1];
    const ogSiteName = doc
      .querySelector('meta[property="og:site_name"]')
      ?.getAttribute("content");
    const company = ogSiteName || pathCompany || "";

    const locationEl =
      doc.querySelector(".job-details .location") ||
      doc.querySelector('[class*="location"]');
    const location = locationEl?.textContent?.trim() || undefined;

    const contentEl =
      doc.querySelector(".jobad-container") ||
      doc.querySelector('[role="main"]') ||
      doc.querySelector("main");
    const body = contentEl
      ? htmlToMarkdown(contentEl)
      : doc.body?.textContent?.trim() || "";

    if (body.length < MIN_BODY_LENGTH) return null;

    // Requisition ids are long numeric runs; the 10-digit floor keeps a short
    // number elsewhere in the path from being mistaken for one.
    const idMatch = url.pathname.match(/\/(\d{10,})/);
    const jobId = idMatch?.[1] || undefined;

    return {
      title,
      company,
      location,
      jobId,
      body,
      descriptionPreview: body.slice(0, 200),
      atsDetected: "smartrecruiters",
      extractionTier: "ats_extractor",
    };
  },
};
