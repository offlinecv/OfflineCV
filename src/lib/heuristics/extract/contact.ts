// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import type { PdfLine, PdfSection } from "../sections.ts";
import type { PdfLinkAnnotation } from "../types.ts";
import type { ProfileLink } from "../../score/types.ts";
import { profilesFromUrls } from "../../contact/profile-registry.ts";
import {
  LINKEDIN_NONPROFILE_RE,
  normalizeUrl,
  urlSlug,
} from "../../contact/url-utils.ts";
import {
  EMAIL_RE,
  LINKEDIN_RE,
  GITHUB_RE,
  URL_RE,
  US_LOCATION_RE,
  INTL_LOCATION_RE,
} from "../regex.ts";
import { escapeRegex } from "../../jd-match/regex-utils.ts";
import { findFirstPhone, regionFromLocation } from "../phone.ts";
import { firstMatch, allMatches, isStandaloneUrl } from "./shared.ts";

// ── Contact (email, phone, urls, location) ──────────────────────────────────

export interface ContactExtractionResult {
  email?: string;
  phone?: string;
  /** libphonenumber isValid() result for the extracted phone. Undefined when
   *  no phone was found or the caller did not supply validity signal. */
  phoneIsValid?: boolean;
  linkedin_url?: string;
  github_url?: string;
  portfolio_url?: string;
  website_url?: string;
  location?: string;
  /**
   * Classified contact links (#335), additive. Built from the four legacy
   * `*_url` values above in their fixed precedence order
   * `[linkedin, github, portfolio, website]`, so this mirrors — never
   * overrides — the legacy keys, keeping scoring and every corpus snapshot
   * byte-for-byte unchanged this phase. Empty when no link was detected.
   */
  profiles: ProfileLink[];
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
  /**
   * Provenance / ownership signal (#134). The `PdfLine`s document-wide whose
   * ENTIRE content was a promoted identity link (LinkedIn/GitHub) the contact
   * card claimed — optionally fronted by an introducing label ("LinkedIn:",
   * "Links —"). The caller removes these lines from every section's candidate
   * pool BEFORE the body extractors run, so a footer "Links" line lifted into
   * the contact card never also renders as a phantom project/achievement entry.
   *
   * Only *pure* identity-link lines are owned: a line that also carries real
   * prose (a bullet that merely mentions a repo, a deeper path under the same
   * handle, or a different longer handle) is NOT in this set and survives in the
   * body — the same identity boundary the retired `stripPromotedUrls` enforced,
   * now applied to whole-line ownership instead of after-the-fact slug
   * subtraction.
   */
  consumedLines: ReadonlySet<PdfLine>;
}

/** Result of a single regex scan over a text region — the contact fields and
 *  their confidences, before ownership is computed. `extractContact` combines a
 *  profile scan and a full-document scan into the public {@link
 *  ContactExtractionResult} (which adds `consumedLines`). */
type ContactScanResult = Omit<ContactExtractionResult, "consumedLines" | "profiles">;

/** True when `u` is a LinkedIn personal-profile URL. Accepts the canonical
 *  `linkedin.com/in/<handle>` and `linkedin.com/pub/...` as well as a vanity
 *  `linkedin.com/<handle>` that omits `/in/` — the latter is what makes a
 *  hyperlinked "LinkedIn" anchor resolve even when the target drops `/in/`. */
function isLinkedinProfileUrl(u: string): boolean {
  return /linkedin\.com\/[A-Za-z0-9]/i.test(u) && !LINKEDIN_NONPROFILE_RE.test(u);
}

/** Anchored `lnkd.in` shortlink test: a boundary before the host (string start,
 *  `//`, or a subdomain dot) and a path slash after. The anchors keep it precise
 *  — a plain `u.includes("lnkd.in")` would also match `blnkd.info` and a
 *  slash-less `lnkd.in`. Shared by {@link isLinkedinShapedUrl} and the
 *  website/portfolio exclusion, where it is the only LinkedIn signal the literal
 *  `linkedin.com` check there does not already cover. */
