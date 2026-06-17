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
//
// Data lives in sections.config.json; the typed loader in sections.config.ts
// owns the derived structures. Imported here for local use by matchSectionHeader
// and re-exported so all existing import paths (sections.ts, markdown-lines.ts,
// extract-fields.ts) resolve unchanged without touching those files.

import {
  SECTION_KEYWORDS,
  SPLIT_LETTER_NORMALIZABLE_SECTIONS,
  SECTION_ANCHORS,
  SECTION_ANCHOR_FALLBACKS,
  type SectionName,
} from "./sections.config.ts";

export {
  SECTION_KEYWORDS,
  SPLIT_LETTER_NORMALIZABLE_SECTIONS,
  SECTION_ANCHORS,
  SECTION_ANCHOR_FALLBACKS,
  type SectionName,
} from "./sections.config.ts";

// A short intro letter separated from the rest of the word by a space:
// `S UMMARY`, `E XPERIENCE`, `e xperience`. Designed templates letter-space
// (track) the first glyph, and Word's icon-letter decoration renders it as a
// separate character, so the PDF/markdown text layer reads the lead letter
// split off. Restricted to (a) a single alpha char followed by a space and
// (b) a following word of 3+ alpha chars. Shared by the markdown preprocessor
// (`normalizeSplitLetterHeaders`) and the PDF-line `matchSectionHeader`.
export const SPLIT_LETTER_RE = /\b([A-Za-z])\s+([A-Za-z]{3,})\b/g;

/** Rejoin single split lead letters: `e xperience` → `experience`. */
function rejoinSplitLetters(text: string): string {
  return text.replace(SPLIT_LETTER_RE, (_m, a: string, b: string) => `${a}${b}`);
}

// Leading bullet glyph on a raw line. Mirrors `isBulletLine` in
// line-primitives.ts (kept as a local literal here, not an import, to avoid the
// import cycle line-primitives → regex). A header-shaped line that begins with
// a bullet is content, not a heading, so the anchor fallback must reject it.
const LEADING_BULLET_RE = /^\s*[•‣▪●◦⁃*\-–—]/;

/**
 * Head-noun anchor fallback for qualified section headers (L2 / #111).
 *
 * Fires only when the exact-alias and split-letter matches both fail. A
 * qualified header is a modifier + canonical category noun — "Relevant
 * Experience", "Customer Service Experience" (#108) — whose *last* token is the
 * head noun. Matching head-noun-LAST (not substring `contains`) is the actual
 * grammar of section headers: "Customer Service Experience" classifies, while
 * the prose FP class — "5 years of relevant experience leading teams" — does
 * not *end* in the head noun and is over length / word-count, so it never
 * triggers.
 *
 * All guardrails must hold (the raw-line splitter runs this on every PDF line):
 *   1. length ≤ 40           — enforced by the caller before this runs.
 *   2. word count ≤ 4        — qualifier(s) + head noun.
 *   3. last token ∈ anchors  — head-noun-last, not contains.
 *   4. no terminal `.`/`!`/`?` — sentence punctuation marks prose.
 *   5. not a bullet line     — checked on the raw text by the caller.
 *   6. section's anchorFallback flag is true — `skills`/`other` stay OFF, so a
 *      flattened two-column "SKILLS" sidebar label cannot open a section
 *      mid-experience and strand the following roles.
 *   7. header-cased        — every alphabetic word is Title Case (initial
 *      capital) or the whole line is ALL CAPS. This is what separates a heading
 *      ("Relevant Experience") from a lowercase prose fragment that happens to
 *      end in the head noun ("i have experience"). Checked on the raw text.
 *
 * `raw` is the original line text (case preserved); `normalized` is the
 * already-trimmed/lowercased/colon-stripped text from the caller. Returns the
 * matched section, or null when no guardrail-passing anchor is found.
 */
function matchAnchorFallback(
  raw: string,
  normalized: string,
): SectionName | null {
  // Guard 4: terminal sentence punctuation marks prose, not a heading.
  if (/[.!?]$/.test(normalized)) return null;
  const tokens = normalized.split(/\s+/).filter((t) => t.length > 0);
  // Guard 2: a qualified header is short (qualifier(s) + head noun).
  if (tokens.length === 0 || tokens.length > 4) return null;
  // Guard 7: header casing. Each word that starts with a letter must start
  // with an uppercase letter (Title Case) — ALL CAPS satisfies this trivially.
  // Rejects prose fragments like "i have experience" that end in a head noun.
  const rawWords = raw.trim().split(/\s+/).filter((w) => w.length > 0);
  for (const w of rawWords) {
    const first = w[0];
    if (/[a-z]/.test(first)) return null;
  }
  const last = tokens[tokens.length - 1];
  // Guard 3 + 6: last token must be an anchor of a fallback-enabled section.
  for (const [name, anchors] of Object.entries(SECTION_ANCHORS) as Array<
    [SectionName, ReadonlySet<string>]
  >) {
    if (anchors.has(last) && SECTION_ANCHOR_FALLBACKS.has(name)) return name;
  }
  return null;
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
  // Head-noun anchor fallback for qualified headers ("Relevant Experience").
  // Guard 5 (not a bullet line) runs on the raw text here, before the
  // bullet glyph is normalized away. See matchAnchorFallback for the rest.
  if (!LEADING_BULLET_RE.test(text)) {
    const anchored = matchAnchorFallback(text, normalized);
    if (anchored) return anchored;
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
