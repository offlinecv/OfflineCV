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
import { matchSectionHeader } from "./regex.ts";
import type { PdfLinkAnnotation } from "./types.ts";
import {
  EMAIL_RE,
  PHONE_RE,
  LINKEDIN_RE,
  GITHUB_RE,
  URL_RE,
  US_LOCATION_RE,
  INTL_LOCATION_RE,
  DATE_RANGE_RE,
  YEAR_RE,
  MONTH_YEAR_RE,
  NUMERIC_MONTH_YEAR_RE,
  DEGREE_RE,
  INSTITUTION_HINTS,
  COMPANY_SUFFIX_RE,
} from "./regex.ts";
import { findFirstPhone } from "./phone.ts";
import { parseEntryBlocks } from "./entry-blocks.ts";

// ── Small utilities ─────────────────────────────────────────────────────────

/** True if the line looks like a bullet point (starts with •, ‣, -, *, ◦, or is indented prose). */
export function isBulletLine(line: PdfLine): boolean {
  return /^\s*[•\u2023\u25AA\u25CF\u25E6\u2043*\-–—]/.test(line.text);
}

/** Strip leading bullet glyphs + whitespace. */
export function stripBullet(text: string): string {
  return text.replace(/^\s*[•\u2023\u25AA\u25CF\u25E6\u2043*\-–—]\s*/, "").trim();
}

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

  let best: { line: PdfLine; score: number } | null = null;
  // Index of the first eligible candidate after rejections. When the literal
  // first line is rejected as boilerplate (e.g. "Functional Resume Sample"),
  // the next surviving line is effectively the header — it inherits the
  // first-line bonus, which also keeps confidence above the scorer's
  // contact-field floor (0.5). Without this, fixing the wrong-name pick
  // would dial confidence down enough to mark the (correct) name as
  // "missing" in completeness scoring.
  let firstEligibleIdx: number | null = null;

  for (let i = 0; i < Math.min(profile.lines.length, 5); i++) {
    const line = profile.lines[i];
    const text = line.text.trim();
    if (!text || text.length > 60) continue;
    if (/\d/.test(text)) continue;
    if (text.includes("@")) continue;
    const words = text.split(/\s+/);
    if (words.length < 2 || words.length > 5) continue;
    const letterRatio =
      text.replace(/[^A-Za-z]/g, "").length / Math.max(text.length, 1);
    if (letterRatio < 0.7) continue;
    if (looksLikeDocTitleBoilerplate(words)) continue;

    if (firstEligibleIdx === null) firstEligibleIdx = i;

    let score = 0;
    if (i === firstEligibleIdx) score += 0.4;
    if (line.maxFontSize >= maxFontSize - 0.5) score += 0.3;
    if (line.maxFontSize > averageFontSize + 1) score += 0.1;
    const titleCase = words.every((w) => /^[A-Z][a-zA-Z.\-']*$/.test(w));
    if (line.allCaps || titleCase) score += 0.2;
    if (words.length >= 2 && words.length <= 4) score += 0.1;
    if (contactY !== undefined && Math.abs(line.y - contactY) < 80) {
      // First eligible line near contact: soft confirmation. A *later* line
      // near contact: a recovery bonus large enough to overtake a higher /
      // larger line that won only on position/size — the mode-2 case in #16.
      // Gating the strong bonus on `i !== firstEligibleIdx` keeps the #14
      // mode-1 fixture (first-eligible name) byte-identical.
      score += i === firstEligibleIdx ? 0.15 : 0.4;
    }
    // A job-title tagline ("Product Designer", "Senior Marketing Lead") must
    // not win the name slot on position/size. Real names never match the
    // title-keyword set, so this only ever penalizes non-name lines.
    if (looksLikeTitle(text)) score -= 0.6;

    if (!best || score > best.score) best = { line, score };
  }

  if (!best) return { confidence: 0 };
  return { value: best.line.text.trim(), confidence: Math.min(best.score, 1) };
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
export function extractContact(
  profile: PdfSection,
  allLines: PdfLine[],
  annotations: PdfLinkAnnotation[] = [],
): ContactExtractionResult {
  const scan = (lines: PdfLine[], joined: string): ContactExtractionResult => {
    const email = firstMatch(EMAIL_RE, joined);
    const phoneResult = findFirstPhone(joined);
    const phone = phoneResult?.formatted;
    const linkedin = firstMatch(LINKEDIN_RE, joined);
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
  // ("LinkedIn", "GitHub") only show up here. Y-band-filter to the profile
  // section so a footer LinkedIn in a project description doesn't get
  // misattributed as the candidate's profile.
  const headerEndY = findFirstHeaderY(allLines);
  const inProfileBand = (ann: PdfLinkAnnotation) =>
    ann.page === 1 &&
    (headerEndY === undefined ||
      headerEndY.page !== 1 ||
      ann.yTop < headerEndY.y);
  // Portfolio/website use a slightly looser band — some design templates
  // place the portfolio link in a sidebar or under the name block. "Top
  // third of page 1" approximated with a fixed PDF-points cutoff that
  // works for both Letter (792pt) and A4 (842pt).
  const inHeaderRegion = (ann: PdfLinkAnnotation) =>
    ann.page === 1 && ann.yTop < 280;

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

  const isLinkedinUrl = (u: string) => /linkedin\.com\/(in|pub)\//i.test(u);
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

  const linkedin = pickUrl("linkedin_url", isLinkedinUrl, inProfileBand);
  const github = pickUrl("github_url", isGithubUrl, inProfileBand);
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

/**
 * Find the first line in `allLines` that is a canonical section header.
 * Used as the y-band cutoff for annotation-based contact fallback —
 * annotations above this line are in the profile region.
 */
function findFirstHeaderY(
  allLines: PdfLine[],
): { page: number; y: number } | undefined {
  for (const line of allLines) {
    if (matchSectionHeader(line.text)) {
      return { page: line.page, y: line.y };
    }
  }
  return undefined;
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
 *   - date-range runs ("1985 - 1989 Riverton", "04/2021 - Present")
 *   - tokens with more than 4 whitespace-delimited words (sentence fragments
 *     like "Over 200+ interviews for engineering" — real skills are terse)
 *
 * Note: trailing punctuation is stripped by the caller before this check, so
 * "AWS." → "AWS" passes without special-casing single-word tokens.
 */
function isSkillToken(tok: string): boolean {
  if (tok.length < 2 || tok.length > 40) return false;
  if (/^\d+$/.test(tok)) return false;
  // Reject date-range runs: "1985 - 1989", "04/2021 - Present" etc.
  if (/\d{4}\s*[-–]\s*(\d{4}|present)/i.test(tok)) return false;
  // Reject tokens that span more than 4 words — real skills are terse.
  if (tok.split(/\s+/).length > 4) return false;
  return true;
}

export function extractSkills(
  skills: PdfSection | undefined,
): { value: string[]; confidence: number } {
  if (!skills || skills.lines.length === 0) return { value: [], confidence: 0 };

  const tokens = new Set<string>();
  for (const line of skills.lines) {
    const clean = stripBullet(line.text).replace(/^[A-Z][A-Za-z ]+:\s*/, "");
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

  const entries: ResumeExperience[] = [];
  const perEntryScores: number[] = [];

  for (const block of blocks) {
    const { dates } = block;
    const { title, company, team } = disambiguateCompanyTitle(
      block.headerLines,
    );
    const description = block.body;

    // Score the entry.
    let score = 0;
    if (dates.start_date) score += 0.25;
    if (dates.end_date || dates.is_current) score += 0.15;
    if (company) score += 0.25;
    if (title) score += 0.2;
    if (block.bulletCount >= 1) score += 0.15;

    entries.push({
      title: title ?? "",
      company: company ?? "",
      ...(team ? { team } : {}),
      ...(dates.start_date ? { start_date: dates.start_date } : {}),
      ...(dates.end_date ? { end_date: dates.end_date } : {}),
      ...(dates.is_current ? { is_current: true } : {}),
      description: description || undefined,
    });
    perEntryScores.push(Math.min(score, 1));
  }

  const avg =
    perEntryScores.reduce((a, b) => a + b, 0) /
    Math.max(perEntryScores.length, 1);
  return { value: entries, confidence: avg };
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

  const entries: ResumeProject[] = [];
  const perEntryScores: number[] = [];

  for (const block of blocks) {
    const { dates } = block;

    // The first header line is the project name. A URL anywhere in the header
    // lines (repo / live demo) is lifted out and stripped from the name.
    const headerJoined = block.headerLines.join(" ");
    const url = firstMatch(URL_RE, headerJoined);
    const nameRaw = block.headerLines[0] ?? "";
    const name = (url ? nameRaw.replace(URL_RE, "") : nameRaw)
      .replace(/[\s|•·\-–—]+$/g, "")
      .trim();
    URL_RE.lastIndex = 0;

    const description = block.body;

    // Score the entry: a name (0.4), a date (0.2), and at least one bullet
    // (0.4) — projects have no company/title axis, so the weights differ from
    // experience but still reward a fully-formed entry.
    let score = 0;
    if (name) score += 0.4;
    if (dates.start_date) score += 0.2;
    if (block.bulletCount >= 1) score += 0.4;

    entries.push({
      name,
      ...(dates.start_date ? { start_date: dates.start_date } : {}),
      ...(dates.end_date ? { end_date: dates.end_date } : {}),
      ...(dates.is_current ? { is_current: true } : {}),
      ...(description ? { description } : {}),
      ...(url ? { url } : {}),
    });
    perEntryScores.push(Math.min(score, 1));
  }

  const avg =
    perEntryScores.reduce((a, b) => a + b, 0) /
    Math.max(perEntryScores.length, 1);
  return { value: entries, confidence: avg };
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

  const entries: HeuristicAchievement[] = [];
  const perEntryScores: number[] = [];

  for (const block of blocks) {
    const { dates } = block;

    // The first header line is the item title. A URL anywhere in the header
    // lines (publication / patent / press link) is lifted out and stripped.
    const headerJoined = block.headerLines.join(" ");
    const url = firstMatch(URL_RE, headerJoined);
    const titleRaw = block.headerLines[0] ?? "";
    const title = (url ? titleRaw.replace(URL_RE, "") : titleRaw)
      .replace(/[\s|•·\-–—]+$/g, "")
      .trim();
    URL_RE.lastIndex = 0;

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

    entries.push({
      title,
      ...(year ? { year } : {}),
      ...(url ? { url } : {}),
      ...(description ? { description } : {}),
    });
    perEntryScores.push(Math.min(score, 1));
  }

  const avg =
    perEntryScores.reduce((a, b) => a + b, 0) /
    Math.max(perEntryScores.length, 1);
  return { value: entries, confidence: avg };
}

/** Parse a date range (start/end) from a line. Tolerates M/YYYY, Mmm YYYY, YYYY. */
export function parseDateRange(text: string): {
  start_date?: string;
  end_date?: string;
  is_current?: boolean;
} {
  // Try the paired DATE_RANGE_RE first.
  const m = DATE_RANGE_RE.exec(text);
  DATE_RANGE_RE.lastIndex = 0;
  if (m) {
    const start = normalizeDate(m[1]);
    const endRaw = m[2];
    if (/^(present|current|now|ongoing)$/i.test(endRaw)) {
      return { start_date: start, is_current: true };
    }
    return { start_date: start, end_date: normalizeDate(endRaw) };
  }
  // Fall back to loose detection: first year.
  const year = YEAR_RE.exec(text);
  YEAR_RE.lastIndex = 0;
  if (year) return { start_date: year[0] };
  return {};
}

function normalizeDate(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
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

export function stripDateRange(text: string): string {
  // Remove the paired match and leftover year tokens.
  let cleaned = text.replace(DATE_RANGE_RE, "").trim();
  DATE_RANGE_RE.lastIndex = 0;
  cleaned = cleaned.replace(/\b(Present|Current|Now|Ongoing)\b/gi, "").trim();
  cleaned = cleaned.replace(YEAR_RE, "").trim();
  YEAR_RE.lastIndex = 0;
  cleaned = cleaned.replace(/^[-–—,|\s]+|[-–—,|\s]+$/g, "");
  return cleaned;
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
  /\b(Engineer|Engineering|Developer|Manager|Director|Lead|Consultant|Analyst|Specialist|Associate|Architect|Principal|Officer|Designer|Scientist|Researcher|Administrator|Founder|Co-?founder|President|VP|Vice President|Head|Chief|CTO|CEO|COO|CFO|CIO|PM|TPM|SRE|DevOps)\b/i;

/** Heuristic: text contains title-like keywords but no company suffix. */
function looksLikeTitle(text: string): boolean {
  if (COMPANY_SUFFIX_RE.test(text)) return false;
  return TITLE_KEYWORDS_RE.test(text);
}

/**
 * Given 1..3 header lines, decide which is the company and which is the title.
 * Heuristics (in priority order):
 *   - If one contains COMPANY_SUFFIX_RE, that's the company.
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

  const companyIdx = splits.findIndex((s) => COMPANY_SUFFIX_RE.test(s.text));
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

export function extractEducation(
  education: PdfSection | undefined,
): { value: ResumeEducation[]; confidence: number } {
  if (!education || education.lines.length === 0)
    return { value: [], confidence: 0 };

  const lines = education.lines.filter((l) => !isBulletLine(l));
  if (lines.length === 0) return { value: [], confidence: 0 };

  // Anchor on institution-hint lines; walk forward to collect degree + year.
  const entries: ResumeEducation[] = [];
  const perEntryScores: number[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!INSTITUTION_HINTS.test(line.text)) {
      i++;
      continue;
    }

    const chunk: string[] = [line.text];
    let j = i + 1;
    while (j < lines.length && j < i + 3 && !INSTITUTION_HINTS.test(lines[j].text)) {
      chunk.push(lines[j].text);
      j++;
    }

    const joined = chunk.join(" | ");
    const institution = line.text.trim();
    const degreeMatch = DEGREE_RE.exec(joined);
    const degree = degreeMatch ? degreeMatch[0].trim() : "";
    // Use the shared date primitive (via the education-specific wrapper) so a
    // range like "Sep 2024 - July 2025" keeps both halves and a lone graduation
    // date lands in `end_date` — the old `YEAR_RE.exec(joined)[0]` took only the
    // first year and dropped the end (#97).
    const dates = parseEducationDates(joined);
    const hasDate = !!(dates.start_date || dates.end_date);

    let score = 0;
    if (institution) score += 0.3;
    if (degree) score += 0.4;
    if (hasDate) score += 0.3;

    entries.push({
      institution,
      degree,
      ...educationDateFields(dates),
    });
    perEntryScores.push(Math.min(score, 1));
    i = j;
  }

  if (entries.length === 0) {
    // Fallback: scan for degrees in any line.
    for (const line of lines) {
      const degreeMatch = DEGREE_RE.exec(line.text);
      if (!degreeMatch) continue;
      const dates = parseEducationDates(line.text);
      entries.push({
        degree: degreeMatch[0].trim(),
        institution: line.text.replace(degreeMatch[0], "").trim().replace(/[,|]+$/, ""),
        ...educationDateFields(dates),
      });
      perEntryScores.push(0.5);
    }
  }

  const avg =
    perEntryScores.reduce((a, b) => a + b, 0) /
    Math.max(perEntryScores.length, 1);
  return { value: entries, confidence: entries.length ? avg : 0 };
}
