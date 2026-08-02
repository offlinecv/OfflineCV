// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// Oracle HCM Cloud adapter.
//
// Oracle is self-hosted per tenant, so there is no single hostname to key on. The
// three fingerprints below are ordered from cheapest to most specific: the shared
// `oraclecloud.com` domain, then Oracle's distinctive UI path segments (`/hcmUI/`,
// `/fscmUI/`) which appear on tenant-owned domains, then the `generator` meta tag
// as a last resort for a tenant that rewrote both.
//
// Per-host adapters are the last tier for the reason given in `../types.ts`.

import { htmlToMarkdown } from "../html-to-markdown";
import type { ATSExtractor, ExtractedPosting } from "../types";

export const oracleHcm: ATSExtractor = {
  name: "oracle-hcm",

  matches(url: URL, doc: Document): boolean {
    if (url.hostname.includes(".oraclecloud.com")) return true;
    if (url.pathname.includes("/hcmUI/") || url.pathname.includes("/fscmUI/")) {
      return true;
    }
    const generator =
      doc.querySelector('meta[name="generator"]')?.getAttribute("content") || "";
    return generator.toLowerCase().includes("oracle");
  },

  extract(doc: Document): ExtractedPosting | null {
    const title =
      doc.querySelector(".job-title")?.textContent?.trim() ||
      doc.querySelector("h1.app-heading")?.textContent?.trim() ||
      doc.querySelector("h1")?.textContent?.trim();
    if (!title) return null;

    const company =
      doc.querySelector(".job-company")?.textContent?.trim() ||
      doc.querySelector(".company-name")?.textContent?.trim() ||
      "";

    const location =
      doc.querySelector(".job-location")?.textContent?.trim() || undefined;

    const descEl =
      doc.querySelector(".job-description") ||
      doc.querySelector('[class*="jobDescription"]');
    const body = descEl
      ? htmlToMarkdown(descEl)
      : doc.body?.textContent?.trim() || "";

    return {
      title,
      company,
      location,
      body,
      descriptionPreview: body.slice(0, 200),
      atsDetected: "oracle-hcm",
      extractionTier: "ats_extractor",
    };
  },
};
