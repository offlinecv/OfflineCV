// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 The offlinecv Authors

/**
 * prevalence-snapshot.ts — GENERATED. Do not hand-edit the data body (#588).
 *
 * Baked frequency counts mined from real job postings, consumed by
 * `role-profiles.ts` to ORDER each profile's curated `titles` / `skills`.
 * Ordering only: an entry naming a term the curated table does not carry is
 * dropped by `applyPrevalenceOrder`, never added. Editing these numbers by hand
 * is how a snapshot rots — regenerate instead.
 *
 * NO RUNTIME FETCH. This is a static module in the bundle; nothing here or in
 * `role-profiles.ts` calls the network. The mining that produced it ran offline
 * in a dev harness seeded from the curated titles themselves — no résumé, no new
 * egress. See `mine-prevalence.test.ts`.
 *
 * ── WHOSE VOICE THIS IS ─────────────────────────────────────────────────────
 * THIS CORPUS IS NOT EVENLY SOURCED: "jobicy" alone supplied
 * 1002 of 1139 postings (88%), against arbeitnow 99, remotive 38.
 * These are keyless remote-jobs aggregators, which over-represent remote-first,
 * English-language and often smaller-company listings. Read a ranking as "what
 * these feeds said on this date", not as a market-wide measurement.
 *
 * COMPANY ATS BOARDS (greenhouse / lever / ashby) ARE EXCLUDED BY DESIGN, not
 * missing because they were down. Their pool is drawn from a *sector*
 * classification with no profile-level equivalent, their light index carries no
 * description at all (so the skill axis would be blind for every posting they
 * contributed), and several Lever registry slugs are known-wrong. A provider
 * absent from `providerMix` below is either one of those three or a feed that
 * genuinely failed; the run's JSON report records the failures.
 *
 * Regenerate with:
 *
 *   RL_MINE_PREVALENCE=1 npx vitest run src/lib/job-search/mine-prevalence.test.ts
 *
 * then copy `internal/job-search/prevalence-snapshot.generated.ts` over this
 * file and review the diff. Read each entry's `audit` first: it says whether
 * each AXIS was ranked or declined and why, and it names the modal observed
 * title — a modal title that is not the role is the tell that the bucket was
 * filled by a neighbour and that curated MEMBERSHIP, not ordering, needs work.
 *
 * generatedAt:  2026-07-26
 * corpusSize:   1139 deduped postings
 * providerMix:  remotive=38, arbeitnow=99, jobicy=1002
 */

import type { PrevalenceAudit } from "./role-profiles.ts";

/** One observed surface form (title) or canonical id (skill) with its count. */
export interface PrevalenceEntry {
  readonly form: string;
  readonly count: number;
}

/** What one profile's postings said, ranked count-desc. */
export interface ProfilePrevalence {
  /**
   * Postings that bucketed to this profile. This is the TITLE axis's evidence
   * and only the title axis's: a posting joins the corpus on its title, and a
   * posting whose description was a stub contributes to this number while
   * contributing nothing to `skills`. `audit.skillObservations` is the skill
   * axis's own denominator — see `MIN_PREVALENCE_SKILL_OBSERVATIONS`.
   */
  readonly sampleSize: number;
  readonly titles: readonly PrevalenceEntry[];
  /**
   * Curated skills observed at least once, count-desc. A curated skill missing
   * from this list scored zero, which is AMBIGUOUS: postings may genuinely never
   * ask for it, or jd-match's alias regex may be unable to see the phrasing they
   * asked for it with. The ranking cannot distinguish the two and treats both as
   * "unobserved", sinking the term to the tail of the curated order — never
   * dropping it, which is what keeps the ambiguity survivable.
   */
  readonly skills: readonly PrevalenceEntry[];
  /** Per-axis verdict + the measurements behind it, computed at bake time by
   *  the consumer's own `auditPrevalence`. Present for every mined profile. */
  readonly audit: PrevalenceAudit;
}

