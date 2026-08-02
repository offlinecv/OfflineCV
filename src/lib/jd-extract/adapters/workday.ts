// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// Workday adapter.
//
// Workday matters here for a reason specific to this repo: `fetch-jd.ts` lists it
// as an unsupported host because its JSON endpoint sends no permissive CORS header,
// so the browser blocks the response. That closes the network path but not the DOM
// path — reading a Workday page the user already has open is exactly the case this
// lane exists to cover.
//
// Selectors key on `data-automation-id`, Workday's own stable test-hook attribute,
// rather than its generated CSS classes. The one `.css-…` selector below is a
// last-resort fallback and will rot; that is acceptable because it is reached only
// after the automation ids miss.
//
// Per-host adapters are the last tier for the reason given in `../types.ts`.

import { htmlToMarkdown } from "../html-to-markdown";
import type { ATSExtractor, ExtractedPosting } from "../types";

export const workday: ATSExtractor = {
  name: "workday",

  matches(url: URL): boolean {
    // The `wd1`/`wd5` hosts are data-center shards; each tenant is on exactly one,
    // and the bare suffix does not match them because they carry an extra label.
    return (
      url.hostname.endsWith(".myworkdayjobs.com") ||
      url.hostname.endsWith(".wd5.myworkdayjobs.com") ||
      url.hostname.endsWith(".wd1.myworkdayjobs.com")
    );
  },

  extract(doc: Document): ExtractedPosting | null {
    const title =
      doc
        .querySelector('[data-automation-id="jobPostingHeader"]')
        ?.textContent?.trim() ||
      doc
        .querySelector('h2[data-automation-id="jobPostingTitle"]')
        ?.textContent?.trim() ||
      doc.querySelector("h1")?.textContent?.trim();
    if (!title) return null;

    const company =
      doc
        .querySelector('[data-automation-id="jobPostingCompanyName"]')
        ?.textContent?.trim() ||
      doc.querySelector(".css-1q2dra3")?.textContent?.trim() ||
      "";

    const location =
      doc.querySelector('[data-automation-id="locations"]')?.textContent?.trim() ||
      doc
        .querySelector('[data-automation-id="jobPostingLocation"]')
        ?.textContent?.trim() ||
      undefined;

    const descEl =
      doc.querySelector('[data-automation-id="jobPostingDescription"]') ||
      doc.querySelector(".jobDescription");
    const body = descEl
      ? htmlToMarkdown(descEl)
      : doc.body?.textContent?.trim() || "";

    return {
      title,
      company,
      location,
      body,
      descriptionPreview: body.slice(0, 200),
      atsDetected: "workday",
      extractionTier: "ats_extractor",
    };
  },
};
