// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Field-level extractors consumed by the Tier 1 heuristic parser.
 *
 * Every extractor takes structured `PdfLine`s and returns `{ value, confidence }`
 * (or the array form for list fields). Confidence is a 0..1 score based on how
 * many positive features the extractor observed — it is NOT a probability, just
 * a monotonic signal the cascade uses for escalation decisions.
 */

import type {
  ResumeExperience,
  ResumeEducation,
  ResumeProject,
  HeuristicAchievement,
} from "../score/types.ts";
import type { PdfLine, PdfSection } from "./sections.ts";
import { mergeItemText } from "./sections.ts";
import { matchSectionHeader } from "./regex.ts";
import type { PdfLinkAnnotation, PdfTextItem } from "./types.ts";
import {
  EMAIL_RE,
  PHONE_RE,
  LINKEDIN_RE,
  GITHUB_RE,
  URL_RE,
  US_LOCATION_RE,
  INTL_LOCATION_RE,
  YEAR_RE,
  MONTH_YEAR_RE,
  NUMERIC_MONTH_YEAR_RE,
  DEGREE_RE,
  INSTITUTION_HINTS,
  COMPANY_SUFFIX_RE,
} from "./regex.ts";
import { findFirstPhone, regionFromLocation } from "./phone.ts";
import { parseEntryBlocks } from "./entry-blocks.ts";
import type { EntryBlock } from "./entry-blocks.ts";
import {
  isBulletLine,
  stripBullet,
  parseDateRange,
  normalizeDate,
} from "./line-primitives.ts";

// ── Small utilities ─────────────────────────────────────────────────────────

/** First regex hit as trimmed string, or undefined. */
function firstMatch(re: RegExp, text: string): string | undefined {
  // Re-init lastIndex for global regexes so calls are idempotent.
  re.lastIndex = 0;
  const match = re.exec(text);
  return match?.[0]?.trim();
}

/** All regex hits, deduped. */
function allMatches(re: RegExp, text: string): string[] {
  re.lastIndex = 0;
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.add(m[0].trim());
  return [...out];
}

// ── Name ────────────────────────────────────────────────────────────────────

/**
 * Words that signal "this is a resume document title, not the candidate's name"
 * — e.g. "Functional Resume Sample", "Chronological CV Template". Conservative:
 * "Jane Smith Resume" still passes because only one of three words is boilerplate.
 * See `looksLikeDocTitleBoilerplate` below for the rule.
 */
const NAME_BOILERPLATE_WORDS = new Set([
  "resume",
  "résumé",
  "cv",
  "curriculum",
  "vitae",
  "sample",
  "template",
  "example",
  "draft",
  "chronological",
  "functional",
  "combination",
  "profile",
  "biography",
]);

/**
 * True when the line is mostly resume-document-title boilerplate rather than
 * a person's name. Requires *all* tokens to be boilerplate (or ≥2 boilerplate
 * tokens out of ≤3 total). Tuned so "Jane Smith" passes and "Resume" / "CV
 * Sample" / "Functional Resume Sample" / "Curriculum Vitae" all reject.
 */
function looksLikeDocTitleBoilerplate(words: string[]): boolean {
  const lowered = words.map((w) => w.toLowerCase().replace(/[^a-z]/g, ""));
  const hits = lowered.filter((w) => NAME_BOILERPLATE_WORDS.has(w)).length;
  if (hits === 0) return false;
  if (hits === words.length) return true;
  return words.length <= 3 && hits >= 2;
}

/** Single titlecase word: a leading capital then only letters / `.`-`-`-`'`
 *  (e.g. `Etta`, `O'Brien`, `Jean-Luc`). Same per-word shape the multi-word
 *  title-case check uses, so a mononym is held to the identical standard. */