/** The whole baked corpus summary. */
export interface PrevalenceSnapshot {
  /** ISO date (YYYY-MM-DD) of the mining run. */
  readonly generatedAt: string;
  /** Deduped postings read across every feed. */
  readonly corpusSize: number;
  /** Provider id → postings contributed (first-seen wins under dedup). */
  readonly providerMix: Readonly<Record<string, number>>;
  readonly profiles: Readonly<Record<string, ProfilePrevalence>>;
  /**
   * Curated profile ids for which the corpus contained NO posting at all —
   * distinct from a profile that bucketed too few, which appears in `profiles`
   * with a declining `audit`. The distinction matters: a thin profile was
   * measured and declined, an unobserved one was never seen, and only the second
   * says the seeds or the feeds could not reach that role.
   */
  readonly unobservedProfiles: readonly string[];
}

export const PREVALENCE_SNAPSHOT: PrevalenceSnapshot = {
  generatedAt: "2026-07-26",
  corpusSize: 1139,
  providerMix: {"remotive":38,"arbeitnow":99,"jobicy":1002},
  profiles: {
    "account-executive": {
      sampleSize: 75,
      titles: [
        { form: "account executive", count: 25 },
        { form: "sales engineer", count: 16 },
        { form: "account manager", count: 11 },
        { form: "business development manager", count: 10 },
        { form: "solutions engineer", count: 7 },
        { form: "sales development representative", count: 7 },
      ],
      skills: [
        { form: "sql", count: 5 },
        { form: "executive-communication", count: 4 },
        { form: "cross-functional-collaboration", count: 1 },
      ],
      audit: { titles: "ranked", skills: "thin-observations", sampleSize: 75, modalTitle: "account executive", modalTitleShare: 0.329, curatedHeadTitleShare: 0.329, skillObservations: 10, skillHeadCount: 5 },
    },
    "support-engineer": {
      sampleSize: 66,
      titles: [
        { form: "customer success manager", count: 56 },
        { form: "customer support specialist", count: 6 },
        { form: "support engineer", count: 4 },
      ],
      skills: [
        { form: "stakeholder-management", count: 9 },
        { form: "linux", count: 7 },
        { form: "jira", count: 6 },
        { form: "cross-functional-collaboration", count: 2 },
        { form: "sql", count: 1 },
      ],
      audit: { titles: "bucket-not-this-role", skills: "thin-observations", sampleSize: 66, modalTitle: "customer success manager", modalTitleShare: 0.848, curatedHeadTitleShare: 0.061, skillObservations: 25, skillHeadCount: 9 },
    },
    "software-engineer": {
      sampleSize: 49,
      titles: [
        { form: "software engineer", count: 42 },
        { form: "software developer", count: 7 },
      ],
      skills: [
        { form: "python", count: 21 },
        { form: "rest", count: 18 },
        { form: "java", count: 16 },
        { form: "typescript", count: 15 },
        { form: "sql", count: 8 },
        { form: "docker", count: 6 },
        { form: "javascript", count: 5 },
        { form: "git", count: 5 },
      ],
      audit: { titles: "ranked", skills: "ranked", sampleSize: 49, modalTitle: "software engineer", modalTitleShare: 0.857, curatedHeadTitleShare: 0.857, skillObservations: 94, skillHeadCount: 21 },
    },
    "product-manager": {
      sampleSize: 38,
      titles: [
        { form: "product manager", count: 33 },
        { form: "senior product manager", count: 17 },
        { form: "technical product manager", count: 6 },
        { form: "product owner", count: 5 },
      ],
      skills: [
        { form: "product-management", count: 27 },
        { form: "agile", count: 8 },
        { form: "user-research", count: 6 },
        { form: "stakeholder-management", count: 6 },
        { form: "sql", count: 5 },
        { form: "jira", count: 1 },
        { form: "okrs", count: 1 },
      ],
      audit: { titles: "ranked", skills: "ranked", sampleSize: 38, modalTitle: "product manager", modalTitleShare: 0.541, curatedHeadTitleShare: 0.541, skillObservations: 54, skillHeadCount: 27 },
    },
    "engineering-manager": {
      sampleSize: 37,
      titles: [
        { form: "engineering manager", count: 32 },
        { form: "engineering lead", count: 5 },
        { form: "software engineering manager", count: 1 },
      ],
      skills: [
        { form: "career-development", count: 11 },
        { form: "people-management", count: 6 },
        { form: "project-delivery", count: 2 },
        { form: "team-building", count: 2 },
        { form: "stakeholder-management", count: 2 },
        { form: "performance-management", count: 1 },
      ],
      audit: { titles: "ranked", skills: "thin-observations", sampleSize: 37, modalTitle: "engineering manager", modalTitleShare: 0.842, curatedHeadTitleShare: 0.842, skillObservations: 24, skillHeadCount: 11 },
    },
    "machine-learning-engineer": {
      sampleSize: 37,
      titles: [
        { form: "ai engineer", count: 14 },
        { form: "machine learning engineer", count: 11 },
        { form: "data scientist", count: 8 },
        { form: "ml engineer", count: 3 },
        { form: "applied scientist", count: 2 },
        { form: "research scientist", count: 2 },
      ],
      skills: [
        { form: "machine-learning", count: 29 },
        { form: "python", count: 28 },
        { form: "pytorch", count: 13 },
        { form: "llm", count: 11 },
        { form: "tensorflow", count: 11 },
        { form: "deep-learning", count: 7 },
        { form: "scikit-learn", count: 5 },
        { form: "nlp", count: 5 },
        { form: "pandas", count: 2 },
        { form: "numpy", count: 1 },
      ],
      audit: { titles: "ranked-head-pinned", skills: "ranked", sampleSize: 37, modalTitle: "ai engineer", modalTitleShare: 0.35, curatedHeadTitleShare: 0.275, skillObservations: 112, skillHeadCount: 29 },
    },
    "site-reliability-engineer": {
      sampleSize: 34,
      titles: [
        { form: "site reliability engineer", count: 11 },
        { form: "cloud engineer", count: 10 },
        { form: "devops engineer", count: 9 },
        { form: "platform engineer", count: 7 },
      ],
      skills: [
        { form: "ci-cd", count: 22 },
        { form: "aws", count: 19 },
        { form: "kubernetes", count: 19 },
        { form: "linux", count: 17 },
        { form: "terraform", count: 15 },
        { form: "grafana", count: 11 },
        { form: "prometheus", count: 10 },
        { form: "bash", count: 8 },
        { form: "docker", count: 7 },
        { form: "ansible", count: 4 },
      ],
      audit: { titles: "ranked", skills: "ranked", sampleSize: 34, modalTitle: "site reliability engineer", modalTitleShare: 0.297, curatedHeadTitleShare: 0.297, skillObservations: 132, skillHeadCount: 22 },
    },
    "technical-program-manager": {
      sampleSize: 27,
      titles: [
        { form: "project manager", count: 15 },
        { form: "program manager", count: 12 },
        { form: "technical program manager", count: 4 },
        { form: "senior technical program manager", count: 1 },
      ],
      skills: [
        { form: "program-management", count: 7 },
        { form: "stakeholder-management", count: 6 },
        { form: "project-delivery", count: 4 },
        { form: "cross-functional-collaboration", count: 4 },
        { form: "incident-management", count: 1 },
        { form: "jira", count: 1 },
      ],
      audit: { titles: "bucket-not-this-role", skills: "thin-observations", sampleSize: 27, modalTitle: "project manager", modalTitleShare: 0.469, curatedHeadTitleShare: 0.125, skillObservations: 23, skillHeadCount: 7 },
    },
    "marketing-manager": {
      sampleSize: 25,
      titles: [
        { form: "marketing manager", count: 25 },
        { form: "content marketing manager", count: 4 },
        { form: "product marketing manager", count: 2 },
        { form: "growth marketing manager", count: 1 },
      ],
      skills: [
        { form: "cross-functional-collaboration", count: 5 },
        { form: "a-b-testing", count: 2 },
      ],
      audit: { titles: "ranked", skills: "thin-observations", sampleSize: 25, modalTitle: "marketing manager", modalTitleShare: 0.781, curatedHeadTitleShare: 0.781, skillObservations: 7, skillHeadCount: 5 },
    },
    "data-engineer": {
      sampleSize: 20,
      titles: [
        { form: "data engineer", count: 11 },
        { form: "data analyst", count: 9 },
        { form: "data platform engineer", count: 4 },
      ],
      skills: [
        { form: "sql", count: 13 },
        { form: "python", count: 12 },
        { form: "airflow", count: 7 },
        { form: "etl", count: 5 },
        { form: "dbt", count: 5 },
        { form: "spark", count: 4 },
        { form: "snowflake", count: 4 },
        { form: "bigquery", count: 4 },
        { form: "data-warehouse", count: 3 },
        { form: "tableau", count: 3 },
      ],
      audit: { titles: "thin-sample", skills: "ranked", sampleSize: 20, modalTitle: "data engineer", modalTitleShare: 0.458, curatedHeadTitleShare: 0.458, skillObservations: 60, skillHeadCount: 13 },
    },
    "security-engineer": {
      sampleSize: 15,
      titles: [
        { form: "security engineer", count: 14 },
        { form: "application security engineer", count: 3 },
        { form: "security architect", count: 1 },
      ],
      skills: [
        { form: "python", count: 12 },
        { form: "aws", count: 8 },
        { form: "linux", count: 4 },
        { form: "saml", count: 3 },
        { form: "soc2", count: 3 },
        { form: "hipaa", count: 2 },
        { form: "oauth", count: 1 },
        { form: "sso", count: 1 },
        { form: "gdpr", count: 1 },
      ],
      audit: { titles: "thin-sample", skills: "thin-observations", sampleSize: 15, modalTitle: "security engineer", modalTitleShare: 0.778, curatedHeadTitleShare: 0.778, skillObservations: 35, skillHeadCount: 12 },
    },
    "fullstack-engineer": {
      sampleSize: 11,
      titles: [
        { form: "fullstack engineer", count: 11 },
        { form: "fullstack software engineer", count: 3 },
      ],
      skills: [
        { form: "react", count: 9 },
        { form: "rest", count: 6 },
        { form: "postgresql", count: 5 },
        { form: "typescript", count: 5 },
        { form: "node.js", count: 5 },
        { form: "aws", count: 5 },
        { form: "javascript", count: 3 },
        { form: "docker", count: 2 },
        { form: "next.js", count: 2 },
        { form: "graphql", count: 2 },
      ],
      audit: { titles: "thin-sample", skills: "thin-observations", sampleSize: 11, modalTitle: "fullstack engineer", modalTitleShare: 0.786, curatedHeadTitleShare: 0.786, skillObservations: 44, skillHeadCount: 9 },
    },
    "qa-engineer": {
      sampleSize: 10,
      titles: [
        { form: "automation engineer", count: 5 },
        { form: "qa engineer", count: 4 },
        { form: "quality engineer", count: 3 },
        { form: "quality assurance engineer", count: 1 },
        { form: "test engineer", count: 1 },
      ],
      skills: [
        { form: "ci-cd", count: 4 },
        { form: "python", count: 4 },
        { form: "cypress", count: 2 },
        { form: "selenium", count: 1 },
      ],
      audit: { titles: "thin-sample", skills: "thin-observations", sampleSize: 10, modalTitle: "automation engineer", modalTitleShare: 0.357, curatedHeadTitleShare: 0.286, skillObservations: 11, skillHeadCount: 4 },
    },
    "backend-engineer": {
      sampleSize: 8,
      titles: [
        { form: "backend engineer", count: 7 },
        { form: "backend developer", count: 1 },
      ],
      skills: [
        { form: "docker", count: 4 },
        { form: "rest", count: 4 },
        { form: "go", count: 3 },
        { form: "postgresql", count: 2 },
        { form: "grpc", count: 2 },
        { form: "python", count: 2 },
        { form: "kafka", count: 1 },
        { form: "java", count: 1 },
      ],
      audit: { titles: "thin-sample", skills: "thin-observations", sampleSize: 8, modalTitle: "backend engineer", modalTitleShare: 0.875, curatedHeadTitleShare: 0.875, skillObservations: 19, skillHeadCount: 4 },
    },
    "frontend-engineer": {
      sampleSize: 7,
      titles: [
        { form: "frontend engineer", count: 6 },
        { form: "react developer", count: 1 },
      ],
      skills: [
        { form: "react", count: 6 },
        { form: "typescript", count: 5 },
        { form: "css", count: 4 },
        { form: "javascript", count: 4 },
        { form: "tailwind", count: 1 },
        { form: "html", count: 1 },
        { form: "jest", count: 1 },
        { form: "next.js", count: 1 },
      ],
      audit: { titles: "thin-sample", skills: "thin-observations", sampleSize: 7, modalTitle: "frontend engineer", modalTitleShare: 0.857, curatedHeadTitleShare: 0.857, skillObservations: 23, skillHeadCount: 6 },
    },
    "mobile-engineer": {
      sampleSize: 7,
      titles: [
        { form: "android engineer", count: 3 },
        { form: "mobile engineer", count: 1 },
        { form: "ios developer", count: 1 },
        { form: "android developer", count: 1 },
        { form: "ios engineer", count: 1 },
      ],
      skills: [
        { form: "android", count: 5 },
        { form: "ios", count: 4 },
        { form: "kotlin", count: 4 },
        { form: "swift", count: 3 },
        { form: "xcode", count: 2 },
        { form: "react-native", count: 1 },
        { form: "java", count: 1 },
      ],
      audit: { titles: "thin-sample", skills: "thin-observations", sampleSize: 7, modalTitle: "android engineer", modalTitleShare: 0.429, curatedHeadTitleShare: 0.143, skillObservations: 20, skillHeadCount: 5 },
    },
    "product-designer": {
      sampleSize: 7,
      titles: [
        { form: "product designer", count: 7 },
      ],
      skills: [
        { form: "product-management", count: 3 },
        { form: "figma", count: 2 },
        { form: "user-research", count: 1 },
        { form: "html", count: 1 },
        { form: "css", count: 1 },
      ],
      audit: { titles: "thin-sample", skills: "thin-observations", sampleSize: 7, modalTitle: "product designer", modalTitleShare: 1, curatedHeadTitleShare: 1, skillObservations: 8, skillHeadCount: 3 },
    },
    "senior-engineering-manager": {
      sampleSize: 4,
      titles: [
        { form: "senior engineering manager", count: 4 },
      ],
      skills: [
        { form: "cross-functional-collaboration", count: 1 },
        { form: "people-management", count: 1 },
        { form: "career-development", count: 1 },
      ],
      audit: { titles: "thin-sample", skills: "thin-observations", sampleSize: 4, modalTitle: "senior engineering manager", modalTitleShare: 1, curatedHeadTitleShare: 1, skillObservations: 3, skillHeadCount: 1 },
    },
    "director-of-engineering": {
      sampleSize: 3,
      titles: [
        { form: "director of engineering", count: 3 },
        { form: "engineering director", count: 3 },
        { form: "director of software engineering", count: 1 },
      ],
      skills: [
        { form: "executive-communication", count: 1 },
        { form: "performance-management", count: 1 },
      ],
      audit: { titles: "thin-sample", skills: "thin-observations", sampleSize: 3, modalTitle: "director of engineering", modalTitleShare: 0.857, curatedHeadTitleShare: 0.857, skillObservations: 2, skillHeadCount: 1 },
    },
    "founder-ceo": {
      sampleSize: 2,
      titles: [
        { form: "ceo", count: 2 },
        { form: "chief executive officer", count: 2 },
      ],
      skills: [
        { form: "stakeholder-management", count: 1 },
        { form: "executive-communication", count: 1 },
      ],
      audit: { titles: "thin-sample", skills: "thin-observations", sampleSize: 2, modalTitle: "ceo", modalTitleShare: 1, curatedHeadTitleShare: 0, skillObservations: 2, skillHeadCount: 1 },
    },
    "cto": {
      sampleSize: 1,
      titles: [
        { form: "cto", count: 1 },
        { form: "chief technology officer", count: 1 },
        { form: "chief technical officer", count: 1 },
      ],
      skills: [
      ],
      audit: { titles: "thin-sample", skills: "thin-observations", sampleSize: 1, modalTitle: "cto", modalTitleShare: 1, curatedHeadTitleShare: 1, skillObservations: 0, skillHeadCount: 0 },
    },
    "site-lead": {
      sampleSize: 1,
      titles: [
        { form: "site director", count: 1 },
      ],
      skills: [
      ],
      audit: { titles: "thin-sample", skills: "thin-observations", sampleSize: 1, modalTitle: "site director", modalTitleShare: 1, curatedHeadTitleShare: 0, skillObservations: 0, skillHeadCount: 0 },
    },
    "vp-engineering": {
      sampleSize: 1,
      titles: [
        { form: "vp of engineering", count: 1 },
        { form: "vp engineering", count: 1 },
        { form: "vice president of engineering", count: 1 },
      ],
      skills: [
        { form: "stakeholder-management", count: 1 },
      ],
      audit: { titles: "thin-sample", skills: "thin-observations", sampleSize: 1, modalTitle: "vp of engineering", modalTitleShare: 1, curatedHeadTitleShare: 1, skillObservations: 1, skillHeadCount: 1 },
    },
  },
  unobservedProfiles: ["head-of-engineering"],
};