function isLnkdInShortlink(u: string): boolean {
  return /(?:^|\/\/|\.)lnkd\.in\//i.test(u);
}

/** True when `u` is a LinkedIn identity link on a KNOWN LinkedIn host — the
 *  canonical `linkedin.com` profile OR the `lnkd.in/...` shortlink domain. Both
 *  are host-anchored, so this is safe to run over doc-wide visible text without
 *  false positives. (The looser, host-agnostic `/in/<handle>` redirect shape is
 *  handled separately by {@link isLinkedinRedirectUrl}, which is restricted to
 *  authored link annotations — see #378.) */
function isLinkedinShapedUrl(u: string): boolean {
  return isLinkedinProfileUrl(u) || isLnkdInShortlink(u);
}

/** True when `u` is a LinkedIn-*shaped* profile redirect on a NON-`linkedin.com`
 *  host: `<host>/in/<handle>` as the sole path segment — a personal-domain
 *  redirect (`jane.dev/in/jane`) or (in our public, PII-safe fixtures) the
 *  synthetic `example.com/in/<handle>` convention that mirrors LinkedIn's real
 *  path shape. Résumés hyperlink a visible "LinkedIn" label to such a URL; since
 *  the annotation carries no anchor text (`PdfLinkAnnotation` has only the URL),
 *  the `/in/<handle>` shape is the only signal we get.
 *
 *  This is deliberately NOT part of {@link isLinkedinShapedUrl}: a bare `/in/`
 *  path is host-unbounded and matches non-LinkedIn URLs — India-locale paths
 *  (`nike.com/in/en`), catalog paths (`samsung.com/in/smartphones`), and
 *  mid-path `/in/` segments (`janedoe.com/portfolio/in/2023`). Applied over
 *  doc-wide *visible text* it would hijack `linkedin_url`. So it is used ONLY as
 *  an ANNOTATION predicate (an authored hyperlink is high-intent and rarely
 *  points at a locale/catalog page), and constrained to `/in/<handle>` as the
 *  first *and only* path segment with a ≥3-char handle — which rejects the
 *  mid-path and 2-letter-locale (`/in/en`, `/in/us`) cases outright (#378).
 *
 *  ACCEPTED TRADEOFF: the handle is not name-shape-checked, so a sole-segment
 *  non-LinkedIn `/in/<≥3>` link — a personal portfolio at
 *  `janedoe.com/in/design-portfolio`, or `acme.com/in/careers` — is claimed as
 *  LinkedIn when it sits in the contact block. No regex cleanly separates
 *  `/in/jane-doe` from `/in/design-portfolio` (both are hyphenated), so the
 *  profile-band restriction (the caller only applies this predicate to
 *  contact-block annotations) IS the mitigation: an authored `/in/`-shaped link
 *  in the header is far more likely a "LinkedIn" label than a catalog page.
 *  Pinned by test rather than narrowed further. */
