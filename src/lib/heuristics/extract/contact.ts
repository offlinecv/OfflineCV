// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

import type { PdfLine, PdfSection } from "../sections.ts";
import type { PdfLinkAnnotation } from "../types.ts";
import {
  EMAIL_RE,
  LINKEDIN_RE,
  GITHUB_RE,
  URL_RE,
  US_LOCATION_RE,
  INTL_LOCATION_RE,
} from "../regex.ts";
import { findFirstPhone, regionFromLocation } from "../phone.ts";
import { firstMatch, allMatches } from "./shared.ts";

// ── Contact (email, phone, urls, location) ──────────────────────────────────

interface ContactExtractionResult {
  email?: string;
  phone?: string;
  linkedin_url?: string;
  github_url?: string;
  portfolio_url?: string;
  website_url?: string;
  location?: string;
  /** Per-field confidence for the cascade's field-confidence map. */
  confidence: {
    email: number;
    phone: number;
    linkedin_url: number;
    github_url: number;
    portfolio_url: number;
    website_url: number;
    location: number;
  };
}

/** LinkedIn paths that are NOT a personal profile — feed, company pages, job
 *  posts, articles, etc. Everything else under `linkedin.com/<handle>` (the
 *  `/in/<handle>` canonical form AND bare-vanity hosts) is treated as a
 *  profile, mirroring GitHub's "any `github.com/<user>`" rule. */
const LINKEDIN_NONPROFILE_RE =
  /linkedin\.com\/(company|jobs|feed|school|learning|pulse|posts|groups|showcase|games|events|help|legal|search|signup|login|home)\b/i;

/** True when `u` is a LinkedIn personal-profile URL. Accepts the canonical
 *  `linkedin.com/in/<handle>` and `linkedin.com/pub/...` as well as a vanity
 *  `linkedin.com/<handle>` that omits `/in/` — the latter is what makes a
 *  hyperlinked "LinkedIn" anchor resolve even when the target drops `/in/`. */
function isLinkedinProfileUrl(u: string): boolean {
  return /linkedin\.com\/[A-Za-z0-9]/i.test(u) && !LINKEDIN_NONPROFILE_RE.test(u);
}

function normalizeUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.replace(/[,;.)]$/, "").trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

/**
 * Scans `lines` for a candidate location string, checking US patterns first
 * then international. Returns the first match found, or `undefined`.
 *
 * `location` is intentionally not subject to the document-wide fallback —
 * see the doc-comment on `extractContact` for the reasoning.
 */
function extractLocation(lines: PdfLine[]): string | undefined {
  for (const line of lines) {
    const us = US_LOCATION_RE.exec(line.text);
    if (us) return us[0];
  }
  for (const line of lines) {
    const intl = INTL_LOCATION_RE.exec(line.text);
    if (intl && !/@/.test(intl[0])) return intl[0];
  }
  return undefined;
}

/**
 * Collects URLs from `joined` that are not LinkedIn or GitHub links and
 * splits them into `portfolio` and `website` buckets.
 *
 * "Other URLs" are those whose lowercased form does not include `linkedin.com`
 * or `github.com`. Portfolio wins if the URL matches a portfolio-indicator
 * pattern; the first remaining URL becomes the website candidate.
 */
function extractOtherUrls(joined: string): {
  portfolio: string | undefined;
  website: string | undefined;
} {
  const others = allMatches(URL_RE, joined).filter((u) => {
    const lower = u.toLowerCase();
    return !lower.includes("linkedin.com") && !lower.includes("github.com");
  });
  const portfolio = others.find((u) =>
    /(portfolio|\.me\b|\.io\b|\.dev\b|behance|dribbble|medium)/i.test(u),
  );
  const websiteCandidates = others.filter((u) => u !== portfolio);
  return { portfolio, website: websiteCandidates[0] };
}

function scan(lines: PdfLine[], joined: string): ContactExtractionResult {
  const email = firstMatch(EMAIL_RE, joined);

  // Extract location BEFORE phone so we can derive the parse region.
  const location = extractLocation(lines);

  // Derive the phone parse region from the extracted location; fall back to
  // "US" when the location is absent or the country is not in our mapping.
  const phoneRegion = regionFromLocation(location) ?? "US";
  const phoneResult = findFirstPhone(joined, phoneRegion);
  const phone = phoneResult?.formatted;

  // LinkedIn profile URLs are usually `/in/<handle>` (LINKEDIN_RE), but some
  // resumes link a bare vanity host (`linkedin.com/<handle>`). Fall back to
  // any linkedin.com URL that is a profile (not /company, /jobs, … sections)
  // so a hyperlinked "LinkedIn" anchor resolves regardless of the path shape.
  const linkedin =
    firstMatch(LINKEDIN_RE, joined) ??
    allMatches(URL_RE, joined).find(isLinkedinProfileUrl);
  const github = firstMatch(GITHUB_RE, joined);

  // Other URLs that aren't linkedin/github → portfolio/website bucket.
  const { portfolio, website } = extractOtherUrls(joined);

  return {
    email,
    phone,
    linkedin_url: normalizeUrl(linkedin),
    github_url: normalizeUrl(github),
    portfolio_url: normalizeUrl(portfolio),
    website_url: normalizeUrl(website),
    location,
    confidence: {
      email: email ? 0.98 : 0,
      phone: phone ? 0.85 : 0,
      linkedin_url: linkedin ? 0.95 : 0,
      github_url: github ? 0.95 : 0,
      portfolio_url: portfolio ? 0.6 : 0,
      website_url: website ? 0.55 : 0,
      location: location ? 0.75 : 0,
    },
  };
}

