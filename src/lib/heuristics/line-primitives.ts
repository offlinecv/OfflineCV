// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

/**
 * Leaf-level line primitives shared by the entry-block parser and the field
 * extractors: bullet detection/stripping and date-range parsing.
 *
 * These live in their own module to break the import cycle that arises when
 * `entry-blocks.ts` (the shared windowing primitive) and `extract-fields.ts`
 * (its caller) both need the same low-level helpers. This module depends only
 * on `regex.ts` constants and the `PdfLine` type — nothing in the heuristics
 * layer imports back into it — so it sits cleanly below both.
 */

import type { PdfLine } from "./sections.ts";
import { DATE_RANGE_RE, YEAR_RE } from "./regex.ts";

/** True if the line looks like a bullet point (starts with •, ‣, -, *, ◦, or is indented prose). */
export function isBulletLine(line: PdfLine): boolean {
  return /^\s*[•‣▪●◦⁃*\-–—]/.test(line.text);
}

/** Strip leading bullet glyphs + whitespace. */
export function stripBullet(text: string): string {
  return text.replace(/^\s*[•‣▪●◦⁃*\-–—]\s*/, "").trim();
}

/**
 * True when a line reads like a description sentence rather than an entry
 * header (company / title / institution). Some templates — notably the Word /
 * Office résumé templates — write the role description as a glyph-less prose
 * paragraph instead of a bulleted list, so `isBulletLine` alone can't tell the
 * description apart from the header lines around the date.
 *
 * Two signals, both required, plus a word floor:
 *   - a lowercase letter (a long ALL-CAPS company/title isn't prose), and
 *   - an INTERNAL sentence break ("…accomplishments. Where the team…") — a
 *     period between two letters, a capitalized word, then a RUNNING CLAUSE:
 *     a later lowercase-initial word in that second sentence. This is what
 *     keeps a long-but-header line like "Acme Analytics (8 employee
 *     venture-backed startup) New York, NY" out: it has commas and parentheses
 *     but no sentence period, so it stays a header (and its company is
 *     preserved). The lowercase-continuation requirement is the other half:
 *     a résumé's "Company. City, State" header delimiter ALSO looks like a
 *     "word. Capital" break, but its tail is an all-Title-Case location with
 *     no lowercase word — so it is NOT prose. Without that guard, a two-column
 *     role header like "…Northwind Technology. San Jose, California" was misread
 *     as a description, its block dropped, and the role demoted to loose bullets
 *     under a neighbor (#341).
 * The 8-word floor sits just under the scorer's 8-30-word bullet window, so a
 * paragraph the scorer would grade as a bullet is captured as body here too.
 * Glyph-less descriptions WITHOUT a sentence period (e.g. indented one-line
 * bullets) are left to the bullet/indent path, unchanged by this predicate.
 */
const PROSE_MIN_WORDS = 8;
// `word. Capital…` (a sentence break) followed, before the next period, by a
// space + lowercase letter (a real second clause). The trailing lowercase is
// what separates a running sentence from a "Company. City, State" location tail
// (all Title-Case, no lowercase word → not prose). See #341.
const SENTENCE_BREAK_RE = /[a-z]{2}\.\s+[A-Z][^.]*\s[a-z]/;
export function isProseLine(text: string): boolean {
  const trimmed = text.trim();
  if (!/[a-z]/.test(trimmed)) return false;
  if (!SENTENCE_BREAK_RE.test(trimmed)) return false;
  return trimmed.split(/\s+/).filter(Boolean).length >= PROSE_MIN_WORDS;
}

/**
 * A page running-header / footer line — the candidate's own name + "Resume" /
 * "Résumé" / "CV" / "Curriculum Vitae" furniture a continuation page repeats at
 * its top or bottom (often beside a date and a page number, e.g. "June 10, 2026
 * Jane Doe Resume 2" / "Jane Doe · Résumé 1"). When an entry-style section
 * (experience, projects, education, or an achievements-family section) spans a
 * page break, that furniture line lands mid-section and would otherwise become
 * an entry header (a role's company/title) or contaminate a description blob
 * (#225, generalized #283). A genuine entry line never carries the word
 * résumé/CV, so keying on it is a safe, content-free strip. Matched
 * case-insensitively and accent-tolerantly (`Résumé`/`Resume`).
 *
 * NB: `\b` is unreliable around the accented `é` (not a `\w` char in JS regex),
 * so we anchor on the ASCII-letter side only: `(?<![A-Za-z])` … `(?![A-Za-z])`.
 * These spelled-out forms are rare inside an entry title, so a letter boundary
 * is a safe key.
 */
