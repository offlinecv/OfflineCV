// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The resumelint Authors

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