const SINGLE_WORD_NAME_RE = /^[A-Z][a-zA-Z.\-']*$/;

/**
 * Precision guard for a lone-word name candidate (issue #107). A single top
 * line is more often `Profile` / `Resume` / a brand or section header than a
 * person's mononym, so a one-word line is only ever a name when ALL hold:
 *   - it is a section header? → reject (handled here via matchSectionHeader)
 *   - it is doc-title boilerplate ("Resume", "Profile") → reject
 *   - it looks like a job-title tagline ("Engineer") → reject
 *   - it is titlecase (leading capital, letters only) → required
 *   - it carries strong font signal (near the largest font on the page) → required
 * The first-eligible-line constraint is enforced by the caller's control flow,
 * NOT here: a single-word line is only admitted when it is the first surviving
 * candidate (see `extractName`).
 */
function looksLikeMononymName(text: string, line: PdfLine, maxFontSize: number): boolean {
  if (matchSectionHeader(text)) return false;
  if (looksLikeDocTitleBoilerplate([text])) return false;
  if (looksLikeTitle(text)) return false;
  if (!SINGLE_WORD_NAME_RE.test(text)) return false;
  // Strong font signal: a real name in the largest (or near-largest) font.
  if (line.maxFontSize < maxFontSize - 0.5) return false;
  return true;
}

/**
 * True when `raw` is a single title-cased (or all-caps) letter token that could
 * be one half of a stacked name. Word résumé templates render the given name and
 * family name as separate single-word lines ("Chanchal" / "Sharma"); each is
 * individually rejected by `extractName`'s ≥2-word guard, so an adjacent pair is
 * merged into one candidate. Section headers ("SUMMARY") and document-title
 * boilerplate ("Resume") are excluded so neither ever glues onto a name.
 */
function isSingleNameWord(raw: string): boolean {
  const text = raw.trim();
  if (!text || text.length > 30) return false;
  if (/\s/.test(text)) return false; // must be exactly one token
  if (/\d/.test(text) || text.includes("@")) return false;
  if (!/^[A-Z][A-Za-z.\-']*$/.test(text)) return false;
  if (matchSectionHeader(text)) return false;
  if (looksLikeDocTitleBoilerplate([text])) return false;
  return true;
}

/** y-position of the first line in `lines` matching any of the contact regexes,
 *  or undefined if no contact-bearing line is found. Used as a soft signal —
 *  candidate names close to this y get a small bonus. */
function findContactClusterY(lines: PdfLine[]): number | undefined {
  for (const line of lines) {
    if (
      EMAIL_RE.test(line.text) ||
      PHONE_RE.test(line.text) ||
      LINKEDIN_RE.test(line.text)
    ) {
      // Reset lastIndex defensively; the constants are recompiled per call
      // elsewhere in the file but test() with `g` flag mutates state.
      EMAIL_RE.lastIndex = 0;
      PHONE_RE.lastIndex = 0;
      LINKEDIN_RE.lastIndex = 0;
      return line.y;
    }
  }
  return undefined;
}

/**
 * Resume names almost always appear at the very top, in the largest font, with
 * 2–4 words that are all letters (plus maybe a period or hyphen). Score:
 *   +0.4 first line of profile
 *   +0.3 font size larger than the rest of profile
 *   +0.2 all-caps OR title-case
 *   +0.1 2–4 words, 2–40 chars, no digits/emails
 *   +0.15 first eligible line within ~80pt of the contact cluster (soft confirm)
 *   +0.4  *later* line within ~80pt of the contact cluster (mode-2 recovery —
 *         lets a name set apart below a tagline/header overtake the higher line)
 *   −0.6  line looks like a job title ("Product Designer", "Senior Marketing
 *         Lead") — a tagline must not out-score the real name on position/size
 *
 * Hard rejection: lines that are mostly resume-document-title boilerplate
 * ("Functional Resume Sample", "Curriculum Vitae", etc.) — see issue #10.
 *
 * The proximity split + title penalty together let contact-cluster proximity
 * *change the winner*, not merely nudge confidence — issue #16 (mode 2 of #10),
 * where the real name is vertically separated from the contact block.
 */
export function extractName(
  profile: PdfSection,
): { value?: string; confidence: number } {
  if (profile.lines.length === 0) return { confidence: 0 };

  const maxFontSize = Math.max(...profile.lines.map((l) => l.maxFontSize));
  const averageFontSize =
    profile.lines.reduce((s, l) => s + l.maxFontSize, 0) / profile.lines.length;
  const contactY = findContactClusterY(profile.lines);

  let best: { text: string; score: number } | null = null;
  // Index of the first eligible candidate after rejections. When the literal
  // first line is rejected as boilerplate (e.g. "Functional Resume Sample"),
  // the next surviving line is effectively the header — it inherits the
  // first-line bonus, which also keeps confidence above the scorer's
  // contact-field floor (0.5). Without this, fixing the wrong-name pick
  // would dial confidence down enough to mark the (correct) name as
  // "missing" in completeness scoring.
  let firstEligibleIdx: number | null = null;

  // Candidate list: each of the top lines, plus a synthetic merge of any two
  // adjacent single-word name lines. Word templates stack the given and family
  // name on separate lines ("Chanchal" / "Sharma"); each is individually
  // rejected as a lone word, so the pair is offered as one two-word candidate.
  // The merge keeps its first line's index so it can win the first-line bonus
  // over a tagline ("Office Manager") sitting just below it. With no stacked
  // single-word lines, the list is exactly the top-N lines in order, so
  // single-line layouts score byte-identically to before.
  const scan = Math.min(profile.lines.length, 5);
  const candidates: { text: string; line: PdfLine; idx: number }[] = [];
  for (let i = 0; i < scan; i++) {
    const line = profile.lines[i];
    candidates.push({ text: line.text.trim(), line, idx: i });
    const next = profile.lines[i + 1];
    if (
      i <= 1 &&
      next &&
      isSingleNameWord(line.text) &&
      isSingleNameWord(next.text)
    ) {
      candidates.push({
        text: `${line.text.trim()} ${next.text.trim()}`,
        line: {
          ...line,
          maxFontSize: Math.max(line.maxFontSize, next.maxFontSize),
        },
        idx: i,
      });
    }
  }

  for (const { text, line, idx } of candidates) {
    if (!text || text.length > 60) continue;
    if (/\d/.test(text)) continue;
    if (text.includes("@")) continue;
    const words = text.split(/\s+/);
    // A two-word minimum is a precision guard — a lone top line is usually
    // `Profile` / `Resume` / a brand or section header, not a mononym. A
    // single-word candidate is admitted ONLY through the guarded
    // `looksLikeMononymName` path AND only as the first eligible line (#107):
    // a one-word line that is not first-eligible is still rejected, so a
    // two-word name on the same résumé always wins the lead slot first.
    const isMononym = words.length === 1;
    if (isMononym) {
      if (firstEligibleIdx !== null) continue;
      if (!looksLikeMononymName(text, line, maxFontSize)) continue;
    } else if (words.length > 5) {
      continue;
    }
    const letterRatio =
      text.replace(/[^A-Za-z]/g, "").length / Math.max(text.length, 1);
    if (letterRatio < 0.7) continue;
    if (looksLikeDocTitleBoilerplate(words)) continue;

    if (firstEligibleIdx === null) firstEligibleIdx = idx;

    let score = 0;
    if (idx === firstEligibleIdx) score += 0.4;
    if (line.maxFontSize >= maxFontSize - 0.5) score += 0.3;
    if (line.maxFontSize > averageFontSize + 1) score += 0.1;
    const titleCase = words.every((w) => /^[A-Z][a-zA-Z.\-']*$/.test(w));
    if (line.allCaps || titleCase) score += 0.2;
    if (words.length >= 2 && words.length <= 4) score += 0.1;
    if (contactY !== undefined && Math.abs(line.y - contactY) < 80) {
      // First eligible line near contact: soft confirmation. A *later* line
      // near contact: a recovery bonus large enough to overtake a higher /
      // larger line that won only on position/size — the mode-2 case in #16.
      // Gating the strong bonus on `idx !== firstEligibleIdx` keeps the #14
      // mode-1 fixture (first-eligible name) byte-identical.
      score += idx === firstEligibleIdx ? 0.15 : 0.4;
    }
    // A job-title tagline ("Product Designer", "Senior Marketing Lead") must
    // not win the name slot on position/size. Real names never match the
    // title-keyword set, so this only ever penalizes non-name lines.
    if (looksLikeTitle(text)) score -= 0.6;
    // Small mononym penalty (#107): a single-word pick is inherently weaker
    // signal than a two-word name, so a genuine two-word name on the same
    // résumé always outranks a lone-word candidate. Kept small (0.1) so a
    // strong mononym still clears the scorer's 0.5 contact-confidence floor.
    if (isMononym) score -= 0.1;

    if (!best || score > best.score) best = { text, score };
  }

  if (!best) return { confidence: 0 };
  return { value: best.text, confidence: Math.min(best.score, 1) };
}

// ── Contact (email, phone, urls, location) ──────────────────────────────────

export interface ContactExtractionResult {
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

export function extractContact(
  profile: PdfSection,
  allLines: PdfLine[],
  annotations: PdfLinkAnnotation[] = [],
): ContactExtractionResult {
  const scan = (lines: PdfLine[], joined: string): ContactExtractionResult => {
    const email = firstMatch(EMAIL_RE, joined);

    // Extract location BEFORE phone so we can derive the parse region.
    // `location` is intentionally not subject to the document-wide fallback —
    // see the doc-comment on `extractContact` for the reasoning.
    let location: string | undefined;
    for (const line of lines) {
      const us = US_LOCATION_RE.exec(line.text);
      if (us) {
        location = us[0];
        break;
      }
    }
    if (!location) {
      for (const line of lines) {
        const intl = INTL_LOCATION_RE.exec(line.text);
        if (intl && !/@/.test(intl[0])) {
          location = intl[0];
          break;
        }
      }
    }

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
    const others = allMatches(URL_RE, joined).filter((u) => {
      const lower = u.toLowerCase();
      return !lower.includes("linkedin.com") && !lower.includes("github.com");
    });
    const portfolio = others.find((u) =>
      /(portfolio|\.me\b|\.io\b|\.dev\b|behance|dribbble|medium)/i.test(u),
    );
    const websiteCandidates = others.filter((u) => u !== portfolio);
    const website = websiteCandidates[0];

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
  };

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

function normalizeUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.replace(/[,;.)]$/, "").trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

// ── Summary ─────────────────────────────────────────────────────────────────

/**
 * Summary is a prose paragraph, usually 2–6 lines, right after the "Summary"
 * header. Conservative extractor — if we don't have a dedicated section, we
 * don't guess.
 */
export function extractSummary(
  summary: PdfSection | undefined,
): { value?: string; confidence: number } {
  if (!summary || summary.lines.length === 0) return { confidence: 0 };
  const prose = summary.lines
    .filter((l) => !isBulletLine(l))
    .map((l) => l.text.trim())
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (!prose) return { confidence: 0 };
  // Penalize suspiciously short "summaries" (probably a tagline).
  const confidence = prose.length >= 60 ? 0.8 : prose.length >= 20 ? 0.5 : 0.2;
  return { value: prose, confidence };
}

// ── Skills ──────────────────────────────────────────────────────────────────

const SKILL_SPLIT_RE = /[,;·•|/]+|\s{2,}/;

/**
 * True if a skill token is plausibly a real skill.
 *
 * Defends against bleed-in from neighboring sections when the section-boundary
 * fix did not catch a given token. Filters:
 *   - date-range runs ("2001 - 2005 Riverton", "04/2021 - Present")
 *   - tokens with more than 4 whitespace-delimited words (sentence fragments
 *     like "Over 200+ interviews for engineering" — real skills are terse)
 *
 * Note: trailing punctuation is stripped by the caller before this check, so
 * "AWS." → "AWS" passes without special-casing single-word tokens.
 */
/** A bare profile-link heading word — these show up as standalone "headings
 *  with hyperlinks" after Skills and get swept into the skills pool. Exact-match
 *  only, so a real multi-word skill like "GitHub Actions" or "Portfolio
 *  Management" is never caught. */
const PROFILE_LABEL_RE =
  /^(linkedin|github|gitlab|portfolio|website|behance|dribbble)$/i;
/** A known social/profile host, with or without a path ("github.com",
 *  "linkedin.com/in/x"). */
const PROFILE_HOST_RE =
  /\b(linkedin|github|gitlab|behance|dribbble|medium|twitter|facebook|instagram|stackoverflow|kaggle|gitlab)\.[a-z]{2,}/i;
/** A generic URL: an explicit scheme, a `www.` prefix, or a domain followed by
 *  a path slash. The path-slash requirement is deliberate — it distinguishes a
 *  link ("mysite.com/portfolio") from a dotted real skill ("Node.js",
 *  "Socket.io", "ASP.NET") that has no slash. */
const URLISH_RE = /(https?:\/\/|www\.|\b[a-z0-9-]+\.[a-z]{2,}\/\S)/i;

/** True when a candidate skill token is really a professional-profile link
 *  (GitHub / LinkedIn / portfolio, etc.) or its bare heading word. Such links
 *  belong only in the contact/profile section, never in Skills. */
function looksLikeContactLink(tok: string): boolean {
  const t = tok.trim();
  return PROFILE_LABEL_RE.test(t) || PROFILE_HOST_RE.test(t) || URLISH_RE.test(t);
}

function isSkillToken(tok: string): boolean {
  if (tok.length < 2 || tok.length > 40) return false;
  if (/^\d+$/.test(tok)) return false;
  // A professional-profile link (or its bare "GitHub" / "LinkedIn" heading) is
  // contact info, not a skill — drop it wherever in the doc it surfaced.
  if (looksLikeContactLink(tok)) return false;
  // Reject date-range runs: "2001 - 2005", "04/2021 - Present" etc.
  if (/\d{4}\s*[-–]\s*(\d{4}|present)/i.test(tok)) return false;
  // Reject tokens that span more than 4 words — real skills are terse.
  if (tok.split(/\s+/).length > 4) return false;
  return true;
}

/**
 * Word/LaTeX résumés often lay skills out in a borderless multi-column table.
 * pdfjs renders each inter-column gap as a wide blank "spacer" item rather than
 * a large x-gap between glyph runs, so `groupIntoLines` (which splits only on
 * gaps between item *edges* — see COLUMN_GAP_THRESHOLD) keeps the whole row as
 * one PdfLine, e.g. "Project management Data analysis Communication". Splitting
 * the line at those spacer items recovers one cell per column without resorting
 * to a blind `\s+` split that would shred multi-word skills.
 *
 * A spacer must be meaningfully wider than an ordinary inter-word space (one em,
 * 10pt floor) so normal prose spacing never triggers a split. Returns one string
 * per column cell, or `[line.text]` when the line has no column spacers —
 * byte-identical to the pre-column behavior for ordinary single-column lines.
 */
function splitColumnCells(line: PdfLine): string[] {
  const cells: PdfTextItem[][] = [];
  let cur: PdfTextItem[] = [];
  for (const item of line.items) {
    const isSpacer =
      item.str.trim() === "" && item.width > Math.max(item.fontSize, 10);
    if (isSpacer) {
      if (cur.length > 0) cells.push(cur);
      cur = [];
      continue;
    }
    cur.push(item);
  }
  if (cur.length > 0) cells.push(cur);
  if (cells.length <= 1) return [line.text];
  // Collapse any whitespace a narrow (non-splitting) spacer item left inside a
  // cell — e.g. a " \n" run between "REST" and "API" → "REST API".
  return cells
    .map((c) => mergeItemText(c).replace(/\s+/g, " ").trim())
    .filter((t) => t.length > 0);
}

export function extractSkills(
  skills: PdfSection | undefined,
): { value: string[]; confidence: number } {
  if (!skills || skills.lines.length === 0) return { value: [], confidence: 0 };

  const tokens = new Set<string>();
  for (const line of skills.lines) {
    for (const cell of splitColumnCells(line)) {
      const clean = stripBullet(cell).replace(/^[A-Z][A-Za-z ]+:\s*/, "");
      // A whole cell that is a profile link ("github.com/janesmith") must be
      // dropped before SKILL_SPLIT_RE — which splits on "/" (for "HTML/CSS") —
      // shreds the URL and leaves its path segment ("janesmith") as a token.
      if (looksLikeContactLink(clean)) continue;
      for (const raw of clean.split(SKILL_SPLIT_RE)) {
        // Strip trailing sentence punctuation that can appear at line-end (e.g.
        // "Python, JavaScript, Git, SQL, Linux, AWS." → the period is a list
        // terminator, not part of the skill name).
        const tok = raw.trim().replace(/[.!?,;]+$/, "");
        if (isSkillToken(tok)) {
          tokens.add(tok);
        }
      }
    }
  }
  const value = [...tokens];
  const confidence = value.length >= 5 ? 0.85 : value.length >= 2 ? 0.6 : 0.2;
  return { value, confidence };
}

// ── Experience ──────────────────────────────────────────────────────────────

/**
 * Split the experience section into entry blocks and extract a
 * `ResumeExperience` row per block. The grouping heuristic:
 *
 *   - A line containing a date range anchors an entry header.
 *   - Non-bullet lines in the 0..2 lines ABOVE the anchor = company / title.
 *   - Bullet lines after the anchor, until the next anchor or section end,
 *     = the description.
 *
 * Confidence is per-entry, then averaged: we report the average of the
 * per-entry confidence as the section-level `experience` confidence.
 */
export function extractExperience(
  experience: PdfSection | undefined,
): { value: ResumeExperience[]; confidence: number } {
  // Split the section into dated entry blocks using the shared primitive, then
  // map each block's header lines into title/company/team and score it. The
  // windowing, date parsing, and bullet-body collection live in
  // `parseEntryBlocks`; this function owns only the experience-specific field
  // mapping (`disambiguateCompanyTitle`) and scoring.
  const blocks = parseEntryBlocks(experience, {
    anchor: "date_range",
    collectBody: true,
    headerLookback: 2,
  });
  if (blocks.length === 0) return { value: [], confidence: 0 };
  const built = blocks.map(experienceFromBlock);
  return {
    value: built.map((b) => b.entry),
    confidence: avgScore(built.map((b) => b.score)),
  };
}

/** Map one dated entry block to a `ResumeExperience` and its confidence score.
 *  Extracted from `extractExperience` to keep each function below the
 *  complexity threshold; mirrors `projectFromBlock` / `achievementFromBlock`. */
function experienceFromBlock(block: EntryBlock): {
  entry: ResumeExperience;
  score: number;
} {
  const { dates } = block;
  const { title, company, team } = disambiguateCompanyTitle(block.headerLines);
  const description = block.body;

  // Score the entry.
  let score = 0;
  if (dates.start_date) score += 0.25;
  if (dates.end_date || dates.is_current) score += 0.15;
  if (company) score += 0.25;
  if (title) score += 0.2;
  if (block.bulletCount >= 1) score += 0.15;

  return {
    entry: {
      title: title ?? "",
      company: company ?? "",
      ...(team ? { team } : {}),
      ...(dates.start_date ? { start_date: dates.start_date } : {}),
      ...(dates.end_date ? { end_date: dates.end_date } : {}),
      ...(dates.is_current ? { is_current: true } : {}),
      description: description || undefined,
    },
    score: Math.min(score, 1),
  };
}

// ── Projects ────────────────────────────────────────────────────────────────

/**
 * Extract a standalone Projects section into `ResumeProject[]`.
 *
 * Thin caller of the shared `parseEntryBlocks` primitive — mirrors
 * `extractExperience`, but anchors on `"first_line"` rather than `"date_range"`
 * because projects are name-led and a project's date is optional. Anchoring on
 * a date would silently drop every date-less project (the bug in #95). Each
 * block becomes one project: `headerLines[0]` is the project name (a URL on the
 * header is lifted into `url` and stripped from the name), the bullet body is
 * the description, and any date the header carried is parsed off the block.
 *
 * The project-specific field mapping lives here; the windowing, date parsing,
 * and bullet collection live in `parseEntryBlocks`. We deliberately do NOT
 * reuse `disambiguateCompanyTitle` — that is experience-specific (company vs.
 * title), which a project header does not have.
 *
 * Confidence is per-entry then averaged, matching `extractExperience`: a named
 * entry with bullets scores high; a bare name scores low.
 */
export function extractProjects(
  projects: PdfSection | undefined,
): { value: ResumeProject[]; confidence: number } {
  const blocks = parseEntryBlocks(projects, {
    anchor: "first_line",
    collectBody: true,
  });
  if (blocks.length === 0) return { value: [], confidence: 0 };
  const built = blocks.map(projectFromBlock);
  return {
    value: built.map((b) => b.entry),
    confidence: avgScore(built.map((b) => b.score)),
  };
}

/** Mean of per-entry confidence scores; 0 for an empty list. */
function avgScore(scores: number[]): number {
  return scores.reduce((a, b) => a + b, 0) / Math.max(scores.length, 1);
}

/**
 * Split an entry's header lines into a leading label and a lifted URL. The URL
 * (repo / live demo / publication link) may appear anywhere in the header; it
 * is removed from the first line and trailing separators are trimmed. Shared by
 * `projectFromBlock` and `achievementFromBlock` — the SAME header shape (#96).
 */
function liftHeaderLabel(headerLines: string[]): {
  label: string;
  url?: string;
} {
  const headerJoined = headerLines.join(" ");
  const url = firstMatch(URL_RE, headerJoined);
  const raw = headerLines[0] ?? "";
  const label = (url ? raw.replace(URL_RE, "") : raw)
    .replace(/[\s|•·\-–—]+$/g, "")
    .trim();
  URL_RE.lastIndex = 0;
  return { label, ...(url ? { url } : {}) };
}

/** Map one entry block to a `ResumeProject` and its confidence score. Extracted
 *  from `extractProjects` to keep each function below the complexity threshold. */
function projectFromBlock(block: EntryBlock): {
  entry: ResumeProject;
  score: number;
} {
  const { dates } = block;
  const { label: name, url } = liftHeaderLabel(block.headerLines);
  const description = block.body;

  // Score the entry: a name (0.4), a date (0.2), and at least one bullet
  // (0.4) — projects have no company/title axis, so the weights differ from
  // experience but still reward a fully-formed entry.
  let score = 0;
  if (name) score += 0.4;
  if (dates.start_date) score += 0.2;
  if (block.bulletCount >= 1) score += 0.4;

  return {
    entry: {
      name,
      ...(dates.start_date ? { start_date: dates.start_date } : {}),
      ...(dates.end_date ? { end_date: dates.end_date } : {}),
      ...(dates.is_current ? { is_current: true } : {}),
      ...(description ? { description } : {}),
      ...(url ? { url } : {}),
    },
    score: Math.min(score, 1),
  };
}

// ── Achievements ──────────────────────────────────────────────────────────────

/**
 * Extract an Achievements / Accomplishments / Awards / Activities section into
 * `HeuristicAchievement[]`.
 *
 * Thin caller of the shared `parseEntryBlocks` primitive — the SAME extractor
 * shape as `extractProjects`, deliberately not a third bespoke implementation
 * (#96). Achievement items are name-led and often single-line, so we anchor on
 * `"first_line"` (anchoring on a date would drop the common date-less award);
 * `collectBody: true` so any bullets under an item become its description and
 * pool with experience/project bullets in the scorer.
 *
 * Each block becomes one achievement: `headerLines[0]` is the item title (a URL
 * on the header is lifted into `url`), any date the header carried is reduced to
 * a single lead `year` (achievements show a year, not a range), and the bullet
 * body is the description.
 *
 * Honest-by-construction (#96, option (a)): we emit only what a regex parser can
 * truthfully assert — a title, an optional year/url, and a bullet body. We do
 * NOT guess an `AchievementType`; the structured `Achievement[]` is the LLM
 * path's job.
 */
export function extractAchievements(
  achievements: PdfSection | undefined,
): { value: HeuristicAchievement[]; confidence: number } {
  const blocks = parseEntryBlocks(achievements, {
    anchor: "first_line",
    collectBody: true,
  });
  if (blocks.length === 0) return { value: [], confidence: 0 };
  const built = blocks.map(achievementFromBlock);
  return {
    value: built.map((b) => b.entry),
    confidence: avgScore(built.map((b) => b.score)),
  };
}

/** Map one entry block to a `HeuristicAchievement` and its confidence score.
 *  Extracted from `extractAchievements` to keep each function below the
 *  complexity threshold; mirrors `projectFromBlock`. */
function achievementFromBlock(block: EntryBlock): {
  entry: HeuristicAchievement;
  score: number;
} {
  const { dates } = block;
  const { label: title, url } = liftHeaderLabel(block.headerLines);

  // Reduce any date range the header carried to a single lead year.
  const year = dates.start_date
    ? firstMatch(YEAR_RE, dates.start_date)
    : undefined;
  const description = block.body;

  // Score the entry: a title (0.5) and at least one bullet (0.5). Achievements
  // have no company/title axis and the year is optional, so they don't earn a
  // date weight — a named, bulleted item is a fully-formed entry.
  let score = 0;
  if (title) score += 0.5;
  if (block.bulletCount >= 1) score += 0.5;

  return {
    entry: {
      title,
      ...(year ? { year } : {}),
      ...(url ? { url } : {}),
      ...(description ? { description } : {}),
    },
    score: Math.min(score, 1),
  };
}


/** Infer the precision a date string carries from its shape. A month name or a
 *  numeric month (`MM/YYYY`, `MM-YYYY`) → "month"; a bare 4-digit year → "year".
 *  Used to fill the `*_precision` companions honestly from what the text shows.
 *  Non-global regexes (no shared `lastIndex` state) so the helper is reentrant. */
function inferDatePrecision(date: string): "month" | "year" {
  const monthName =
    /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\b/i;
  if (monthName.test(date)) return "month";
  if (/\b(0?[1-9]|1[0-2])[\/\-]\d{4}\b/.test(date)) return "month";
  return "year";
}

/**
 * Education-specific date parsing on top of the shared `parseDateRange`.
 *
 * Education entries differ from experience in two ways:
 *   - A real range ("Sep 2024 - July 2025") must keep BOTH halves — the old
 *     `YEAR_RE.exec(joined)[0]` took only the first year and dropped the end.
 *   - A lone date is a GRADUATION date ("Expected Graduation: May 2027", or a
 *     bare "2019"), so it belongs in `end_date`, not `start_date` — emitting a
 *     spurious `start_date` would imply an attendance range that isn't stated.
 *
 * `parseDateRange` returns `{ start_date }` only for both a true range's start
 * AND the lone-date fallback, so we disambiguate on the presence of an end /
 * is_current: an end means it was a range; otherwise the single date is the
 * graduation date and is moved to `end_date`. `year` is kept for back-compat
 * (graduation year preferred).
 */
function parseEducationDates(text: string): {
  start_date?: string;
  start_date_precision?: "month" | "year";
  end_date?: string;
  end_date_precision?: "month" | "year";
  year?: string;
} {
  const { start_date, end_date, is_current } = parseDateRange(text);

  // Open-ended range ("Sep 2021 - Present"): keep the start, mark graduation
  // open. Rare for education but handled for parity with experience.
  if (is_current && start_date) {
    return {
      start_date,
      start_date_precision: inferDatePrecision(start_date),
      year: yearOf(start_date),
    };
  }

  // True range: both halves present.
  if (start_date && end_date) {
    return {
      start_date,
      start_date_precision: inferDatePrecision(start_date),
      end_date,
      end_date_precision: inferDatePrecision(end_date),
      year: yearOf(end_date) ?? yearOf(start_date),
    };
  }

  // Lone date (graduation / bare year): land it in end_date, no spurious start.
  // `parseDateRange`'s single-date fallback is year-only, so re-scan the text
  // for the richest single date ("May 2027" beats "2027") before falling back.
  const lone = richestSingleDate(text) ?? end_date ?? start_date;
  if (lone) {
    return {
      end_date: lone,
      end_date_precision: inferDatePrecision(lone),
      year: yearOf(lone),
    };
  }

  return {};
}

/** Richest single date in `text`: a month-year ("May 2027" / "05/2027") if
 *  present, else the first bare year. Used for the single-graduation-date case
 *  where the month would otherwise be lost. Resets each global regex's
 *  `lastIndex` so repeated calls are deterministic. */
function richestSingleDate(text: string): string | undefined {
  const my = MONTH_YEAR_RE.exec(text);
  MONTH_YEAR_RE.lastIndex = 0;
  if (my) return normalizeDate(my[0].replace(/\./g, ""));
  const nmy = NUMERIC_MONTH_YEAR_RE.exec(text);
  NUMERIC_MONTH_YEAR_RE.lastIndex = 0;
  if (nmy) return nmy[0];
  return yearOf(text);
}

/** First 4-digit year inside a date string, or undefined. */
function yearOf(date: string): string | undefined {
  const m = /\b(19|20)\d{2}\b/.exec(date);
  return m ? m[0] : undefined;
}

/** Build the conditional `ResumeEducation` date spread from a parsed result,
 *  omitting any absent field so the entry never carries `undefined` keys. */
function educationDateFields(
  dates: ReturnType<typeof parseEducationDates>,
): Partial<ResumeEducation> {
  return {
    ...(dates.start_date ? { start_date: dates.start_date } : {}),
    ...(dates.start_date_precision
      ? { start_date_precision: dates.start_date_precision }
      : {}),
    ...(dates.end_date ? { end_date: dates.end_date } : {}),
    ...(dates.end_date_precision
      ? { end_date_precision: dates.end_date_precision }
      : {}),
    ...(dates.year ? { year: dates.year } : {}),
  };
}

/**
 * Keywords that commonly appear in a job title. Used as a tiebreaker when
 * neither header line carries a company suffix:
 * modern resumes often flip the "Company first, then Title" convention
 * and put Title on the top (H2) with Company below (H3). Without this
 * heuristic the default fallback misattributes a `**Sr. Engineering
 * Manager (L7)**` header as the company and `**Alphabet / Google Fiber**`
 * as the title.
 */
const TITLE_KEYWORDS_RE =
  /\b(Engineer|Engineering|Developer|Manager|Director|Lead|Consultant|Analyst|Specialist|Associate|Architect|Principal|Officer|Designer|Scientist|Researcher|Administrator|Founder|Co-?founder|President|VP|Vice President|Head|Chief|CTO|CEO|COO|CFO|CIO|PM|TPM|SRE|DevOps|Assistant|Intern|Internship|Trainee|Apprentice|Coordinator|Technician|Representative|Supervisor|Strategist|Advisor|Adviser|Counselor|Recruiter|Accountant|Auditor|Editor|Writer|Producer|Teacher|Instructor|Lecturer|Professor|Tutor|Agent|Clerk|Ambassador|Volunteer|Fellow)\b/i;

/** Heuristic: text contains title-like keywords but no company suffix. */
function looksLikeTitle(text: string): boolean {
  if (COMPANY_SUFFIX_RE.test(text)) return false;
  return TITLE_KEYWORDS_RE.test(text);
}

/** Employer signal: a legal suffix ("Inc", "LLC") OR an institution word
 *  ("University", "College") — and NOT itself a job-title line, so a designation
 *  like "University Lecturer" or "School Counselor" stays a title rather than
 *  being mistaken for the company. */
function looksLikeCompany(text: string): boolean {
  return (
    (COMPANY_SUFFIX_RE.test(text) || INSTITUTION_HINTS.test(text)) &&
    !looksLikeTitle(text)
  );
}

/**
 * Given 1..3 header lines, decide which is the company and which is the title.
 * Heuristics (in priority order):
 *   - If one looks like a company/institution (legal suffix OR "University",
 *     "College", … — see `looksLikeCompany`) and is not itself a title, that's
 *     the company; the rest is the title. This fires on the common stacked
 *     "Designation / University / Dates" student-resume shape, which the old
 *     suffix-only check missed (it has no "Inc"/"LLC").
 *   - Else if one looks like a title (role/level keyword) and the other
 *     doesn't, the title-keyword one is the title.
 *   - Otherwise the first line (top of the entry) is the company.
 *   - Team is an optional third piece, often separated by "—", ",", or "|".
 */
export function disambiguateCompanyTitle(headers: string[]): {
  company?: string;
  title?: string;
  team?: string;
} {
  const filtered = headers.filter((h) => h.length > 0);
  if (filtered.length === 0) return {};

  // Split any header that has an obvious "Title, Company" or "Title @ Company" pattern.
  const splits: Array<{ text: string; source: number }> = [];
  filtered.forEach((h, idx) => {
    const atSplit = h.split(/\s+@\s+|\s+—\s+|\s+\|\s+/);
    if (atSplit.length > 1) {
      atSplit.forEach((s) => splits.push({ text: s.trim(), source: idx }));
    } else {
      splits.push({ text: h, source: idx });
    }
  });

  const companyIdx = splits.findIndex((s) => looksLikeCompany(s.text));
  let company: string | undefined;
  let title: string | undefined;
  let team: string | undefined;

  if (companyIdx !== -1) {
    company = splits[companyIdx].text;
    const others = splits.filter((_, i) => i !== companyIdx);
    title = others[0]?.text;
    team = others[1]?.text;
  } else {
    // No company suffix — tiebreak on title keywords. If only one of the
    // first two splits looks title-shaped, assign accordingly.
    const firstLooksTitle = splits[0] ? looksLikeTitle(splits[0].text) : false;
    const secondLooksTitle = splits[1] ? looksLikeTitle(splits[1].text) : false;
    if (firstLooksTitle && !secondLooksTitle) {
      title = splits[0]?.text;
      company = splits[1]?.text;
      team = splits[2]?.text;
    } else if (!firstLooksTitle && secondLooksTitle) {
      // Older convention ("Company / Title"): leave as default.
      company = splits[0]?.text;
      title = splits[1]?.text;
      team = splits[2]?.text;
    } else {
      // No title-keyword signal either way — assume top line is company.
      company = splits[0]?.text;
      title = splits[1]?.text;
      team = splits[2]?.text;
    }
  }

  return { company, title, team };
}

// ── Education ───────────────────────────────────────────────────────────────

/** A line that is essentially just a date / date-range (a bare year or
 *  month-year), so it must not be mistaken for the institution inside an
 *  education chunk. */
function isDateOnlyLine(text: string): boolean {
  const stripped = text
    .replace(/\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?/gi, "")
    .replace(/\b\d{4}\b/g, "")
    .replace(/\b(?:present|current|expected|graduation|graduated|anticipated)\b/gi, "")
    .replace(/[\s,–\-—|/().:]+/g, "")
    .trim();
  return stripped.length === 0;
}

/** Map one education chunk (the degree + institution + date lines of a single
 *  qualification) to a `ResumeEducation` and its confidence. */
function educationFromChunk(chunk: string[]): {
  entry: ResumeEducation;
  score: number;
} {
  const joined = chunk.join(" | ");
  const degreeMatch = DEGREE_RE.exec(joined);
  const degree = degreeMatch ? degreeMatch[0].trim() : "";

  // Institution: an explicit institution-hint line first; else the first line
  // that is neither the degree-bearing line nor a bare date — this recovers
  // acronym schools ("MIT", "UC Berkeley") that carry no "University"/"College"
  // word; else strip the degree off its own line (degree + school on one line).
  let institution = "";
  const instLine = chunk.find((l) => INSTITUTION_HINTS.test(l));
  if (instLine) {
    institution = instLine.trim();
  } else {
    const cand = chunk.find((l) => !DEGREE_RE.test(l) && !isDateOnlyLine(l));
    if (cand) {
      institution = cand.trim();
    } else if (degreeMatch) {
      institution = joined
        .replace(degreeMatch[0], "")
        .replace(/\s*\|\s*/g, " ")
        .replace(/[,|]+$/, "")
        .trim();
    }
  }

  // Shared date primitive (via the education wrapper) so a range like
  // "Sep 2024 - July 2025" keeps both halves and a lone graduation date lands in
  // `end_date` (#97).
  const dates = parseEducationDates(joined);
  const hasDate = !!(dates.start_date || dates.end_date);

  let score = 0;
  if (institution) score += 0.3;
  if (degree) score += 0.4;
  if (hasDate) score += 0.3;

  return {
    entry: { institution, degree, ...educationDateFields(dates) },
    score: Math.min(score, 1),
  };
}

export function extractEducation(
  education: PdfSection | undefined,
): { value: ResumeEducation[]; confidence: number } {
  if (!education || education.lines.length === 0)
    return { value: [], confidence: 0 };

  const lines = education.lines
    .filter((l) => !isBulletLine(l))
    .map((l) => l.text)
    .filter((t) => t.trim().length > 0);
  if (lines.length === 0) return { value: [], confidence: 0 };

  // Group into one chunk per qualification. A new chunk begins when the current
  // one already holds a degree and the next line introduces another degree, or
  // already holds an institution and the next line introduces another. This
  // keeps multi-degree sections from collapsing into a single entry (only the
  // first degree was ever extracted before) and works for both
  // "Degree / School / Dates" and "School / Degree / Dates" orderings.
  const chunks: string[][] = [];
  let current: string[] = [];
  let hasDegree = false;
  let hasInstitution = false;
  const flush = () => {
    if (current.length > 0) chunks.push(current);
    current = [];
    hasDegree = false;
    hasInstitution = false;
  };
  for (const text of lines) {
    const isDeg = DEGREE_RE.test(text);
    const isInst = INSTITUTION_HINTS.test(text);
    if ((isDeg && hasDegree) || (isInst && hasInstitution)) flush();
    current.push(text);
    if (isDeg) hasDegree = true;
    if (isInst) hasInstitution = true;
  }
  flush();

  const built = chunks
    .map(educationFromChunk)
    .filter((b) => b.entry.degree || b.entry.institution);
  if (built.length === 0) return { value: [], confidence: 0 };
  return {
    value: built.map((b) => b.entry),
    confidence: avgScore(built.map((b) => b.score)),
  };
}