const PAGE_FURNITURE_RE =
  /(?<![A-Za-z])(r[ée]sum[ée]|curriculum\s+vitae)(?![A-Za-z])/i;

// The bare two-letter "CV" is far easier to hit by accident inside content — a
// parenthesised domain acronym ("Cardiovascular (CV) Fellowship"), a hyphenated
// code ("CV-204"), a journal short-name — so it strips a real entry if keyed on
// a letter boundary alone. Require it to stand alone between whitespace / line
// ends, which the running-header form ("Jane Doe · CV", "Name CV 2") satisfies
// but a punctuation-adjacent in-content "CV" does not.
const CV_FURNITURE_RE = /(?:^|\s)cv(?:$|\s)/i;

/** True when the line is page running-header/footer furniture, not content.
 *  Shared by the achievements extractor and the entry-block parser so a footer
 *  that lands mid-section on a page break is stripped on every entry path. */
export function isPageFurniture(line: PdfLine): boolean {
  return PAGE_FURNITURE_RE.test(line.text) || CV_FURNITURE_RE.test(line.text);
}

/** Collapse internal whitespace and trim — the canonical date-token normalizer. */
export function normalizeDate(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

/** True when a parsed date anchor is an unfilled Word/Office template placeholder
 *  ("Month Year", or a bare "Month"/"Year") rather than a real date. `DATE_RANGE_RE`
 *  admits these word placeholders so a template role still anchors/splits and the
 *  placeholder strips off the title — but the placeholder must NOT be recorded as a
 *  real date, or completeness would stop flagging the missing role dates. */
function isPlaceholderDate(token: string): boolean {
  return /^(?:month(?:\s+year)?|year)$/i.test(token.trim());
}

/** Parse a date range (start/end) from a line. Tolerates M/YYYY, Mmm YYYY, YYYY,
 *  and Season YYYY[, YYYY] (branch (c) of DATE_RANGE_RE). */
export function parseDateRange(text: string): {
  start_date?: string;
  end_date?: string;
  is_current?: boolean;
} {
  // Try the paired DATE_RANGE_RE first.
  const m = DATE_RANGE_RE.exec(text);
  DATE_RANGE_RE.lastIndex = 0;
  if (m) {
    // Branch (c): Season YYYY, YYYY — m[5] is start ("Summer 2013"), m[6] is end year.
    if (m[5] !== undefined) {
      return { start_date: normalizeDate(m[5]), end_date: normalizeDate(m[6]) };
    }
    const start = normalizeDate(m[1] ?? m[3]);
    // An unfilled template range ("Month Year - ...") matched only to anchor and
    // strip the role header — it carries no real date, so report none. (A real
    // start with a placeholder end still keeps the start; see below.)
    if (isPlaceholderDate(start)) return {};
    const endRaw = m[2] ?? m[4];
    if (/^(present|current|now|ongoing)$/i.test(endRaw)) {
      return { start_date: start, is_current: true };
    }
    const end = normalizeDate(endRaw);
    return isPlaceholderDate(end)
      ? { start_date: start }
      : { start_date: start, end_date: end };
  }
  // Fall back to loose detection: first year.
  const year = YEAR_RE.exec(text);
  YEAR_RE.lastIndex = 0;
  if (year) return { start_date: year[0] };
  return {};
}

// A range whose START token is a bare SEASON ("Fall 2013 – Spring 2014",
// "Summer 2013, 2014"). Deliberately EXCLUDED from `isLoneDateRange` (see below).
const SEASON_LEAD_RE = /^(?:Spring|Summer|Fall|Autumn|Winter)\b/i;

/**
 * True when `text` is nothing but a month-year / year date range. The single
 * discriminator shared by two #425 flush-right-date call sites so they can never
 * drift: the section splitter's `flush()` exemption (which keeps a flush-right
 * date merged into the org line's `PdfLine` instead of splitting it off at the
 * wide same-y gap) and the ATS PDF model (which only routes a date to the
 * flush-right slot when it is one of these, keeping everything else glued into
 * the line's text). Reuses the shared `DATE_RANGE_RE` rather than a hand-rolled
 * pattern, and requires it to cover the ENTIRE trimmed run: a lone
 * `Jan 2024 – Present` / `2019 - 2021` qualifies, but a run carrying any other
 * text (a course name, a skill, an org fragment) does not — so a genuine
 * multi-column grid's trailing column still splits.
 *
 * Two shapes are deliberately NOT matched, so they stay glued rather than
 * flush-right — both fully round-trip-safe (gluing is the #430 behavior), and
 * both narrowing the blast radius of this core line-splitter change:
 *   - a bare single date/year: `DATE_RANGE_RE` needs two anchors, so a lone
 *     `2020` returns false; and
 *   - a SEASON-led range (`Fall 2013 – Spring 2014`, `Summer 2013, 2014`): this
 *     exclusion is load-bearing for an EXTERNAL fixture, not our own export.
 *     `word/openresume-laverne-word-quartz.pdf` carries a flush-right honors
 *     rail — "Dean's List  … Fall 2013 – Spring 2014" / "Summer 2013, 2014" —
 *     and its committed corpus snapshot depends on those season rails staying
 *     SPLIT off the "Dean's List" label (dropping the exclusion re-parses the
 *     fixture and fails `corpus.test`, verified). Merging a season range onto its
 *     honors label mis-segments the label as a dated entry.
 *
 *     Why seasons but NOT a plain year-range honors line ("Dean's List
 *     2019 - 2021", which IS treated as a lone range and would merge): this is a
 *     deliberately NARROW, fixture-anchored carve-out, not a claim that every
 *     honors rail is excluded. Season ranges are near-exclusive to academic /
 *     honors contexts, so excluding them is low-collateral; a bare YEAR range is
 *     overwhelmingly a real employment/education date rail (the shape the
 *     exporter actually right-aligns), so excluding it too would defeat the
 *     flush-right round-trip it exists to protect. The #425 multi-row fix
 *     (`columnGapCuts` in `sections.ts`) does NOT subsume this: it stops ≥2
 *     adjacent date rails from being read as a column grid, but a single honors
 *     rail still reaches `flush()`, where merging vs. splitting is exactly what
 *     the season exclusion controls — so the carve-out is still required.
 */
export function isLoneDateRange(text: string): boolean {
  const t = text.trim();
  if (t.length === 0 || SEASON_LEAD_RE.test(t)) return false;
  // `DATE_RANGE_RE`'s bare-year anchor is `\d{4}`, so a plain numeric range that
  // is not a date ("5000 - 6000", a salary/score grid column) full-matches. Gate
  // on a real date signal: a plausible 19xx/20xx year, or any month / season /
  // slash / apostrophe / placeholder token (each of which carries a letter,
  // slash, or apostrophe). A bare non-year numeric range has none, so it stays a
  // normal splittable grid column instead of being merged as a flush-right rail.
  if (!/(?:19|20)\d{2}|[A-Za-z'/]/.test(t)) return false;
  const m = DATE_RANGE_RE.exec(t);
  DATE_RANGE_RE.lastIndex = 0;
  return m !== null && m.index === 0 && m[0].length === t.length;
}

export function stripDateRange(text: string): string {
  // Remove the paired match and leftover year tokens.
  let cleaned = text.replace(DATE_RANGE_RE, "").trim();
  DATE_RANGE_RE.lastIndex = 0;
  cleaned = cleaned.replace(/\b(Present|Current|Now|Ongoing)\b/gi, "").trim();
  cleaned = cleaned.replace(YEAR_RE, "").trim();
  YEAR_RE.lastIndex = 0;
  // After year removal, bracket/paren pairs that held only the year are now
  // empty (e.g. "[2019]" → "[]", "(2019)" → "()"). Strip them.
  cleaned = cleaned.replace(/\[\s*\]|\(\s*\)/g, "").trim();
  cleaned = cleaned.replace(/^[-–—,|\s]+|[-–—,|\s]+$/g, "");
  return cleaned;
}