/**
 * Walks the profile section (and optionally the full document as a fallback)
 * gathering contact fields. Regex-driven; very high precision.
 *
 * `location` is intentionally NOT subject to the document-wide fallback —
 * a non-header city/state is almost always an employer or school location,
 * not the candidate's. Names, emails, phones, and URLs can survive being
 * outside the profile (footer placement is common); location cannot.
 *
 * When PDF Link annotations are available, they're consulted as
 * a last-chance signal for `linkedin_url`, `github_url`, `portfolio_url`,
 * and `website_url` — these are the URL fields that resumes most often
 * hyperlink behind a visible word ("LinkedIn" / "GitHub" / "Portfolio")
 * rather than rendering as full text. Annotation hits report 0.95
 * confidence, matching the text-hit confidence, because the URL is
 * structurally guaranteed by the PDF.
 */
export function extractContact(
  profile: PdfSection,
  allLines: PdfLine[],
  annotations: PdfLinkAnnotation[] = [],
): ContactExtractionResult {
  const profileText = profile.lines.map((l) => l.text).join(" ");
  const primary = scan(profile.lines, profileText);

  // Fallback: sometimes contact info is scattered outside the profile header
  // (e.g. footer). Fill any missing field from the full-document scan —
  // EXCEPT location, which is bug-prone outside the profile band.
  const fullText = allLines.map((l) => l.text).join(" ");
  const fallback = scan(allLines, fullText);

  // Annotation fallback: URLs hyperlinked behind a visible word
  // ("LinkedIn", "GitHub") only show up here. LinkedIn/GitHub are matched
  // document-wide (see `anywhereOnDoc` below); only the looser-but-still-bounded
  // portfolio/website lookup keeps a Y-band.
  // Portfolio/website use a header-region band — some design templates
  // place the portfolio link in a sidebar or under the name block. "Top
  // third of page 1" approximated with a fixed PDF-points cutoff that
  // works for both Letter (792pt) and A4 (842pt).
  const inHeaderRegion = (ann: PdfLinkAnnotation) =>
    ann.page === 1 && ann.yTop < 280;
  // LinkedIn / GitHub identity links are commonly hyperlinked behind an icon
  // placed in a footer or a "Links"/"Contact" block below a later heading
  // (e.g. after Skills), so the profile-band filter dropped them. The
  // `linkedin.com/in/<user>` / `github.com/<user>` predicates are specific
  // enough that a document-wide match is safe — a stray profile link in a
  // project description is rare and low-stakes vs. silently losing the link.
  const anywhereOnDoc = () => true;

  const findAnnotationUrl = (
    predicate: (url: string) => boolean,
    band: (ann: PdfLinkAnnotation) => boolean,
  ): string | undefined => {
    for (const ann of annotations) {
      if (!band(ann)) continue;
      if (predicate(ann.url)) return ann.url;
    }
    return undefined;
  };

  const isLinkedinUrl = isLinkedinProfileUrl;
  const isGithubUrl = (u: string) =>
    /github\.com\//i.test(u) && !/github\.com\/(orgs|topics|search)/i.test(u);
  const isPortfolioUrl = (u: string) =>
    /(portfolio|\.me\b|\.io\b|\.dev\b|behance|dribbble|medium|framer\.website)/i.test(
      u,
    );

  const pickUrl = <K extends "linkedin_url" | "github_url" | "portfolio_url" | "website_url">(
    key: K,
    annotationPredicate: (url: string) => boolean,
    band: (ann: PdfLinkAnnotation) => boolean,
  ): { value: string | undefined; confidence: number } => {
    if (primary[key])
      return { value: primary[key], confidence: primary.confidence[key] };
    if (fallback[key])
      return {
        value: fallback[key],
        confidence: fallback.confidence[key] * 0.9,
      };
    const annUrl = findAnnotationUrl(annotationPredicate, band);
    if (annUrl) return { value: annUrl, confidence: 0.95 };
    return { value: undefined, confidence: 0 };
  };

  const linkedin = pickUrl("linkedin_url", isLinkedinUrl, anywhereOnDoc);
  const github = pickUrl("github_url", isGithubUrl, anywhereOnDoc);
  const portfolio = pickUrl(
    "portfolio_url",
    (u) => isPortfolioUrl(u) && !isLinkedinUrl(u) && !isGithubUrl(u),
    inHeaderRegion,
  );
  // Website is the catch-all: any remaining annotation URL not already
  // claimed by linkedin/github/portfolio.
  const claimedUrls = new Set(
    [linkedin.value, github.value, portfolio.value].filter(Boolean) as string[],
  );
  const website = pickUrl(
    "website_url",
    (u) =>
      !claimedUrls.has(u) &&
      !isLinkedinUrl(u) &&
      !isGithubUrl(u) &&
      !u.startsWith("mailto:") &&
      !u.startsWith("tel:"),
    inHeaderRegion,
  );

  return {
    email: primary.email ?? fallback.email,
    phone: primary.phone ?? fallback.phone,
    linkedin_url: normalizeUrl(linkedin.value),
    github_url: normalizeUrl(github.value),
    portfolio_url: normalizeUrl(portfolio.value),
    website_url: normalizeUrl(website.value),
    // No fallback for location — see comment above.
    location: primary.location,
    confidence: {
      email: Math.max(primary.confidence.email, fallback.confidence.email * 0.8),
      phone: Math.max(primary.confidence.phone, fallback.confidence.phone * 0.8),
      linkedin_url: linkedin.confidence,
      github_url: github.confidence,
      portfolio_url: portfolio.confidence,
      website_url: website.confidence,
      location: primary.confidence.location,
    },
  };
}
