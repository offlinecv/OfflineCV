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
  certifications: ["certifications", "certificates", "licenses"],
  /**
   * Achievements family (#96). Promoted out of the `other` sink into a real,
   * extracted section: an Achievements / Accomplishments / Awards / Activities
   * block is name-led and often single-line, so it is parsed by
   * `extractAchievements` on the shared entry-block primitive and rendered as
   * its own section. Like every other keyed section it still pushes a section
   * boundary in `splitIntoSections`, so it continues to terminate the preceding
   * section (the boundary job it did while in `other`) — sidebar labels above
   * the main content stream don't bleed across it. `awards` lives here rather
   * than under `certifications` (where it was a loose alias) so an AWARDS
   * heading reads as an achievement, not a certification.
   */
  achievements: [
    "achievements",
    "accomplishments",
    "activities",
    "awards",
    "awards & honors",
    "awards and honors",
    "honors",
    "honors & awards",
    "honors and awards",
  ],
  /**
   * Sink bucket for genuinely-ignored sidebar labels that must terminate the
   * preceding section (e.g. STRENGTHS, FOCUS AREAS in two-column PDFs).
   * Nothing renders an `other` section; its sole job is to act as a boundary
   * so content that follows it does not bleed into the preceding section.
   */
  other: [
    "strengths",
    "highlights",
    "focus areas",
    "interests",
    "languages",
    "volunteer",
    "volunteering",
    "references",
    "hobbies",
    "publications",
  ],
} as const;

export type SectionName = keyof typeof SECTION_KEYWORDS;

// A short intro letter separated from the rest of the word by a space:
// `S UMMARY`, `E XPERIENCE`, `e xperience`. Designed templates letter-space
// (track) the first glyph, and Word's icon-letter decoration renders it as a
// separate character, so the PDF/markdown text layer reads the lead letter
// split off. Restricted to (a) a single alpha char followed by a space and
// (b) a following word of 3+ alpha chars. Shared by the markdown preprocessor
// (`normalizeSplitLetterHeaders`) and the PDF-line `matchSectionHeader`.
export const SPLIT_LETTER_RE = /\b([A-Za-z])\s+([A-Za-z]{3,})\b/g;

/**
 * Section keywords we're willing to reconstruct from a split lead letter
 * (e.g. `S UMMARY` → `SUMMARY`). Deliberately excludes `skills`-family
 * keywords: two-column résumés commonly place a SKILLS label in the sidebar,
 * which flattens INTO the main content stream *between* experience entries.
 * Normalizing `S KILLS` there would open a new section mid-experience and
 * strand every subsequent role. Literal "SKILLS" headers in the main column
 * don't use the split-letter decoration in practice, so we lose almost
 * nothing by excluding this keyword.
 */
export const SPLIT_LETTER_NORMALIZABLE_SECTIONS: ReadonlySet<SectionName> =
  new Set(["summary", "experience", "education", "certifications", "projects"]);

/** Rejoin single split lead letters: `e xperience` → `experience`. */
function rejoinSplitLetters(text: string): string {
  return text.replace(SPLIT_LETTER_RE, (_m, a: string, b: string) => `${a}${b}`);
}

/** True if the normalized line text matches any known section header. */
export function matchSectionHeader(text: string): SectionName | null {
  const normalized = text.trim().toLowerCase().replace(/[:·•]+$/, "").trim();
  if (normalized.length === 0 || normalized.length > 40) return null;
  for (const [name, keywords] of Object.entries(SECTION_KEYWORDS) as Array<
    [SectionName, readonly string[]]
  >) {
    if (keywords.includes(normalized)) return name;
  }
  // Split-letter headers: pdfjs reads a tracked/decorated `EXPERIENCE` as
  // `E XPERIENCE`. Rejoin single split letters and retry, gated to the
  // allowlist (skills excluded) so prose can't mint a false section. See #56.
  const rejoined = rejoinSplitLetters(normalized);
  if (rejoined !== normalized) {
    for (const [name, keywords] of Object.entries(SECTION_KEYWORDS) as Array<
      [SectionName, readonly string[]]
    >) {
      if (keywords.includes(rejoined) && SPLIT_LETTER_NORMALIZABLE_SECTIONS.has(name))
        return name;
    }
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