function isLinkedinRedirectUrl(u: string): boolean {
  if (isLinkedinShapedUrl(u)) return true;
  // The host must carry a dot (`acme.com`, not a dotless `foo`/`localhost`) —
  // a real personal-domain redirect is an absolute host, and requiring the dot
  // drops `foo/in/jane` / `localhost/in/team` false positives. The terminator
  // allows an optional query/fragment (`?utm_source=cv`, `#about`) — tracking
  // params on a résumé link are common — while the locale/mid-path cases are
  // still rejected on handle length and segment position, not the terminator.
  return /^(?:https?:\/\/)?(?:www\.)?[^/\s]+\.[^/\s]+\/in\/[A-Za-z0-9][A-Za-z0-9._-]{2,}\/?(?:[?#]\S*)?$/i.test(
    u,
  );
}

// ── Promoted-identity-link ownership (#134) ─────────────────────────────────
// LinkedIn/GitHub identity links are matched document-wide (see `anywhereOnDoc`
// below), so an identity link sitting in a "Links"/footer block that segmented
// into a body section is promoted into the contact card. That same line would
// otherwise survive as a phantom entry whose only content is the bare URL.
// Instead of scrubbing the URL out of every rendered body after extraction
// (the retired `stripPromotedUrls`), the contact extractor CLAIMS the lines it
// consumed: any line that is nothing but the promoted identity link(s) — plus
// an optional introducing label — is reported on `consumedLines`, and the
// caller drops those lines from the candidate pools before the body extractors
// run. Ownership is recorded here, at the single point the link is promoted.

/** Leading introducing label that a bare identity link sits behind ("LinkedIn:",
 *  "GitHub —", "Links", "Find me online") — stripped before testing whether a
 *  line is nothing but its promoted URL(s). */
const PROMOTED_LABEL_PREFIX_RE =
  /^[•\-–—*\s]*(?:linkedin|github|profile|portfolio|links?|find me(?: online)?|connect|social(?: media)?|online|website)\b[\s:|/–—-]*/i;

/**
 * Decide which `lines` the contact card has consumed: a line is OWNED iff,
 * after removing every promoted identity URL AT THE EXACT-IDENTITY BOUNDARY and
 * then stripping an optional introducing label, nothing else remains. (URLs are
 * removed before the label so the label regex — whose alternatives include
 * "github"/"linkedin" — cannot chew the host out of the URL itself.)
 *
 * The `(?![\w./-])` lookahead is the load-bearing precision rule (carried over
 * from the retired `stripPromotedUrls`): the slug matches the identity link
 * itself, NOT a deeper path or longer handle under it. So a bare
 * "github.com/x" line is owned and dropped, while a real bullet mentioning
 * "github.com/x/some-repo" or a different handle "github.com/x-team" leaves a
 * residue and is therefore NOT owned — it survives in the body.
 */
function findConsumedLines(
  lines: PdfLine[],
  promotedSlugs: string[],
): Set<PdfLine> {
  const consumed = new Set<PdfLine>();
  if (promotedSlugs.length === 0) return consumed;
  const matchers = promotedSlugs.map(
    (slug) =>
      new RegExp(
        `(?:https?:\\/\\/)?(?:www\\.)?${escapeRegex(slug)}\\/?(?![\\w./-])`,
        "ig",
      ),
  );
  for (const line of lines) {
    // Remove the identity URL(s) FIRST — before any label strip — so the label
    // regex (whose alternatives include "github"/"linkedin") can never chew the
    // host out of the URL itself ("github.com/x"). Each matcher's `(?![\w./-])`
    // boundary keeps a deeper path / longer handle intact (#134 precision rule).
    let residue = line.text;
    let hadMatch = false;
    for (const re of matchers) {
      re.lastIndex = 0;
      if (re.test(residue)) hadMatch = true;
      re.lastIndex = 0;
      residue = residue.replace(re, " ");
    }
    if (!hadMatch) continue;
    // With the URL(s) gone, strip an introducing label ("LinkedIn:", "Links —").
    residue = residue.replace(PROMOTED_LABEL_PREFIX_RE, "");
    // Owned only when the URL(s) (and the label) were the WHOLE line — any real
    // prose left over means this is a genuine body line, not a phantom.
    const leftover = residue.replace(/[•\-–—*\s|/]+/g, "");
    if (leftover.length === 0) consumed.add(line);
  }
  return consumed;
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

/** TLDs we accept on a *scheme-less* bare-domain website/portfolio candidate.
 *  `URL_RE`'s domain branch matches any `token.token`, so a skill like
 *  `Node.js`, a sentence's `etc.`, or a filename looks like a domain. Requiring
 *  a recognized TLD keeps real bare hosts (`jane.dev`) while rejecting those
 *  false positives. URLs that carry an explicit scheme or `www.` bypass this. */
const COMMON_WEBSITE_TLDS = new Set([
  "com", "org", "net", "io", "dev", "me", "co", "app", "ai", "xyz", "tech",
  "page", "site", "info", "blog", "design", "edu", "gov", "us", "uk", "ca",
  "in", "au", "de", "fr", "nl", "eu",
]);

/** True when a `URL_RE` hit is plausibly a real website, not a `Node.js`-style
 *  token that merely contains a dot. A scheme or `www.` is sufficient; a bare
 *  host must end in a recognized TLD. */
function looksLikeRealWebsite(u: string): boolean {
  if (/^https?:\/\//i.test(u) || /^www\./i.test(u)) return true;
  const host = u.toLowerCase().split("/")[0];
  const tld = host.slice(host.lastIndexOf(".") + 1);
  return COMMON_WEBSITE_TLDS.has(tld);
}

/**
 * Collects URLs from `joined` that are not LinkedIn or GitHub links and
 * splits them into `portfolio` and `website` buckets.
 *
 * "Other URLs" are those whose lowercased form does not include `linkedin.com`
 * or `github.com`. Portfolio wins if the URL matches a portfolio-indicator
 * pattern; the first remaining URL becomes the website candidate.
 *
 * A bare domain is only accepted as a contact link when it is positionally
 * standalone in the text — not flanked by word characters on both sides. A
 * domain mid-sentence ("sold return2india.com to Satyam") is prose, not a
 * contact URL (#237). URLs with an explicit scheme or `www.` are always
 * accepted regardless of position.
 */
function extractOtherUrls(joined: string): {
  portfolio: string | undefined;
  website: string | undefined;
} {
  // Blank out emails first: an address like `jane@uw.edu` carries a bare domain
  // (`uw.edu`) and `URL_RE`'s domain branch matches it (the `@` is a word
  // boundary), phantom-promoting the email's host to a website. LinkedIn/GitHub
  // and portfolio/website all want real links, never the email domain.
  const withoutEmails = joined.replace(EMAIL_RE, " ");
  const others = allMatches(URL_RE, withoutEmails).filter((u) => {
    const lower = u.toLowerCase();
    // Exclude any linkedin.com URL (profile OR non-profile company/jobs/feed
    // pages — the literal-host guard keeps those out of website_url), the
    // `lnkd.in` shortlink host, and github.com. The literal `linkedin.com`
    // check is load-bearing: it also catches non-profile `linkedin.com/company/…`
    // pages, which the shortlink test does not (#378). The three terms are
    // uniform host checks — `lnkd.in` is the one LinkedIn signal `linkedin.com`
    // doesn't already cover.
    if (
      lower.includes("linkedin.com") ||
      isLnkdInShortlink(u) ||
      lower.includes("github.com")
    ) {
      return false;
    }
    // Reject `token.token` false positives (skills like `Node.js`, `etc.`).
    if (!looksLikeRealWebsite(u)) return false;
    // Reject a bare domain mid-sentence in prose (e.g. "sold return2india.com
    // to Satyam"). A URL with an explicit scheme or www. is always standalone.
    return isStandaloneUrl(u, withoutEmails);
  });
  const portfolio = others.find((u) =>
    /(portfolio|\.me\b|\.io\b|\.dev\b|behance|dribbble|medium)/i.test(u),
  );
  const websiteCandidates = others.filter((u) => u !== portfolio);
  return { portfolio, website: websiteCandidates[0] };
}

function scan(lines: PdfLine[], joined: string): ContactScanResult {
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
    allMatches(URL_RE, joined).find(isLinkedinShapedUrl);
  const github = firstMatch(GITHUB_RE, joined);

  // Other URLs that aren't linkedin/github → portfolio/website bucket.
  const { portfolio, website } = extractOtherUrls(joined);

  return {
    email,
    phone,
    ...(phone !== undefined ? { phoneIsValid: phoneResult?.isValid } : {}),
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
  // ("LinkedIn", "GitHub") only show up here. GitHub, and LinkedIn on a KNOWN
  // host (linkedin.com / lnkd.in), are matched document-wide (see `anywhereOnDoc`
  // below) — the host anchors them. The host-agnostic LinkedIn `/in/<handle>`
  // redirect has no host anchor, so its lookup is section-banded like
  // portfolio/website (see the two-tier `linkedin` resolver below).
  // Portfolio/website use the profile-section boundary — the profile section
  // covers everything above the first recognized header, which is exactly
  // the contact/links block. Annotations whose top edge falls within (or just
  // below) the last profile line are accepted; this replaces the old fixed
  // 280-PDF-points proxy (#135).
  //
  // Implementation: collect the max y of any profile line and add a small
  // slack (12 pts ≈ one line-height) so an annotation rect whose anchor
  // sits a hair below the last text line is still accepted. When the profile
  // has no lines (edge case: empty document / single-section resume) we
  // accept any annotation on page 1 as a conservative fallback.
  const profileLineMaxY: number = profile.lines.length > 0
    ? Math.max(...profile.lines.map((l) => l.y))
    : Infinity; // Infinity → accept everything on page 1
  const PROFILE_REGION_SLACK_PTS = 12;
  const inProfileSection = (ann: PdfLinkAnnotation): boolean =>
    ann.page === 1 &&
    ann.yTop <= profileLineMaxY + PROFILE_REGION_SLACK_PTS;

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

  // `isLinkedinUrl` classifies a URL as LinkedIn for the portfolio/website
  // EXCLUSIONS below (a `/in/` redirect must never also read as a website). The
  // annotation LOOKUP for the linkedin slot is split by host anchor — see the
  // two-tier resolver on `linkedin` below.
  const isLinkedinUrl = isLinkedinRedirectUrl;
  const isGithubUrl = (u: string) =>
    /github\.com\//i.test(u) && !/github\.com\/(orgs|topics|search)/i.test(u);
  const isPortfolioUrl = (u: string) =>
    /(portfolio|\.me\b|\.io\b|\.dev\b|behance|dribbble|medium|framer\.website)/i.test(
      u,
    );

  // `reject` runs against EVERY tier's candidate — the text-scan primary/
  // fallback values as well as the annotation — so a URL already claimed by a
  // higher-priority field can't re-enter through the text scan. Without it a
  // `/in/` redirect printed as its own label (LaTeX `\href{url}{url}`) fills
  // `linkedin_url` from the annotation AND `website_url` from the text scan —
  // the exact double-render this PR removes (#378).
  const pickUrl = <K extends "linkedin_url" | "github_url" | "portfolio_url" | "website_url">(
    key: K,
    resolveAnnotation: () => string | undefined,
    reject?: (url: string) => boolean,
  ): { value: string | undefined; confidence: number } => {
    if (primary[key] && !reject?.(primary[key]!))
      return { value: primary[key], confidence: primary.confidence[key] };
    if (fallback[key] && !reject?.(fallback[key]!))
      return {
        value: fallback[key],
        confidence: fallback.confidence[key] * 0.9,
      };
    const annUrl = resolveAnnotation();
    if (annUrl && !reject?.(annUrl))
      return { value: annUrl, confidence: 0.95 };
    return { value: undefined, confidence: 0 };
  };

  // A hyperlinked "LinkedIn" label often points at a non-linkedin.com redirect
  // whose path is still the `/in/<handle>` profile shape. Two-tier lookup, split
  // by whether the host anchors the match:
  //   1. Known LinkedIn hosts (`linkedin.com` / `lnkd.in`) — the host anchors
  //      the match, so it is safe ANYWHERE on the doc (a footer/icon link).
  //   2. Host-agnostic `/in/<handle>` redirect — no host anchor, so confine it
  //      to the profile band, where an authored "LinkedIn" label actually lives.
  //      Otherwise a body link like `acme.com/in/analytics` (sole segment, ≥3
  //      chars) would win the linkedin_url slot ahead of github/portfolio/
  //      website (#378 follow-up).
  const linkedin = pickUrl(
    "linkedin_url",
    () =>
      findAnnotationUrl(isLinkedinShapedUrl, anywhereOnDoc) ??
      findAnnotationUrl(
        (u) => isLinkedinRedirectUrl(u) && !isLinkedinShapedUrl(u),
        inProfileSection,
      ),
  );
  const github = pickUrl("github_url", () =>
    findAnnotationUrl(isGithubUrl, anywhereOnDoc),
  );
  // A URL is "the same claim" across tiers regardless of scheme/`www.`/case/
  // trailing slash or punctuation, so compare on `urlSlug` — the identity form
  // (`normalizeUrl` strips the trailing slash but preserves case, so `.../Jane`
  // and `.../jane` would read as different claims and the cross-tier dedup would
  // silently no-op). Same helper the ownership dedup below uses.
  const claimKey = (u: string): string => urlSlug(u) ?? u;
  const claimedByIdentity = new Set(
    [linkedin.value, github.value]
      .filter((u): u is string => Boolean(u))
      .map(claimKey),
  );
  const portfolio = pickUrl(
    "portfolio_url",
    () =>
      findAnnotationUrl(
        (u) => isPortfolioUrl(u) && !isLinkedinUrl(u) && !isGithubUrl(u),
        inProfileSection,
      ),
    (u) => claimedByIdentity.has(claimKey(u)),
  );
  // Website is the catch-all: any remaining URL not already claimed by
  // linkedin/github/portfolio — on ANY tier (text scan or annotation), so a
  // `/in/` redirect that is both visible text and a hyperlink can't fill both
  // linkedin_url and website_url (#378).
  const claimedUrls = new Set(
    [linkedin.value, github.value, portfolio.value]
      .filter((u): u is string => Boolean(u))
      .map(claimKey),
  );
  const website = pickUrl(
    "website_url",
    () =>
      findAnnotationUrl(
        (u) =>
          !isLinkedinUrl(u) &&
          !isGithubUrl(u) &&
          !u.startsWith("mailto:") &&
          !u.startsWith("tel:"),
        inProfileSection,
      ),
    (u) => claimedUrls.has(claimKey(u)),
  );

  // Ownership (#134): claim the document-wide body lines that are nothing but a
  // promoted identity link. Slugs are derived from the *claimed* linkedin/github
  // values — whether they came from the profile, the full-doc fallback, or an
  // annotation — so the line that carried the link is removed from the body
  // pools and never renders a second time. Only LinkedIn/GitHub participate:
  // those are the identity links matched document-wide and thus the only ones
  // that produce phantom body entries (portfolio/website stay header-banded).
  const promotedSlugs = [
    urlSlug(linkedin.value),
    urlSlug(github.value),
  ].filter((s): s is string => s !== undefined);
  const consumedLines = findConsumedLines(allLines, promotedSlugs);

  // Additive `profiles[]` (#335): classify the four legacy link values in their
  // fixed precedence order. The legacy keys below are UNCHANGED — `profiles`
  // mirrors them, so scoring and every corpus snapshot stay byte-for-byte
  // identical this phase. `normalizeUrl` is applied inside `classifyProfile`,
  // matching the legacy keys' own `normalizeUrl(...)` wrapping.
  const profiles = profilesFromUrls([
    linkedin.value,
    github.value,
    portfolio.value,
    website.value,
  ]);

  return {
    email: primary.email ?? fallback.email,
    phone: primary.phone ?? fallback.phone,
    phoneIsValid: primary.phone ? primary.phoneIsValid : fallback.phoneIsValid,
    linkedin_url: normalizeUrl(linkedin.value),
    github_url: normalizeUrl(github.value),
    portfolio_url: normalizeUrl(portfolio.value),
    website_url: normalizeUrl(website.value),
    profiles,
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
    consumedLines,
  };
}
