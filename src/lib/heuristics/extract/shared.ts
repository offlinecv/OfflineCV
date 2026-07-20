// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

import {
  COMPANY_SUFFIX_RE,
  INSTITUTION_HINTS,
} from "../regex.ts";

/** First regex hit as trimmed string, or undefined. */
export function firstMatch(re: RegExp, text: string): string | undefined {
  // Re-init lastIndex for global regexes so calls are idempotent.
  re.lastIndex = 0;
  const match = re.exec(text);
  return match?.[0]?.trim();
}

/** All regex hits, deduped. */
export function allMatches(re: RegExp, text: string): string[] {
  re.lastIndex = 0;
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.add(m[0].trim());
  return [...out];
}

/**
 * All regex hits with their match positions. Unlike `allMatches`, this does NOT
 * deduplicate — every occurrence is returned in order, so callers can reason
 * about which specific occurrence of a repeated token they are dealing with.
 *
 * Use this instead of `allMatches` when you need to pass the match index to
 * `isStandaloneUrl` (avoids substring aliasing — see #249).
 */
export function allMatchesWithIndex(
  re: RegExp,
  text: string,
): { text: string; index: number }[] {
  re.lastIndex = 0;
  const out: { text: string; index: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push({ text: m[0].trim(), index: m.index });
  }
  return out;
}

/**
 * True when `url` is positionally a link in `sourceText` — not embedded as a
 * bare domain mid-sentence in prose.
 *
 * A URL is treated as standalone when it does NOT have a word character
 * immediately before AND a word character immediately after its occurrence in
 * the source text. Mid-sentence prose embeds a domain between words on both
 * sides ("sold return2india.com to Satyam"), while a genuine link line or a
 * header URL sits at a boundary (start/end of line, or adjacent to separators
 * like ` | `, `·`, `—`).
 *
 * A URL with an explicit scheme (`https?://`) or `www.` prefix is always
 * treated as standalone — the scheme is unambiguous intent.
 *
 * @param url        - The URL string as matched (e.g. "return2india.com").
 * @param sourceText - The text to search within for positional context.
 * @param knownIndex - The exact byte-offset of `url` within `sourceText` as
 *                     returned by `RegExp.exec` (i.e. `match.index`). When
 *                     provided, it is used directly instead of `indexOf`, which
 *                     eliminates the substring-aliasing bug where
 *                     `"site.com".indexOf("site.com")` would land inside
 *                     `"mysite.com"` rather than at the genuine standalone
 *                     occurrence (#249).
 */
export function isStandaloneUrl(
  url: string,
  sourceText: string,
  knownIndex?: number,
): boolean {
  // An explicit scheme or www. is always intentional — treat as standalone.
  if (/^https?:\/\//i.test(url) || /^www\./i.test(url)) return true;
  // Use the caller-supplied regex match index when available — avoids the
  // substring-aliasing problem of indexOf (see #249). Fall back to indexOf
  // only for backward-compat with callers that don't supply the index.
  const idx = knownIndex ?? sourceText.indexOf(url);
  if (idx === -1) return true; // can't find it — assume standalone
  // Trim surrounding whitespace to look at the nearest non-space char on each
  // side. "sold return2india.com to" has a space immediately before/after, but
  // the nearest non-space chars are word chars — so it is mid-sentence prose.
  const before = sourceText.slice(0, idx).trimEnd();
  const after = sourceText.slice(idx + url.length).trimStart();
  // Mid-sentence: word chars on BOTH sides (after trimming whitespace) →
  // embedded in prose. A domain at start/end of text, or adjacent to
  // separators (|, ·, —), has no word char on at least one side.
  const wordBefore = /\w$/.test(before);
  const wordAfter = /^\w/.test(after);
  return !(wordBefore && wordAfter);
}

/**
 * Keywords that commonly appear in a job title. Used as a tiebreaker when
 * neither header line carries a company suffix:
 * modern resumes often flip the "Company first, then Title" convention
 * and put Title on the top (H2) with Company below (H3). Without this
 * heuristic the default fallback misattributes a `**Sr. Engineering
 * Manager (L7)**` header as the company and `**Globex / CloudWave**`
 * as the title.
 */
const TITLE_KEYWORDS_RE =
  /\b(Engineer|Engineering|Developer|Manager|Director|Lead|Consultant|Analyst|Specialist|Associate|Architect|Principal|Officer|Designer|Scientist|Researcher|Administrator|Founder|Co-?founder|President|VP|Vice President|Head|Chief|CTO|CEO|COO|CFO|CIO|PM|TPM|SRE|DevOps|Assistant|Intern|Internship|Trainee|Apprentice|Coordinator|Technician|Representative|Supervisor|Strategist|Advisor|Adviser|Counselor|Recruiter|Accountant|Auditor|Editor|Writer|Producer|Teacher|Instructor|Lecturer|Professor|Tutor|Agent|Clerk|Ambassador|Volunteer|Fellow)\b/i;

/** Heuristic: text contains title-like keywords but no company suffix. */
export function looksLikeTitle(text: string): boolean {
  if (COMPANY_SUFFIX_RE.test(text)) return false;
  return TITLE_KEYWORDS_RE.test(text);
}

/** Employer signal: a legal suffix ("Inc", "LLC") OR an institution word
 *  ("University", "College") — and NOT itself a job-title line, so a designation
 *  like "University Lecturer" or "School Counselor" stays a title rather than
 *  being mistaken for the company. */
export function looksLikeCompany(text: string): boolean {
  return (
    (COMPANY_SUFFIX_RE.test(text) || INSTITUTION_HINTS.test(text)) &&
    !looksLikeTitle(text)
  );
}

/** Mean of per-entry confidence scores; 0 for an empty list. */
export function avgScore(scores: number[]): number {
  return scores.reduce((a, b) => a + b, 0) / Math.max(scores.length, 1);
}

/**
 * Drop entries the parser couldn't label — a date-only / title-less block whose
 * header reduced to "" (#145) — then package the survivors as the standard
 * `{ value, confidence }` pair the three entry extractors return. Filtering on
 * the built entry's label (not on empty `headerLines`) also catches a URL-only
 * header, which `liftHeaderLabel` collapses to an empty label. Keeping the
 * phantom out of the list also keeps its score 0 out of the `avgScore`
 * denominator, so it no longer dilutes section confidence.
 */
export function finalizeEntries<T>(
  built: { entry: T; score: number }[],
  hasLabel: (entry: T) => boolean,
): { value: T[]; confidence: number } {
  const kept = built.filter((b) => hasLabel(b.entry));
  return {
    value: kept.map((b) => b.entry),
    confidence: avgScore(kept.map((b) => b.score)),
  };
}
