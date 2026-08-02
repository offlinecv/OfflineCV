// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

// Greenhouse adapter — the only one that handles two genuinely different page
// shapes, which is why it is the largest.
//
// A posting can be served directly on `boards.greenhouse.io`, or embedded into a
// company's own careers page through an iframe or a job-board script. The embedded
// case matters disproportionately: the visible URL is the company's domain, so
// nothing about it says "Greenhouse", and without recovering the underlying board
// URL the same posting saved from the company site and from the board itself forks
// into two records.
//
// Per-host adapters are the last tier for the reason given in `../types.ts`. This
// file only runs for pages the JSON-LD and metadata tiers could not read.

import { htmlToMarkdown } from "../html-to-markdown";
import type { ATSExtractor, ExtractedPosting } from "../types";

function isDirectGreenhouseHost(url: URL): boolean {
  return (
    url.hostname === "boards.greenhouse.io" ||
    url.hostname.endsWith(".greenhouse.io")
  );
}

export const greenhouse: ATSExtractor = {
  name: "greenhouse",

  matches(url: URL, doc: Document): boolean {
    if (isDirectGreenhouseHost(url)) return true;

    // Embedded fingerprints, in decreasing order of how conclusive they are.
    // `gh_jid` is Greenhouse's own job-id parameter and appears on the company's
    // URL; the element ids and the embed script are what the widget injects.
    if (url.searchParams.has("gh_jid")) return true;
    if (doc.getElementById("grnhse_iframe")) return true;
    if (doc.querySelector("#grnhse_app")) return true;
    if (doc.querySelector('script[src*="boards.greenhouse.io/embed"]')) return true;

    return false;
  },

  extract(doc: Document, url: URL): ExtractedPosting | null {
    return isDirectGreenhouseHost(url)
      ? extractDirectGreenhousePage(doc, url)
      : extractEmbeddedGreenhousePage(doc, url);
  },
};

function extractDirectGreenhousePage(
  doc: Document,
  url: URL,
): ExtractedPosting | null {
  const title =
    doc.querySelector("h1.app-title")?.textContent?.trim() ||
    doc.querySelector("h1")?.textContent?.trim();
  if (!title) return null;

  // Board URLs are `boards.greenhouse.io/<company>/jobs/<id>`, so the first path
  // segment is the company slug when the page itself doesn't name the company.
  const company =
    doc.querySelector(".company-name")?.textContent?.trim() ||
    url.pathname.split("/")[1] ||
    "";

  const location = doc.querySelector(".location")?.textContent?.trim() || undefined;

  const contentEl = doc.querySelector("#content") || doc.querySelector(".content");
  const body = contentEl
    ? htmlToMarkdown(contentEl)
    : doc.body?.textContent?.trim() || "";

  return {
    title,
    company,
    location,
    body,
    descriptionPreview: body.slice(0, 200),
    atsDetected: "greenhouse",
    extractionTier: "ats_extractor",
  };
}

/**
 * Recover the canonical board URL from an embedded widget.
 *
 * The description text lives inside the iframe and is cross-origin, so it is not
 * readable from here — this path deliberately returns an empty `body` and leans on
 * `atsUrl` instead. That is the useful half: with the canonical URL in hand, the
 * capture collapses onto the same record as the board page, and the body can be
 * fetched from Greenhouse's public API by the `ats_api` tier.
 *
 * Returns `null` without a job id, since `atsUrl` is the entire point of this path.
 */
function extractEmbeddedGreenhousePage(
  doc: Document,
  url: URL,
): ExtractedPosting | null {
  let jobId = url.searchParams.get("gh_jid") || undefined;
  let companySlug: string | undefined;

  const iframe = doc.getElementById("grnhse_iframe") as HTMLIFrameElement | null;
  if (iframe?.src) {
    const iframeMatch = iframe.src.match(
      /boards\.greenhouse\.io\/(\w[\w-]*)\/jobs\/(\d+)/,
    );
    if (iframeMatch) {
      companySlug = iframeMatch[1];
      jobId = jobId || iframeMatch[2];
    }
  }

  // The embed script names the board via `?for=<company>` even when no iframe
  // has rendered yet.
  if (!companySlug) {
    const embedScript = doc.querySelector(
      'script[src*="boards.greenhouse.io/embed"]',
    ) as HTMLScriptElement | null;
    if (embedScript?.src) {
      const forMatch = embedScript.src.match(/[?&]for=(\w[\w-]*)/);
      if (forMatch) companySlug = forMatch[1];
    }
  }

  if (!jobId) return null;

  const atsUrl = companySlug
    ? `https://boards.greenhouse.io/${companySlug}/jobs/${jobId}`
    : undefined;

  const title =
    doc.querySelector('meta[property="og:title"]')?.getAttribute("content")?.trim() ||
    doc.querySelector("h1")?.textContent?.trim() ||
    "";

  const company =
    doc
      .querySelector('meta[property="og:site_name"]')
      ?.getAttribute("content")
      ?.trim() ||
    url.hostname.replace(/^www\./, "").split(".")[0] ||
    "";

  return {
    title,
    company,
    location: undefined,
    body: "",
    descriptionPreview: "",
    atsDetected: "greenhouse",
    extractionTier: "ats_extractor",
    jobId,
    atsUrl,
  };
}
