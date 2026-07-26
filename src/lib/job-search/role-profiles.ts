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
 * honestly call "a common title for this role" — measured where the sample
 * supports it, curated otherwise. Merging the two would break
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
 *
 * ORDERING IS MEASURED WHERE IT CAN BE, MEMBERSHIP IS CURATED (#588). The two
 * docstrings above — "most-used first", "most-expected first" — used to be one
 * person's judgement of what the market says. Where the evidence supports it
 * they are now backed by counts mined from real postings and baked into
 * `prevalence-snapshot.ts`: `applyPrevalenceOrder` re-sorts a profile's `titles`
 * and `skills` by observed frequency, and `ROLE_PROFILES` is that reordering of
 * `CURATED_ROLE_PROFILES`. The split of authority is strict and
 * one-directional — the snapshot may only REORDER what curation admitted. A
 * snapshot term with no curated counterpart is dropped, so a junk title form
 * trending in some feed can never write itself into a profile.
 *
 * IT IS A MINORITY OF THE TABLE. The two axes are gated separately and most
 * profiles clear neither, keeping their curated order verbatim; read each
 * snapshot entry's `audit` to see which way a given profile went and why. And
 * the corpus is not "the market": it is what a handful of keyless remote-jobs
 * aggregators answered on one dated run, with one of them supplying the large
 * majority of postings (the snapshot header names it and its share). Remote-first
 * aggregators over-represent remote-friendly, English-language, often
 * smaller-company listings. Treat a ranked ordering as "what these feeds said",
 * which is still strictly more than the previous "what one curator assumed", and
 * not as a market-wide measurement.
 *
 * NO NEW EGRESS. This module still fetches nothing: the snapshot is a static
 * committed module, not a runtime call to a prevalence service (which would be a
 * brand-new egress path). The mining itself is offline and dev-only — the
 * harness is a `.test.ts` excluded from the production build, and it seeds its
 * feed queries from `CURATED_ROLE_PROFILES` below (the hand-written table, NOT
 * the reordered export — see that constant for why), so no résumé is anywhere in
 * that loop and `providers/keywords.ts` remains the sole résumé-derived egress
 * helper. Regenerate the snapshot with:
 *
 *   RL_MINE_PREVALENCE=1 npx vitest run src/lib/job-search/mine-prevalence.test.ts
 *
 * then copy `internal/job-search/prevalence-snapshot.generated.ts` over
 * `prevalence-snapshot.ts` and review the diff.
 */

import {
  PREVALENCE_SNAPSHOT,
  type PrevalenceEntry,
  type PrevalenceSnapshot,
  type ProfilePrevalence,
} from "./prevalence-snapshot.ts";
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
 * - 1.1 (2026-07-25): `titles` / `skills` ordering is prevalence-ranked from a
 *   mined snapshot (#588) for the profiles whose evidence clears the per-axis
 *   gates; the rest keep their curated order, and a ranked profile whose modal
 *   title only tied with its curated head keeps that head at position 0
 *   (`ranked-head-pinned`). Membership is unchanged, but both
 *   resolvers' prevalence nudges read position, so a tie can now break
 *   differently — and downstream `term-quality.ts` head-caps `missing` at
 *   `MAX_MISSING_TITLES` / `MAX_MISSING_SKILLS`, so the advice that ships
 *   selects different terms. This version covers the MECHANISM; regenerating
 *   the snapshot changes the data under it without changing these rules, which
 *   is why `term-quality.ts` does not bump on a mining run — an answer for a
 *   given query is a function of both this version and
 *   `PREVALENCE_SNAPSHOT.generatedAt`.
 */
export const ROLE_PROFILES_VERSION = "1.1";

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
  /** Title surface forms, most-used first. The head of this list is what we can
   *  honestly call "a common title for this role" — measured where the sample
   *  supports it (#588), curated otherwise; never "the" one, and never a term
   *  the observations only tied with. */
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
 * The curated table — the SINGLE SOURCE OF TRUTH for MEMBERSHIP: "what is this
 * role called and what is it described with". DECLARATION ORDER IS THE
 * DETERMINISTIC TIE-BREAK for both resolvers (same contract as `ROLE_FAMILIES`),
 * so entries are ordered by `ROLE_FAMILIES` and, within a family, most-common
 * role first.
 *
 * EXPORTED FOR THE MINING HARNESS ONLY, and consumers must not read it. The
 * table the lane reads is `ROLE_PROFILES`, this one passed through
 * `applyPrevalenceOrder`; two consumer-facing tables that agree on membership
 * and disagree on order is exactly the drift #588's single-table rule exists to
 * prevent. The harness is the one legitimate reader, because it must SEED its
 * feed queries from an order that does not depend on the snapshot it is about to
 * overwrite — seeding from `ROLE_PROFILES` makes the corpus a function of the
 * previous run, so a title that fell to the tail is never queried again and is
 * pinned there permanently. Seeding here is snapshot-independent by construction.
 *
 * WITHIN a profile, the order of `titles` / `skills` here is the order that
 * SHIPS for every profile the snapshot could not rank — which, on the committed
 * run, is most of them. Write them most-plausible-first and treat that as the
 * answer, not as a placeholder.
 *
 * The mining can also be WRONG about a profile rather than merely thin, and the
 * curator needs to be able to tell the two apart. The failure mode is bucket
 * contamination: `resolveProfilesByTitles` routes each posting to exactly one
 * profile, so a neighbouring role whose market name is a curated title here
 * arrives in this profile's bucket and its counts redefine the role.
 * `MIN_CURATED_HEAD_TITLE_SHARE` refuses the ranking when that happens, and the
 * snapshot's per-profile `audit` names the modal observed title and its share —
 * so a `bucket-not-this-role` verdict, or a modal title that is not the role,
 * is the signal that the curated MEMBERSHIP here is too wide, not that the
 * ordering needs another run.
 *
 * Depth is deliberately uneven. The leadership ladder is the gap this asset was
 * built to close and carries full title + competency lists; the pre-existing IC
 * families carry one profile each, thinner — the goal there is that a lookup
 * never silently falls through for a résumé that already works, not parity of
 * depth. The non-engineering families (sales / marketing / support) have the
 * thinnest `skills` because jd-match `SKILLS` is itself engineering-shaped;
 * that is a known limitation of the source dictionary, not an omission here.
 */
export const CURATED_ROLE_PROFILES: readonly RoleProfile[] = [
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
export function normalizeSkillKey(raw: string): string {
  return String(raw).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

// ── Prevalence ordering (#588) ──────────────────────────────────────────────

/**
 * THE TWO AXES ARE GATED SEPARATELY, and the reason is that they do not share
 * an evidence base. A posting joins the corpus on its TITLE, so every bucketed
 * posting is one observation of the title axis; but its skills come from its
 * DESCRIPTION, and a feed that returned a title with a stub description
 * contributes nothing to the skill axis at all. Gating both on the posting
 * count therefore authorises a skill ranking with the title axis's evidence —
 * which is how a profile with 37 postings but 5 skill observations came to
 * offer a single 4-count term as the head of its expected skills.
 *
 * So each axis clears its own floor, independently: a profile may have its
 * `titles` ranked while its `skills` stay curated, or the reverse.
 * `auditPrevalence` is the one place both decisions are made, and the harness
 * bakes its verdict into every snapshot entry so the split is legible in a diff
 * rather than reconstructible only by rerunning the code.
 */

/**
 * Postings a profile needs before its mined TITLE counts may reorder anything.
 *
 * A floor on *interpretability*, not a statistical result: ranking six title
 * forms off four postings is noise dressed as data, and the element at risk is
 * the head — the one element the product quotes as a common title for this
 * role. Twenty-five is the point where one unusual listing can no longer move
 * that head by itself.
 *
 * What it does NOT do, and what the sibling constants exist for: it says nothing
 * about whether the postings are of the right ROLE (see
 * `MIN_CURATED_HEAD_TITLE_SHARE`) and nothing about whether any of them carried
 * a readable description (see `MIN_PREVALENCE_SKILL_OBSERVATIONS`). On the run
 * that produced the committed snapshot only a minority of the table cleared it,
 * and most of the leadership ladder did not — that is the honest shape of a
 * corpus mined from remote-jobs aggregators, not a threshold to lower.
 */
export const MIN_PREVALENCE_SAMPLE = 25;

/**
 * Share of a profile's TITLE observations that must land on the profile's OWN
 * curated head title before a ranking is trusted, in the case where the modal
 * observed form is something else.
 *
 * This is the bucketing-concentration guard. `resolveProfilesByTitles` assigns
 * every posting to exactly one profile, so a neighbouring role whose market name
 * happens to be a curated title of this profile fills this profile's bucket —
 * and the counts then redefine the role. Raising `MIN_PREVALENCE_SAMPLE` cannot
 * help: the failure is a systematic majority, not an outlier.
 *
 * The distinction the number has to draw is "the market renamed this role"
 * versus "this bucket is mostly a different job". A rename leaves the curated
 * head a strong runner-up; a takeover leaves it a rounding error. One in five is
 * where those separate on the observed corpus, and it is not a knife edge —
 * nothing that clears `MIN_PREVALENCE_SAMPLE` lands between 12.5% and 27.5%:
 *
 * - `machine-learning-engineer` — modal "ai engineer" at 35%, own head
 *   "machine learning engineer" still 27.5%. A rename, not a takeover, so this
 *   guard passes it — `headFlipBeatsNoise` is what then decides whether the
 *   14-vs-11 lead is big enough to actually move the head.
 * - `technical-program-manager` — modal "project manager" at 47%, own head
 *   12.5%. Two neighbouring roles collapsed into one bucket. DECLINED.
 * - `support-engineer` — modal "customer success manager" at 84.8%, own head
 *   6.1%. A different job wearing this profile's id. DECLINED.
 *
 * The guard only applies when the modal form is NOT the curated head: a profile
 * whose own head leads its bucket needs no permission to sort the tail.
 */
export const MIN_CURATED_HEAD_TITLE_SHARE = 0.2;

/**
 * The other half of the same standard: the largest share a FOREIGN modal title
 * may hold before the bucket is refused outright, whatever the curated head's
 * own share is.
 *
 * `MIN_CURATED_HEAD_TITLE_SHARE` alone only floors the loser, and the docblock
 * above states a two-sided test it cannot actually run — "a rename leaves the
 * curated head a strong runner-up" is a claim about the RELATION between the two
 * forms. A bucket at head 21% / foreign modal 70% clears the floor and is
 * plainly not a runner-up story; it is a neighbouring role that brought a long
 * tail with it. Nothing in the committed snapshot is near this (`support-engineer`
 * at 84.8% is already refused on the head's 6.1%), but a regeneration can reach
 * it, and the failure is silent: the profile ranks and adopts the other role's
 * name as its head.
 *
 * The margin gate below does NOT subsume this. That gate asks whether the LEAD
 * is bigger than noise, and a dominant modal's lead is enormous — 70 vs 21 beats
 * its 9.5-observation noise floor many times over, so it would rank. The two
 * measure different things: one that the flip is real, this one that the bucket
 * is ours to flip.
 *
 * One half is the line because a majority is the point where the foreign form is
 * no longer competing with the curated head for the role's identity — it simply
 * IS the bucket's identity. Compared strictly, so an even split is not a
 * majority.
 */
export const MAX_FOREIGN_MODAL_TITLE_SHARE = 0.5;

/**
 * Skill observations a profile needs before its mined SKILL counts may reorder
 * anything. Counted over observations that join to a curated skill — the
 * evidence that actually drives the sort — not over postings.
 *
 * `MAX_MISSING_SKILLS` (5) of the ranked list becomes user-facing advice, so the
 * ranking must have resolution across at least five positions. Forty is eight
 * observations per surviving slot: enough that a slot is a pattern rather than a
 * coincidence, while still well inside what a profile with readable descriptions
 * supplies. On the committed run the technical profiles cleared it with room
 * (site-reliability-engineer 132, machine-learning-engineer 112,
 * software-engineer 94, data-engineer 60, product-manager 54) and the profiles
 * whose vocabulary the jd-match dictionary barely reads did not
 * (account-executive 10, marketing-manager 7). Nor did `engineering-manager`,
 * at 24, whose people-leadership vocabulary is exactly the gap jd-match's
 * engineering-shaped `SKILLS` has. Its curated order therefore ships, which is
 * the correct answer: a measured ranking off 24 observations of a six-skill
 * list would have replaced a considered order with a coin toss.
 */
export const MIN_PREVALENCE_SKILL_OBSERVATIONS = 40;

/**
 * Observations the most-observed curated skill must itself carry before the
 * SKILL ranking is trusted. Guards the shape a bare total cannot: forty
 * observations spread four-apiece across ten skills ranks nothing, it just
 * arranges ten coin flips, and the top of that arrangement is what ships as
 * advice. Ten is the point where a term is a repeated ask rather than one
 * unusual posting's vocabulary.
 */
export const MIN_PREVALENCE_SKILL_HEAD_COUNT = 10;

/**
 * Why the TITLE axis did or did not rank.
 *
 * `ranked-head-pinned` is a THIRD state, not a flavour of either: the tail was
 * prevalence-ordered but the curated head kept position 0 because the observed
 * lead over it was inside the noise (`headFlipBeatsNoise`). It exists as its own
 * verdict because #588's whole design is that every decision is legible in the
 * snapshot diff, and a head that was silently held in place is the one decision
 * a reader of that diff could not otherwise see.
 */
export type TitleAxisVerdict =
  | "ranked"
  | "ranked-head-pinned"
  | "thin-sample"
  | "bucket-not-this-role";
/** Why the SKILL axis did or did not rank. */
export type SkillAxisVerdict = "ranked" | "thin-observations";

/**
 * The per-axis decision plus the measurements it was made from. Baked into every
 * snapshot entry so a human reading the generated diff sees WHY a profile was
 * ranked or declined — and, in the `bucket-not-this-role` case, sees the modal
 * title that would otherwise have silently become the role's identity.
 */
export interface PrevalenceAudit {
  readonly titles: TitleAxisVerdict;
  readonly skills: SkillAxisVerdict;
  /** Postings that bucketed here. Denominator for nothing — see the shares. */
  readonly sampleSize: number;
  /** The profile's most-observed CURATED title (the snapshot's surface forms
   *  folded onto the terms they join to); `""` when nothing was observed. */
  readonly modalTitle: string;
  /** `modalTitle`'s share of all title observations, 0–1, 3dp. */
  readonly modalTitleShare: number;
  /** The profile's own curated HEAD title's share of the same, 0–1, 3dp. */
  readonly curatedHeadTitleShare: number;
  /** Observations joining a curated skill — the skill axis's real evidence. */
  readonly skillObservations: number;
  /** The largest single such observation count. */
  readonly skillHeadCount: number;
}

/**
 * Canonical comparison key for a title surface form: its `profileTitleTokens`
 * SET, order-normalised. Set equality is the right join here because it is the
 * same relation the title matcher works in — "Director of Engineering" and
 * "Engineering Director" are one form, so a snapshot naming either ranks the
 * curated entry regardless of which way round it was written.
 */
function titlePrevalenceKey(raw: string): string {
  return [...profileTitleTokens(raw)].sort().join(" ");
}

/**
 * Does the modal title's lead over the curated head EXCEED THE NOISE in the
 * split that produced it? Only asked when the two are different terms, and only
 * about position 0.
 *
 * WHAT IT GUARDS. The gates above floor the loser's share and the denominator;
 * neither floors the SEPARATION, so a head flip can ride on one posting. Thirty
 * observations split 8 (modal) to 7 (head) clears both, and the head — the term
 * the product turns into advice — changes hands on a coin toss. That is not a
 * measurement of which title is more common; it is a measurement that they are
 * comparably common, which is a different claim and not one that should reorder
 * anything.
 *
 * WHY `sqrt`, AND NOT A CHOSEN RATIO. Take the null hypothesis this has to rule
 * out: the two forms are equally prevalent and each of the `modal + head`
 * observations landed on one of them by a fair coin. The DIFFERENCE between the
 * two counts is then a symmetric random walk over that many steps, whose
 * standard deviation is exactly the square root of it. So `sqrt(modal + head)`
 * is not a tuned number at all — it is one sigma of the very hypothesis being
 * rejected, and it falls out of the counts rather than out of a judgement about
 * them. A fitted constant (`0.2` of the total, "at least 5 more") would carry
 * the objection that it was picked to make some particular case decline; this
 * cannot, because there was nothing to pick.
 *
 * Consequences, all intended: a one-posting lead never flips the head at any
 * sample size; a genuine rename at 30-vs-10 clears it comfortably (20 > 6.32);
 * and the bar scales with the evidence, so a bigger corpus buys a flip with a
 * proportionally smaller lead rather than a bigger one.
 *
 * ONE SIGMA, not two or three, and deliberately so: this is a tie-breaker
 * between two curated terms that both stay in the list either way, so the cost
 * of a wrong call is one position in an ordering, not a false claim. A stricter
 * bar would pin heads that the corpus really did move.
 */
function headFlipBeatsNoise(modalCount: number, headCount: number): boolean {
  return modalCount - headCount > Math.sqrt(modalCount + headCount);
}

/** Shares are stored, so they must round-trip a JSON bake exactly. */
function share(part: number, whole: number): number {
  return whole > 0 ? Math.round((part / whole) * 1000) / 1000 : 0;
}

/**
 * Snapshot counts folded onto the CURATED terms they join to, keyed by `keyOf`.
 * Entries with no curated counterpart are dropped here for the same reason
 * `rankByPrevalence` cannot use them: they are not evidence about this profile.
 * Keeping the two in step is what stops a gate being cleared by observations the
 * ranking then ignores.
 */
function joinToCurated(
  curated: readonly string[],
  entries: readonly PrevalenceEntry[] | undefined,
  keyOf: (raw: string) => string,
): Map<string, number> {
  const wanted = new Set(curated.map(keyOf));
  const counts = new Map<string, number>();
  for (const entry of entries ?? []) {
    const key = keyOf(entry.form);
    if (key.length === 0 || !wanted.has(key)) continue;
    counts.set(key, (counts.get(key) ?? 0) + entry.count);
  }
  return counts;
}

/**
 * Decide both axes for one profile against its snapshot entry, and report the
 * numbers behind the decision. Pure and total: an absent, empty or degenerate
 * entry yields a fully-declined audit rather than throwing.
 *
 * `profile` must be the CURATED profile — the guard reads `titles[0]` as the
 * role's declared identity, and reading it off an already-reordered table would
 * make the guard agree with whatever the last run produced.
 */
export function auditPrevalence(
  profile: RoleProfile,
  // Structurally typed, not `ProfilePrevalence`: the harness calls this while
  // BUILDING an entry, before the `audit` field it is about to compute exists.
  mined: Omit<ProfilePrevalence, "audit"> | undefined,
): PrevalenceAudit {
  // Aggregated by KEY, not per entry, so the audit measures exactly what
  // `rankByPrevalence` sorts on — two entries that normalise to one curated term
  // are one term's evidence in both places.
  const titleCounts = joinToCurated(profile.titles, mined?.titles, titlePrevalenceKey);
  const titleTotal = [...titleCounts.values()].reduce((a, b) => a + b, 0);
  const headKey = titlePrevalenceKey(profile.titles[0] ?? "");
  const headCount = titleCounts.get(headKey) ?? 0;
  let modalTitle = "";
  let modalCount = 0;
  for (const term of profile.titles) {
    const count = titleCounts.get(titlePrevalenceKey(term)) ?? 0;
    if (count > modalCount) {
      modalCount = count;
      modalTitle = term;
    }
  }

  const skillCounts = joinToCurated(profile.skills, mined?.skills, normalizeSkillKey);
  const skillObservations = [...skillCounts.values()].reduce((a, b) => a + b, 0);
  const skillHeadCount = Math.max(0, ...skillCounts.values());

  const sampleSize = mined?.sampleSize ?? 0;
  const curatedHeadTitleShare = share(headCount, titleTotal);
  const modalTitleShare = share(modalCount, titleTotal);
  const modalIsCuratedHead =
    modalTitle.length > 0 && titlePrevalenceKey(modalTitle) === headKey;

  // Three questions in order of how much they disqualify: is there enough
  // evidence at all, is this bucket even this role, and only then — is the one
  // position the product quotes actually changing hands, or is it a coin toss?
  let titles: TitleAxisVerdict;
  if (sampleSize < MIN_PREVALENCE_SAMPLE) {
    titles = "thin-sample";
  } else if (
    !modalIsCuratedHead &&
    (curatedHeadTitleShare < MIN_CURATED_HEAD_TITLE_SHARE ||
      modalTitleShare > MAX_FOREIGN_MODAL_TITLE_SHARE)
  ) {
    titles = "bucket-not-this-role";
  } else if (!modalIsCuratedHead && !headFlipBeatsNoise(modalCount, headCount)) {
    titles = "ranked-head-pinned";
  } else {
    titles = "ranked";
  }

  const skills: SkillAxisVerdict =
    skillObservations >= MIN_PREVALENCE_SKILL_OBSERVATIONS &&
    skillHeadCount >= MIN_PREVALENCE_SKILL_HEAD_COUNT
      ? "ranked"
      : "thin-observations";

  return {
    titles,
    skills,
    sampleSize,
    modalTitle,
    modalTitleShare,
    curatedHeadTitleShare,
    skillObservations,
    skillHeadCount,
  };
}

/**
 * Re-sort `curated` by the counts in `entries`, most-observed first.
 *
 * THE MEMBERSHIP GUARD RAIL LIVES HERE and is structural rather than checked:
 * the output is built by sorting `curated` itself, and `entries` is only ever
 * read through a lookup keyed off a curated term. A snapshot entry with no
 * curated counterpart therefore has nothing to attach to and cannot appear in
 * the result — there is no code path that appends. Curated terms the snapshot
 * never observed score 0 and keep their relative curated order at the tail,
 * because the sort is stable via the index tie-break (`Array.sort` is spec-
 * stable since ES2019; the explicit index compare states the contract rather
 * than relying on it).
 *
 * A ZERO IS NOT A MEASUREMENT OF ABSENCE. A curated skill scores 0 both when
 * postings genuinely never ask for it and when jd-match's alias regex simply
 * cannot see the phrasing they asked for it with — the mining reads descriptions
 * through that dictionary and inherits its blind spots. The sort treats the two
 * identically, so an unobserved term sinking to the tail is weak evidence, which
 * is tolerable only because sinking to the tail is all it does: membership is
 * curated and nothing here can drop a term.
 */
function rankByPrevalence(
  curated: readonly string[],
  entries: readonly PrevalenceEntry[],
  keyOf: (raw: string) => string,
): readonly string[] {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    const key = keyOf(entry.form);
    if (key.length === 0) continue;
    counts.set(key, (counts.get(key) ?? 0) + entry.count);
  }
  return curated
    .map((term, index) => ({ term, index, count: counts.get(keyOf(term)) ?? 0 }))
    .sort((a, b) => b.count - a.count || a.index - b.index)
    .map(({ term }) => term);
}

/**
 * `ranked` order with the curated head put back at position 0. Everything below
 * it keeps the ranked order it was given, so this is the narrowest possible
 * intervention: the ONE position the product converts into a claim is protected,
 * the tail — which nothing quotes — is still measured.
 *
 * Total: an empty `head` cannot be pinned (and cannot occur — a profile with no
 * titles has no head to flip, so it is refused upstream), and the result is a
 * permutation of `ranked` either way.
 */
function pinHead(head: string, ranked: readonly string[]): readonly string[] {
  const key = titlePrevalenceKey(head);
  if (key.length === 0) return ranked;
  return [head, ...ranked.filter((term) => titlePrevalenceKey(term) !== key)];
}

/**
 * The curated table with each profile's `titles` / `skills` reordered by mined
 * prevalence, PER AXIS. Pure, total, and exported so the guard rails above are
 * testable against fabricated snapshots rather than against the committed one,
 * whose contents change on every regeneration.
 *
 * A profile is returned BY REFERENCE, untouched, when NEITHER axis clears its
 * gate — the snapshot does not mention it, or it failed both. That is the
 * fallback and it is deliberately identity-preserving, so a caller can tell
 * "unranked" from "ranked to the same order" if it ever needs to. A profile that
 * clears one axis is rebuilt with the other axis's curated list copied across
 * unchanged.
 *
 * `ranked-head-pinned` counts as clearing the title axis: the tail is sorted by
 * prevalence and only position 0 is held at its curated term. See `pinHead`.
 */
export function applyPrevalenceOrder(
  curated: readonly RoleProfile[],
  snapshot: PrevalenceSnapshot,
): readonly RoleProfile[] {
  const profiles = snapshot?.profiles ?? {};
  return curated.map((profile) => {
    const audit = auditPrevalence(profile, profiles[profile.id]);
    const titlesRanked =
      audit.titles === "ranked" || audit.titles === "ranked-head-pinned";
    if (!titlesRanked && audit.skills !== "ranked") return profile;
    const mined = profiles[profile.id];
    const rankedTitles = titlesRanked
      ? rankByPrevalence(profile.titles, mined?.titles ?? [], titlePrevalenceKey)
      : profile.titles;
    return {
      ...profile,
      titles:
        audit.titles === "ranked-head-pinned"
          ? pinHead(profile.titles[0] ?? "", rankedTitles)
          : rankedTitles,
      skills:
        audit.skills === "ranked"
          ? rankByPrevalence(profile.skills, mined?.skills ?? [], normalizeSkillKey)
          : profile.skills,
    };
  });
}

/**
 * The table every consumer reads: curated membership, measured order. The one
 * exported table — see `CURATED_ROLE_PROFILES` for why there is not a second.
 */
export const ROLE_PROFILES: readonly RoleProfile[] = applyPrevalenceOrder(
  CURATED_ROLE_PROFILES,
  PREVALENCE_SNAPSHOT,
);

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

/**
 * The TITLE-MATCHING RULE (module docblock) as a public predicate: true when
 * `profileTitle`'s token set is a SUBSET of `resumeTitle`'s, both normalized by
 * `profileTitleTokens`. Note the asymmetry — the résumé side may carry extra
 * words, the profile side may not.
 *
 * Exported for consumers that need the per-TITLE answer rather than the
 * per-PROFILE one the resolvers give: `term-quality.ts` asks both "does this
 * résumé title match anything the resolved role is called?" and its inverse,
 * "does the résumé already cover this expected title?" — the same relation read
 * in both directions. Sharing this predicate is what keeps those answers from
 * drifting from the resolvers'. Total; never throws.
 */
export function profileTitleMatches(profileTitle: string, resumeTitle: string): boolean {
  return isSubset(profileTitleTokens(profileTitle), profileTitleTokens(resumeTitle));
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
