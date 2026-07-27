// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * title-shape — "does this line read as a job title?", and the two regexes that
 * answer it. A LEAF module: it imports nothing, and nothing may be added here
 * that does.
 *
 * WHY IT IS ITS OWN FILE (#605 review). `looksLikeTitle` used to live in
 * `extract/shared.ts`, which imports `heuristics/regex.ts` (672 lines of parser
 * regexes). That was free while only the parser tiers called it — they are all
 * dynamic-imported from `cascade.ts`. It stopped being free when
 * `edit/headline.ts` started calling it for `headlineRoundTripWarning`, because
 * `ContactCard` imports THAT eagerly on `/`: the whole chain
 * `ContactCard → edit/headline → extract/shared → heuristics/regex` landed on
 * the entry graph, for one predicate over two regexes.
 *
 * Splitting the predicate out — rather than duplicating the constant, which
 * would leave two sources of truth for what a title looks like — keeps
 * `COMPANY_SUFFIX_RE` defined exactly once. `extract/shared.ts` re-exports
 * `looksLikeTitle` so its existing parser import sites are unchanged;
 * `COMPANY_SUFFIX_RE` needs no such shim because `extract/shared.ts` was its
 * only importer and now takes it from here directly.
 */

/** Legal-entity suffixes that mark a line as an employer, not a role. */
export const COMPANY_SUFFIX_RE =
  /\b(Inc\.?|LLC|Ltd\.?|Limited|Corp\.?|Corporation|Company|Co\.?|GmbH|S\.A\.?|Pty\.?|plc|Group|Holdings|Technologies|Systems|Labs|Solutions)\b/i;

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
