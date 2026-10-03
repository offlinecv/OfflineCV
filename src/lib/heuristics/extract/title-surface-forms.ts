// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * title-surface-forms — the shared inventory of job-title surface forms
 * (#918, part (d) of #653).
 *
 * TWO independent inventories of title surface forms used to live in the tree
 * with no way to compare them: `title-shape.ts`'s 64-keyword
 * `TITLE_KEYWORDS_RE` (the parser's title tiebreaker) and
 * `job-search/role-profiles.ts`'s hundreds of prevalence-ordered real-world
 * title phrases (curated for job search, not for parsing). This leaf is the
 * superset: every `title-shape.ts` keyword PLUS the title-search table's real
 * surface forms that `title-shape.ts`'s keyword list does not already imply.
 * `title-surface-forms.test.ts` asserts the `title-shape.ts` subset half of
 * that join; the other half — that `role-profiles.ts`'s curated titles are
 * covered by this leaf — is asserted in `role-profiles.test.ts`, against
 * that module's own `titleHasKnownSurfaceForm` predicate.
 *
 * SHAPE 2 (of the options #918 considered), AND WHY. `title-shape.ts`'s
 * whole reason to exist as its own file is staying OFF the eager `/` entry
 * graph (see its own docblock) — it must keep importing nothing. Making it
 * import this leaf would put job-search's 1500-line table on the parser's
 * eager graph; making this leaf import `role-profiles.ts` would put the
 * parser's regex module on job-search's AND violate #918's Decisions block,
 * which names job-search → heuristics as the only allowed direction. So
 * `title-shape.ts`'s own join with this leaf stays textually independent,
 * reconciled by a TEST, not a shared import (`title-surface-forms.test.ts`).
 * `role-profiles.ts` is the other side of that allowed direction, so it DOES
 * import this leaf at runtime and builds `titleHasKnownSurfaceForm` from it —
 * the same precedent `role-profiles.test.ts` already set for the jd-match
 * `SKILLS` join, but as a real import rather than a test-only one, same
 * direction `query-builder.ts` already uses for `looksLikeTitle`.
 *
 * A LEAF module: it imports nothing, and nothing may be added here that does
 * — the whole point is a module `job-search/role-profiles.ts` can depend on
 * without pulling anything else of the parser along.
 *
 * MEMBERSHIP, NOT ORDER. Unlike `role-profiles.ts`'s prevalence-ranked
 * `titles`, this array carries no ranking contract — it exists to answer
 * "is this string a known title surface form", which is a set-membership
 * question. Entries are Title Case for easy human diffing against
 * `title-shape.ts`'s `TITLE_KEYWORDS`; `role-profiles.ts`'s
 * `titleHasKnownSurfaceForm` matches case-insensitively by tokenizing both
 * sides, not via a regex here — this leaf stays a pure data array.
 */

/**
 * The full inventory: every `title-shape.ts` `TITLE_KEYWORDS` entry (kept
 * byte-identical here so the subset test is a real check, not a tautology)
 * plus the real-world phrases mined from `role-profiles.ts`'s
 * `CURATED_ROLE_PROFILES` that are NOT already implied by one of those
 * keywords — i.e. a phrase containing no `TITLE_KEYWORDS` word at all, and so
 * invisible to the parser's existing tiebreaker. Measured, not guessed: of
 * `CURATED_ROLE_PROFILES`'s 113 distinct title phrases, only three contain no
 * `TITLE_KEYWORDS` word — "Account Executive", "Penetration Tester" and
 * "Product Owner" — which is itself the finding this module exists to record:
 * the 64-word keyword list is already broad enough to catch the head noun of
 * almost every real title form; the job-search table's richness is mostly in
 * COMBINATIONS of those nouns, not new vocabulary.
 */
export const TITLE_SURFACE_FORMS = [
  // `title-shape.ts`'s `TITLE_KEYWORDS`, verbatim.
  "Engineer",
  "Engineering",
  "Developer",
  "Manager",
  "Director",
  "Lead",
  "Consultant",
  "Analyst",
  "Specialist",
  "Associate",
  "Architect",
  "Principal",
  "Officer",
  "Designer",
  "Scientist",
  "Researcher",
  "Administrator",
  "Founder",
  "Co-founder",
  "Cofounder",
  "President",
  "VP",
  "Vice President",
  "Head",
  "Chief",
  "CTO",
  "CEO",
  "COO",
  "CFO",
  "CIO",
  "PM",
  "TPM",
  "SRE",
  "DevOps",
  "Assistant",
  "Intern",
  "Internship",
  "Trainee",
  "Apprentice",
  "Coordinator",
  "Facilitator",
  "Technician",
  "Representative",
  "Supervisor",
  "Strategist",
  "Advisor",
  "Adviser",
  "Counselor",
  "Recruiter",
  "Accountant",
  "Auditor",
  "Editor",
  "Writer",
  "Producer",
  "Teacher",
  "Instructor",
  "Lecturer",
  "Professor",
  "Tutor",
  "Agent",
  "Clerk",
  "Ambassador",
  "Volunteer",
  "Fellow",
  // Real-world surface forms from `role-profiles.ts`'s `CURATED_ROLE_PROFILES`
  // that carry none of the keywords above, so `title-shape.ts` cannot see
  // them at all today.
  "Account Executive",
  "Penetration Tester",
  "Product Owner",
] as const;
