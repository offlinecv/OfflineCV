// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * role-profiles.ts — the canonical *role → expected titles + expected skills*
 * table (#582), and the two resolvers that read it.
 *
 * WHY THIS MODULE EXISTS. Three vocabularies already live in the tree and none
 * of them knows about the others: `ROLE_KEYWORDS` (posting-title matching),
 * jd-match `SKILLS` (tool-shaped canonical skills), and the flat derived query
 * terms. Because of that the product cannot say which of a résumé's own words
 * carry weight, which expected words are missing, or whether the titles and the
 * skills describe the same job. All three questions reduce to one missing
 * asset: a map from a role to *the titles and skills that role is actually
 * described with*. That asset is `ROLE_PROFILES`. The consumers (term-quality
 * classifier, the coherence check, the query-legibility surfaces) ship
 * separately and are deliberately NOT built here.
 *
 * THE CONSTRAINT THIS GUARDS: **no LLM, no network, no WebGPU.** This has to
 * answer on a cold browser load with WebGPU absent, exactly like
 * `src/lib/score/score.ts` and the heuristic parser. That forces a curated,
 * versioned static table with pure, synchronous, deterministic resolvers — the
 * same house precedent `ROLE_KEYWORDS` set. Nothing here fetches, and nothing
 * here is résumé-derived egress.
 *
 * NOT A FORK OF `ROLE_KEYWORDS`. `ROLE_KEYWORDS` answers *"is this **posting**
 * in this family"* — its entries are tuned for precision against a board's
 * titles and deliberately omit IC-ambiguous phrases. `RoleProfile.titles`
 * answers a different question — *"what do people in this role call
 * themselves, and in what order of prevalence"* — so it carries surface forms
 * `ROLE_KEYWORDS` must not carry, and its head element is the one term we can
 * honestly call "the common title for this role". Merging the two would break
 * posting matching. They stay reconcilable through `RoleProfile.family`, which
 * is a real `RoleFamily`; `role-profiles.test.ts` asserts that, so the two
 * assets cannot drift into contradiction.
 *
 * WHY THE TWO RESOLVERS ARE SEPARATE. `resolveProfilesByTitles` and
 * `resolveProfilesBySkills` answer deliberately different questions and neither
 * is implemented in terms of the other. *Comparing their two answers* is how a
 * downstream title/skill mismatch check works — a résumé listing leadership
 * titles and exclusively IC tool skills is a real, actionable finding, and it
 * is only visible if the two questions are asked independently. Collapsing them
 * into one resolver with a mode flag would destroy that.
 *
 * TITLE-MATCHING RULE (deterministic, stated once, tested):
 *
 *   A profile title matches a résumé title when the profile title's TOKEN SET
 *   is a SUBSET of the résumé title's token set, after both sides go through
 *   the SAME normalizer (`profileTitleTokens`).
 *
 * Consequences, all deliberate:
 *   - Order-insensitive: "Director of Engineering" and "Engineering Director"
 *     are the same set, so one entry covers both.
 *   - Decoration-tolerant in ONE direction only: a résumé title may carry extra
 *     words ("Senior Engineering Manager, Payments" still matches "engineering
 *     manager"); a profile title may not. That asymmetry is what stops the
 *     broad entry "software engineer" from claiming every engineering title.
 *   - Abbreviations are folded by `TITLE_ABBREVIATIONS` before tokenizing, so
 *     "Sr. Software Engineer" and "Senior Software Engineer" are identical —
 *     the exact case that decides whether this asset is useful at all.
 *   - NO STEMMING. "engineer" and "engineering" stay distinct tokens, which is
 *     precisely why "software engineer" does not match "Software Engineering
 *     Manager". Adding a stemmer would silently merge the IC ladder into the
 *     management ladder.
 *
 * WHY NOT `tokenizeWords` FROM `role-keywords.ts`. That tokenizer drops every
 * token of ≤2 characters — correct for its job (word-overlap significance
 * against posting titles), fatal here: it would erase "vp", "ux", "ml" and
 * "qa", the very tokens that separate a VP from an engineer.
 * `profileTitleTokens` below keeps short tokens and instead drops a fixed
 * stop-word list. The two tokenizers are not interchangeable and must not be
 * unified — the name carries the `profile` prefix so it cannot be confused with
 * `search.ts`'s own posting-admission tokenizer, which is a third rule again.
 *
 * SKILL MATCHING. `RoleProfile.skills` holds canonical jd-match `SKILLS` ids.
 * `resolveProfilesBySkills` compares ids case- and separator-insensitively
 * (`normalizeSkillKey`), so a caller may pass raw ids or their display labels
 * ("People Management" ⟺ "people-management", "CI/CD" ⟺ "ci-cd"). ALIAS
 * resolution ("postgres" → "postgresql") is jd-match's job and is deliberately
 * NOT duplicated here — a caller holding free-text résumé skills should run
 * them through `getSkillIndex()` first. Keeping that out is also what lets this
 * module stay free of a runtime import of jd-match's dictionary; the id/`SKILLS`
 * join is asserted in the test instead of paid for in the bundle.
 *
 * TIE-BREAK CONTRACT: ties break on `ROLE_PROFILES` declaration order — the
 * same contract `ROLE_FAMILIES` carries. Both resolvers are TOTAL (never throw,
 * never yield an `undefined` member) and return `[]` rather than a fabricated
 * match for input they cannot resolve.
 *
 * Curation: hand-written on 2026-07-25 from common software job-title
 * phrasings. Staleness is tolerable in the same way `ROLE_KEYWORDS`' is — a
 * missing surface form narrows an answer, it never makes one wrong.
 */

import type { RoleFamily } from "./role-keywords.ts";
import { SENIORITY_LADDER } from "./seniority.ts";

/**
 * Version of the profile table + resolution rules. Bump when a change can move
 * what `resolveProfilesByTitles` / `resolveProfilesBySkills` return for the
 * same input — a table edit, a weight change, or a normalizer change.
 *
 * Changelog:
 * - 1.0 (2026-07-25): initial table (#582) — leadership ladder + one profile
 *   per existing role family.
 */
export const ROLE_PROFILES_VERSION = "1.0";

/** One curated role: the titles it is called by and the skills it is described with. */
export interface RoleProfile {
  /** Stable kebab id, e.g. "engineering-manager". */
  readonly id: string;
  /** Human display name. */
  readonly label: string;
  /** Role family this profile rolls up to — reuses the existing taxonomy so
   *  the two assets stay reconcilable rather than competing. */
  readonly family: RoleFamily;
  /** Seniority rungs this profile normally spans (see seniority.ts). */
  readonly rungs: readonly number[];
  /** Title surface forms, most-used first. The head of this list is what we
   *  can honestly call "the common title for this role". */
  readonly titles: readonly string[];
  /** Canonical skill IDs (keys into jd-match SKILLS) this role is normally
   *  described with, most-expected first. */
  readonly skills: readonly string[];
}

// ── Rung spans ──────────────────────────────────────────────────────────────
// Named against `SENIORITY_LADDER` rather than written as bare integers, so a
// future re-tune of the ladder moves these with it instead of silently
// desynchronising. Manager and Principal share rung 6 by design (see
// seniority.ts); never list both in one span.

const IC_RUNGS: readonly number[] = [
  SENIORITY_LADDER.Junior,
  SENIORITY_LADDER.Mid,
  SENIORITY_LADDER.Senior,
  SENIORITY_LADDER.Lead,
  SENIORITY_LADDER.Staff,
  SENIORITY_LADDER.Principal,
];
const MANAGER_RUNGS: readonly number[] = [SENIORITY_LADDER.Manager];
const SENIOR_MANAGER_RUNGS: readonly number[] = [
  SENIORITY_LADDER.Manager,
  SENIORITY_LADDER.Director,
];
const DIRECTOR_RUNGS: readonly number[] = [SENIORITY_LADDER.Director];
const HEAD_RUNGS: readonly number[] = [SENIORITY_LADDER.Director, SENIORITY_LADDER.VP];
const VP_RUNGS: readonly number[] = [SENIORITY_LADDER.VP];
const EXECUTIVE_RUNGS: readonly number[] = [SENIORITY_LADDER.Executive];
const PROGRAM_RUNGS: readonly number[] = [
  SENIORITY_LADDER.Senior,
  SENIORITY_LADDER.Lead,
  SENIORITY_LADDER.Staff,
];

/**
 * The curated table — the SINGLE SOURCE OF TRUTH for "what is this role called
 * and what is it described with". DECLARATION ORDER IS THE DETERMINISTIC
 * TIE-BREAK for both resolvers (same contract as `ROLE_FAMILIES`), so entries
 * are ordered by `ROLE_FAMILIES` and, within a family, most-common role first.
 *
 * Depth is deliberately uneven. The leadership ladder is the gap this asset was
 * built to close and carries full title + competency lists; the pre-existing IC
 * families carry one profile each, thinner — the goal there is that a lookup
 * never silently falls through for a résumé that already works, not parity of
 * depth. The non-engineering families (sales / marketing / support) have the
 * thinnest `skills` because jd-match `SKILLS` is itself engineering-shaped;
 * that is a known limitation of the source dictionary, not an omission here.
 */
export const ROLE_PROFILES: readonly RoleProfile[] = [
  {
    id: "frontend-engineer",
    label: "Frontend Engineer",
    family: "frontend",
    rungs: IC_RUNGS,
    titles: [
      "frontend engineer",
      "frontend developer",
      "ui engineer",
      "web developer",
      "javascript engineer",
      "react developer",
    ],
    skills: [
      "javascript",
      "typescript",
      "react",
      "css",
      "html",
      "next.js",
      "redux",
      "tailwind",
      "webpack",
      "jest",
    ],
  },
  {
    id: "backend-engineer",
    label: "Backend Engineer",
    family: "backend",
    rungs: IC_RUNGS,
    titles: [
      "backend engineer",
      "backend developer",
      "api engineer",
      "server side engineer",
      "distributed systems engineer",
    ],
    skills: [
      "java",
      "python",
      "go",
      "postgresql",
      "rest",
      "microservices",
      "redis",
      "kafka",
      "grpc",
      "docker",
    ],
  },
  {
    id: "fullstack-engineer",
    label: "Full-Stack Engineer",
    family: "fullstack",
    rungs: IC_RUNGS,
    titles: ["fullstack engineer", "fullstack developer", "fullstack software engineer"],
    skills: [
      "typescript",
      "react",
      "node.js",
      "postgresql",
      "rest",
      "javascript",
      "graphql",
      "aws",
      "docker",
      "next.js",
    ],
  },
  {
    // The generic-title catch-all. "Software Engineer" names no specialism, so
    // it rolls up to `fullstack` as the least-wrong family — the taxonomy has
    // no "other" member by design (see ROLE_FAMILIES). It is the broadest
    // entry in the table, so it is declared AFTER `fullstack-engineer`: a
    // résumé reading "Full Stack Software Engineer" matches both, and the
    // specific profile must win — by specificity first, and by the
    // declaration-order tie-break if a future edit ever levels the scores.
    id: "software-engineer",
    label: "Software Engineer",
    family: "fullstack",
    rungs: IC_RUNGS,
    titles: ["software engineer", "software developer", "application developer"],
    skills: ["python", "java", "javascript", "typescript", "sql", "git", "rest", "docker"],
  },
  {
    id: "mobile-engineer",
    label: "Mobile Engineer",
    family: "mobile",
    rungs: IC_RUNGS,
    titles: [
      "mobile engineer",
      "ios engineer",
      "android engineer",
      "ios developer",
      "android developer",
      "mobile developer",
    ],
    skills: [
      "swift",
      "kotlin",
      "ios",
      "android",
      "react-native",
      "flutter",
      "xcode",
      "dart",
      "objective-c",
      "java",
    ],
  },
  {
    id: "data-engineer",
    label: "Data Engineer",
    family: "data",
    rungs: IC_RUNGS,
    titles: [
      "data engineer",
      "analytics engineer",
      "data analyst",
      "data platform engineer",
      "business intelligence engineer",
    ],
    skills: [
      "sql",
      "python",
      "spark",
      "airflow",
      "dbt",
      "snowflake",
      "etl",
      "bigquery",
      "data-warehouse",
      "tableau",
    ],
  },
  {
    id: "machine-learning-engineer",
    label: "Machine Learning Engineer",
    family: "ml",
    rungs: IC_RUNGS,
    titles: [
      "machine learning engineer",
      "ml engineer",
      "data scientist",
      "applied scientist",
      "research scientist",
      "ai engineer",
    ],
    skills: [
      "python",
      "machine-learning",
      "pytorch",
      "tensorflow",
      "deep-learning",
      "scikit-learn",
      "pandas",
      "numpy",
      "nlp",
      "llm",
    ],
  },
  {
    id: "site-reliability-engineer",
    label: "Site Reliability Engineer",
    family: "sre-devops",
    rungs: IC_RUNGS,
    titles: [
      "site reliability engineer",
      "devops engineer",
      "platform engineer",
      "infrastructure engineer",
      "cloud engineer",
      "production engineer",
    ],
    skills: [
      "kubernetes",
      "terraform",
      "aws",
      "docker",
      "linux",
      "ci-cd",
      "prometheus",
      "grafana",
      "ansible",
      "bash",
    ],
  },
  {
    id: "security-engineer",
    label: "Security Engineer",
    family: "security",
    rungs: IC_RUNGS,
    titles: [
      "security engineer",
      "application security engineer",
      "security analyst",
      "security architect",
      "penetration tester",
    ],
    skills: ["oauth", "jwt", "saml", "sso", "soc2", "gdpr", "hipaa", "linux", "python", "aws"],
  },
  {
    id: "qa-engineer",
    label: "QA Engineer",
    family: "qa",
    rungs: IC_RUNGS,
    titles: [
      "qa engineer",
      "quality assurance engineer",
      "test engineer",
      "automation engineer",
      "quality engineer",
    ],
    skills: [
      "selenium",
      "cypress",
      "playwright",
      "pytest",
      "jest",
      "junit",
      "tdd",
      "ci-cd",
      "python",
      "jira",
    ],
  },
  // ── The leadership ladder — the gap this asset was built to close ──────────
  {
    id: "engineering-manager",
    label: "Engineering Manager",
    family: "eng-leadership",
    rungs: MANAGER_RUNGS,
    titles: [
      "engineering manager",
      "software engineering manager",
      // Disambiguated on purpose: bare "development manager" tokenizes to
      // {development, manager}, a SUBSET of "Business Development Manager"'s
      // {business, development, manager}, so the subset rule resolved a
      // sales/GTM résumé to this engineering profile. Same reasoning that keeps
      // bare "tech lead" out of ROLE_KEYWORDS["eng-leadership"].
      "software development manager",
      "engineering team lead",
      "technical lead manager",
      "engineering lead",
    ],
    skills: [
      "people-management",
      "performance-management",
      "coaching-mentorship",
      "project-delivery",
      "team-building",
      "agile-leadership",
      "technical-recruiting",
      "career-development",
      "stakeholder-management",
      "on-call-ownership",
    ],
  },
  {
    id: "senior-engineering-manager",
    label: "Senior Engineering Manager",
    family: "eng-leadership",
    rungs: SENIOR_MANAGER_RUNGS,
    titles: [
      "senior engineering manager",
      "group engineering manager",
      "senior software engineering manager",
      "manager of managers",
    ],
    skills: [
      "people-management",
      "org-design",
      "performance-management",
      "technical-recruiting",
      "budget-headcount-planning",
      "roadmap-ownership",
      "stakeholder-management",
      "incident-management",
      "career-development",
      "cross-functional-collaboration",
    ],
  },
  {
    id: "director-of-engineering",
    label: "Director of Engineering",
    family: "eng-leadership",
    rungs: DIRECTOR_RUNGS,
    titles: [
      "director of engineering",
      "engineering director",
      "senior director of engineering",
      "director of software engineering",
    ],
    skills: [
      "org-design",
      "technical-strategy",
      "budget-headcount-planning",
      "people-management",
      "executive-communication",
      "stakeholder-management",
      "program-management",
      "roadmap-ownership",
      "vendor-management",
      "performance-management",
    ],
  },
  {
    id: "head-of-engineering",
    label: "Head of Engineering",
    family: "eng-leadership",
    rungs: HEAD_RUNGS,
    titles: ["head of engineering", "head of technology", "head of software engineering"],
    skills: [
      "technical-strategy",
      "org-design",
      "people-management",
      "budget-headcount-planning",
      "executive-communication",
      "platform-ownership",
      "stakeholder-management",
      "technical-recruiting",
      "vendor-management",
      "roadmap-ownership",
    ],
  },
  {
    id: "vp-engineering",
    label: "VP of Engineering",
    family: "eng-leadership",
    rungs: VP_RUNGS,
    titles: ["vp of engineering", "vp engineering", "vice president of engineering"],
    skills: [
      "org-design",
      "technical-strategy",
      "budget-headcount-planning",
      "executive-communication",
      "people-management",
      "stakeholder-management",
      "vendor-management",
      "program-management",
      "pnl-ownership",
      "technical-recruiting",
    ],
  },
  {
    id: "cto",
    label: "CTO",
    family: "eng-leadership",
    rungs: EXECUTIVE_RUNGS,
    titles: ["cto", "chief technology officer", "chief technical officer"],
    skills: [
      "technical-strategy",
      "org-design",
      "executive-communication",
      "architecture-review",
      "budget-headcount-planning",
      "platform-ownership",
      "vendor-management",
      "pnl-ownership",
      "stakeholder-management",
      "people-management",
    ],
  },
  {
    // Rolled up to `eng-leadership` rather than a business family, which the
    // taxonomy does not have. A technical founder's résumé is read by the same
    // consumers as a CTO's; inventing a family here would fork ROLE_FAMILIES.
    id: "founder-ceo",
    label: "Founder / CEO",
    family: "eng-leadership",
    rungs: EXECUTIVE_RUNGS,
    titles: ["founder", "co founder", "ceo", "chief executive officer"],
    skills: [
      "pnl-ownership",
      "executive-communication",
      "technical-strategy",
      "budget-headcount-planning",
      "org-design",
      "technical-recruiting",
      "vendor-management",
      "stakeholder-management",
      "people-management",
      "roadmap-ownership",
    ],
  },
  {
    // The site/regional-lead shape — the "Berlin Site Lead" case that motivated
    // the term-quality work. The geography rides in the résumé title as an
    // extra token, which the subset rule tolerates by design.
    id: "site-lead",
    label: "Site Lead",
    family: "eng-leadership",
    rungs: SENIOR_MANAGER_RUNGS,
    titles: ["site lead", "site director", "engineering site lead", "regional engineering manager"],
    skills: [
      "people-management",
      "stakeholder-management",
      "cross-functional-collaboration",
      "team-building",
      "technical-recruiting",
      "org-design",
      "program-management",
      "executive-communication",
    ],
  },
  {
    id: "product-designer",
    label: "Product Designer",
    family: "design",
    rungs: IC_RUNGS,
    titles: [
      "product designer",
      "ux designer",
      "ui designer",
      "ux researcher",
      "interaction designer",
      "visual designer",
      "design lead",
    ],
    skills: [
      "figma",
      "sketch",
      "user-research",
      "a-b-testing",
      "storybook",
      "css",
      "html",
      "product-management",
    ],
  },
  {
    id: "product-manager",
    label: "Product Manager",
    family: "pm",
    rungs: IC_RUNGS,
    titles: [
      "product manager",
      "senior product manager",
      "group product manager",
      "technical product manager",
      "product owner",
    ],
    skills: [
      "product-management",
      "user-research",
      "a-b-testing",
      "okrs",
      "roadmap-ownership",
      "stakeholder-management",
      "agile",
      "scrum",
      "jira",
      "sql",
    ],
  },
  {
    // Part of the leadership ladder the issue asks for, but its family is `pm`,
    // not `eng-leadership` — a TPM leads programs, not an engineering org.
    id: "technical-program-manager",
    label: "Technical Program Manager",
    family: "pm",
    rungs: PROGRAM_RUNGS,
    titles: [
      "technical program manager",
      "program manager",
      "senior technical program manager",
      "project manager",
    ],
    skills: [
      "program-management",
      "project-delivery",
      "cross-functional-collaboration",
      "stakeholder-management",
      "roadmap-ownership",
      "agile-leadership",
      "executive-communication",
      "incident-management",
      "technical-writing",
      "jira",
    ],
  },
  {
    id: "account-executive",
    label: "Account Executive",
    family: "sales",
    rungs: IC_RUNGS,
    titles: [
      "account executive",
      "sales engineer",
      "account manager",
      "sales development representative",
      "business development manager",
      "solutions engineer",
    ],
    skills: [
      "stakeholder-management",
      "executive-communication",
      "cross-functional-collaboration",
      "vendor-management",
      "sql",
    ],
  },
  {
    id: "marketing-manager",
    label: "Marketing Manager",
    family: "marketing",
    rungs: IC_RUNGS,
    titles: [
      "marketing manager",
      "product marketing manager",
      "growth marketing manager",
      "content marketing manager",
      "demand generation manager",
      "brand manager",
    ],
    skills: [
      "a-b-testing",
      "user-research",
      "executive-communication",
      "cross-functional-collaboration",
      "technical-writing",
      "figma",
    ],
  },
  {
    id: "support-engineer",
    label: "Support Engineer",
    family: "support",
    rungs: IC_RUNGS,
    titles: [
      "support engineer",
      "technical support engineer",
      "customer success manager",
      "customer support specialist",
    ],
    skills: [
      "technical-writing",
      "incident-management",
      "stakeholder-management",
      "cross-functional-collaboration",
      "sql",
      "linux",
      "jira",
    ],
  },
];

// ── Title normalisation ─────────────────────────────────────────────────────

/**
 * Whole-phrase folds applied to a space-normalised title BEFORE tokenising, so
 * both sides of a comparison collapse to the same surface form. Applied in
 * declaration order with multi-word phrases first; NO replacement's output is
 * itself a key of a later rule, so the pass is single-shot and cannot cascade
 * or loop — a property to preserve when adding an entry.
 *
 * Deliberately absent: "pm" (product manager? program manager? — ambiguous) and
 * "em"/"dev" (too short / too collision-prone). An ambiguous fold is worse than
 * a missing one, because it fabricates a match rather than narrowing one.
 */
const TITLE_ABBREVIATIONS: readonly (readonly [string, string])[] = [
  ["chief technology officer", "cto"],
  ["chief technical officer", "cto"],
  ["chief executive officer", "ceo"],
  ["vice president", "vp"],
  ["front end", "frontend"],
  ["back end", "backend"],
  ["full stack", "fullstack"],
  ["tpm", "technical program manager"],
  ["sre", "site reliability engineer"],
  ["swe", "software engineer"],
  ["svp", "vp"],
  ["evp", "vp"],
  ["sr", "senior"],
  ["jr", "junior"],
  ["mgr", "manager"],
  ["dir", "director"],
  ["eng", "engineering"],
];

/** Precompiled whole-word matchers for `TITLE_ABBREVIATIONS`, built once. */
const ABBREVIATION_PATTERNS: readonly (readonly [RegExp, string])[] =
  TITLE_ABBREVIATIONS.map(
    ([from, to]) => [new RegExp(`\\b${from}\\b`, "g"), to] as const,
  );

/**
 * Tokens carrying no role signal, dropped after the abbreviation fold so
 * "head of engineering" and "head engineering" are the same set. Kept short on
 * purpose: every word removed here is a word the subset rule can no longer use
 * to tell two roles apart.
 */
const TITLE_STOP_WORDS: ReadonlySet<string> = new Set([
  "a",
  "an",
  "and",
  "at",
  "for",
  "in",
  "of",
  "on",
  "or",
  "the",
  "to",
  "with",
]);

/**
 * Total, deterministic title → token set. Lowercases, replaces every
 * non-alphanumeric run with a space (so "Sr.", "Front-End" and "Design/UX" all
 * split cleanly), folds `TITLE_ABBREVIATIONS`, then drops stop words. Never
 * throws: any input is coerced with `String()` first, and an empty or
 * all-stop-word title yields an empty set (which matches nothing, rather than
 * everything).
 */
function profileTitleTokens(raw: string): ReadonlySet<string> {
  let text = String(raw)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  for (const [pattern, replacement] of ABBREVIATION_PATTERNS) {
    text = text.replace(pattern, replacement);
  }
  const tokens = new Set<string>();
  for (const token of text.split(" ")) {
    if (token.length === 0) continue;
    if (TITLE_STOP_WORDS.has(token)) continue;
    tokens.add(token);
  }
  return tokens;
}

/**
 * Canonical comparison key for a skill id or its display label: lowercased with
 * every separator removed, so "People Management", "people-management" and
 * "people management" collide, and "CI/CD" meets "ci-cd". Total.
 */
function normalizeSkillKey(raw: string): string {
  return String(raw).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

// ── Scoring weights ─────────────────────────────────────────────────────────
// Integers throughout: a resolver whose ordering depends on float accumulation
// is not reproducibly deterministic, and these results feed user-visible copy.

/** Points a profile earns per résumé title that matches any of its titles. */
const TITLE_MATCH_POINTS = 100;
/** Points per token of the matched profile title — prefers the specific entry
 *  ("senior engineering manager") over the general one ("engineering manager")
 *  when a résumé title matches both. */
const TITLE_SPECIFICITY_POINTS = 10;
/** How deep into a profile's `titles` list the "this is the common form of the
 *  name" nudge reaches. Small enough to only break otherwise-exact ties. */
const TITLE_PREVALENCE_DEPTH = 3;

/** Points per expected skill present in the input. */
const SKILL_MATCH_POINTS = 10;
/** How deep into a profile's `skills` list the most-expected-first nudge
 *  reaches; entry i earns `max(0, DEPTH - i)` on top of the flat match points. */
const SKILL_PREVALENCE_DEPTH = 5;
/**
 * Skills a profile needs before it is reported at all. One shared skill is a
 * coincidence — "python" alone implies five roles — so a single hit is treated
 * as no signal and the resolver returns `[]` rather than a fabricated match.
 */
const MIN_SKILL_MATCHES = 2;

/**
 * Upper bound on how many profiles either resolver returns. Both sort
 * most-confident-first, so this trims a noisy tail without touching the head
 * the callers actually read.
 */
const MAX_RESOLVED_PROFILES = 5;

/** A profile's index in `ROLE_PROFILES` — the declaration-order tie-break key. */
const PROFILE_ORDER: ReadonlyMap<string, number> = new Map(
  ROLE_PROFILES.map((profile, index) => [profile.id, index]),
);

/** Per-profile token sets for every title, built once on first resolve. */
let titleIndex: readonly (readonly ReadonlySet<string>[])[] | undefined;

function getTitleIndex(): readonly (readonly ReadonlySet<string>[])[] {
  titleIndex ??= ROLE_PROFILES.map((profile) => profile.titles.map(profileTitleTokens));
  return titleIndex;
}

/** Per-profile normalised skill keys, in `skills` order, built once. */
let skillIndex: readonly (readonly string[])[] | undefined;

function getSkillKeyIndex(): readonly (readonly string[])[] {
  skillIndex ??= ROLE_PROFILES.map((profile) => profile.skills.map(normalizeSkillKey));
  return skillIndex;
}

/** True when every token of `needle` is present in `haystack`. */
function isSubset(needle: ReadonlySet<string>, haystack: ReadonlySet<string>): boolean {
  if (needle.size === 0 || needle.size > haystack.size) return false;
  for (const token of needle) {
    if (!haystack.has(token)) return false;
  }
  return true;
}

/** Sort scored entries by score desc, then declaration order asc, then cap. */
function topProfiles(scores: ReadonlyMap<string, number>): RoleProfile[] {
  return ROLE_PROFILES.filter((profile) => (scores.get(profile.id) ?? 0) > 0)
    .sort(
      (a, b) =>
        (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0) ||
        (PROFILE_ORDER.get(a.id) ?? 0) - (PROFILE_ORDER.get(b.id) ?? 0),
    )
    .slice(0, MAX_RESOLVED_PROFILES);
}

/**
 * Best-matching profiles for a set of résumé titles, most confident first.
 * Empty when nothing matches — callers must handle "unknown role" without
 * fabricating one.
 *
 * Asks ONLY the title question; it never reads skills and is never implemented
 * in terms of `resolveProfilesBySkills` (see the module docblock — comparing
 * the two independent answers is the point).
 *
 * A profile scores `TITLE_MATCH_POINTS` for each résumé title that matches ANY
 * of its titles, plus the specificity and prevalence nudges of the single best
 * matching entry for that title. Repeated résumé titles are counted repeatedly
 * on purpose: three "Engineering Manager" roles are stronger evidence than one.
 * Blank and unparseable entries are skipped; the function never throws.
 */
export function resolveProfilesByTitles(titles: readonly string[]): RoleProfile[] {
  const index = getTitleIndex();
  const scores = new Map<string, number>();

  for (const rawTitle of titles ?? []) {
    if (!rawTitle) continue;
    const resumeTokens = profileTitleTokens(rawTitle);
    if (resumeTokens.size === 0) continue;

    ROLE_PROFILES.forEach((profile, profileIdx) => {
      let best = 0;
      index[profileIdx].forEach((profileTokens, titleIdx) => {
        if (!isSubset(profileTokens, resumeTokens)) return;
        const prevalence = Math.max(0, TITLE_PREVALENCE_DEPTH - titleIdx);
        const points =
          TITLE_MATCH_POINTS + profileTokens.size * TITLE_SPECIFICITY_POINTS + prevalence;
        if (points > best) best = points;
      });
      if (best > 0) scores.set(profile.id, (scores.get(profile.id) ?? 0) + best);
    });
  }

  return topProfiles(scores);
}

/**
 * Best-matching profiles implied by a set of skills, most confident first.
 * Deliberately a SEPARATE entry point from the title resolver: comparing the
 * two answers is how the title/skill mismatch check works.
 *
 * Input is matched against canonical jd-match `SKILLS` ids, compared case- and
 * separator-insensitively — pass ids or their display labels. Free-text résumé
 * skills that are ALIASES ("postgres", "k8s") do not resolve here by design;
 * run them through jd-match's `getSkillIndex()` first (module docblock).
 *
 * A profile needs `MIN_SKILL_MATCHES` hits to be reported at all, so a single
 * shared tool never fabricates a role. Duplicate inputs are deduped before
 * scoring — unlike titles, repeating a skill is a listing artefact, not
 * evidence. Empty when nothing clears the floor; never throws.
 */
export function resolveProfilesBySkills(skills: readonly string[]): RoleProfile[] {
  const present = new Set<string>();
  for (const rawSkill of skills ?? []) {
    if (!rawSkill) continue;
    const key = normalizeSkillKey(rawSkill);
    if (key.length > 0) present.add(key);
  }
  if (present.size === 0) return [];

  const index = getSkillKeyIndex();
  const scores = new Map<string, number>();

  ROLE_PROFILES.forEach((profile, profileIdx) => {
    let matches = 0;
    let points = 0;
    index[profileIdx].forEach((skillKey, skillIdx) => {
      if (!present.has(skillKey)) return;
      matches += 1;
      points += SKILL_MATCH_POINTS + Math.max(0, SKILL_PREVALENCE_DEPTH - skillIdx);
    });
    if (matches >= MIN_SKILL_MATCHES) scores.set(profile.id, points);
  });

  return topProfiles(scores);
}

/** The profile with this id, or `undefined`. Total; no throwing lookup. */
export function roleProfileById(id: string): RoleProfile | undefined {
  const index = PROFILE_ORDER.get(String(id));
  return index === undefined ? undefined : ROLE_PROFILES[index];
}
