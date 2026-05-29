// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Shared regex library for heuristic resume extraction.
 *
 * Every pattern is global+case-insensitive where sensible and captures the
 * minimum needed to extract the field cleanly. Tests in `regex.test.ts` pin
 * the public surface so tightening one pattern does not silently regress
 * another extractor.
 */

// ── Contact patterns ────────────────────────────────────────────────────────

export const EMAIL_RE =
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;

/** Matches common US + international phone formats. Keep tolerant; dedup later. */
export const PHONE_RE =
  /(?:(?:\+?\d{1,3})[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g;

export const LINKEDIN_RE =
  /\b(?:https?:\/\/)?(?:www\.)?linkedin\.com\/(?:in|pub)\/[A-Z0-9_\-%]+\/?/gi;

export const GITHUB_RE =
  /\b(?:https?:\/\/)?(?:www\.)?github\.com\/[A-Z0-9_\-.]+\/?/gi;

/** Catch-all URL (falls back to portfolio/website bucket). */
export const URL_RE =
  /\bhttps?:\/\/[^\s<>()]+|\b[A-Z0-9-]+\.[A-Z]{2,}(?:\/[^\s<>()]*)?/gi;

// ── Location patterns ───────────────────────────────────────────────────────

/**
 * "City, ST". Matches up to 3 whitespace-separated capitalized tokens before
 * the comma — enough for "San Francisco", "New York", "Saint Louis", "Salt
 * Lake City" — and stops at any lowercase token. The previous
 * `[A-Z][A-Za-z.\- ]{1,30}` form was greedy on embedded spaces and ate
 * prepositional context like "of Engineering Seattle" out of column-merged
 * Education lines.
 */
export const US_LOCATION_RE =
  /\b([A-Z][A-Za-z.\-]+(?:\s+[A-Z][A-Za-z.\-]+){0,2}),\s*([A-Z]{2})\b/;
/** Same shape as US_LOCATION_RE but allows a multi-word region/country tail. */
export const INTL_LOCATION_RE =
  /\b([A-Z][A-Za-z.\-]+(?:\s+[A-Z][A-Za-z.\-]+){0,2}),\s*([A-Z][A-Za-z.\-]+(?:\s+[A-Z][A-Za-z.\-]+){0,2})\b/;

// ── Date patterns ───────────────────────────────────────────────────────────

const MONTH =
  "(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*";

/** "Jan 2020", "January 2020", "Jan. 2020", "Jan '20". 2-digit apostrophe
 *  form (`'20`) covers older resumes that use AP-style short dates. */
export const MONTH_YEAR_RE = new RegExp(
  `\\b${MONTH}\\.?\\s+(?:\\d{4}|'\\d{2})\\b`,
  "gi",
);

/** "01/2020", "1/2020", "01-2020". */
export const NUMERIC_MONTH_YEAR_RE = /\b(0?[1-9]|1[0-2])[\/\-]\d{4}\b/g;

/** Bare 4-digit year, used as a weaker signal. */
export const YEAR_RE = /\b(19|20)\d{2}\b/g;

/** "Present" / "Current" / "Now" — open-ended end dates. */
export const PRESENT_RE = /\b(Present|Current|Now|Ongoing)\b/i;

// Shared fragment for one date anchor (Mmm YYYY | 'YY, mm/yyyy, YYYY).
// Reused by DATE_RANGE_RE's start and end groups. Apostrophe-year keeps
// DOCX parsing compatible with older resumes that use "Dec '00".
const DATE_ANCHOR = `${MONTH}\\.?\\s+(?:\\d{4}|'\\d{2})|\\d{1,2}[\\/\\-]\\d{4}|\\d{4}`;

/**
 * Date range between two anchors. Captures both halves. Tolerant of spacing,
 * dashes (—, –, -, to, through).
 */
export const DATE_RANGE_RE = new RegExp(
  `(${DATE_ANCHOR})` +
    `\\s*(?:–|—|-|to|through)\\s*` +
    `(${DATE_ANCHOR}|Present|Current|Now|Ongoing)`,
  "i",
);

// ── Section header keywords ─────────────────────────────────────────────────

export const SECTION_KEYWORDS = {
  summary: [
    "summary",
    "profile",
    "objective",
    "about",
    "about me",
    "professional summary",
  ],
  experience: [
    "experience",
    "work experience",
    "professional experience",
    "employment",
    "employment history",
    "work history",
    "career",
    "career history",
  ],
  education: ["education", "academic background", "academics", "qualifications"],
  skills: [
    "skills",
    "technical skills",
    "core competencies",
    "competencies",
    "expertise",
    "technologies",
  ],
  projects: ["projects", "personal projects", "selected projects"],
  certifications: ["certifications", "certificates", "licenses", "awards"],
} as const;

export type SectionName = keyof typeof SECTION_KEYWORDS;

/** True if the normalized line text matches any known section header. */
export function matchSectionHeader(text: string): SectionName | null {
  const normalized = text.trim().toLowerCase().replace(/[:·•]+$/, "").trim();
  if (normalized.length === 0 || normalized.length > 40) return null;
  for (const [name, keywords] of Object.entries(SECTION_KEYWORDS) as Array<
    [SectionName, readonly string[]]
  >) {
    if (keywords.includes(normalized)) return name;
  }
  return null;
}

// ── Degree patterns ─────────────────────────────────────────────────────────

export const DEGREE_RE =
  /\b(B\.?A\.?|B\.?S\.?|B\.?Sc\.?|B\.?E\.?|B\.?Eng\.?|B\.?Tech\.?|M\.?A\.?|M\.?S\.?|M\.?Sc\.?|M\.?Eng\.?|M\.?B\.?A\.?|Ph\.?D\.?|M\.?D\.?|J\.?D\.?|Bachelor|Master|Doctor|Associate)(?:\s+of\s+[A-Za-z ]{2,40})?/;

export const INSTITUTION_HINTS =
  /\b(University|College|Institute|School|Academy|Polytechnic)\b/i;

// ── Company suffix hints ────────────────────────────────────────────────────

export const COMPANY_SUFFIX_RE =
  /\b(Inc\.?|LLC|Ltd\.?|Limited|Corp\.?|Corporation|Company|Co\.?|GmbH|S\.A\.?|Pty\.?|plc|Group|Holdings|Technologies|Systems|Labs|Solutions)\b/i;
